import bcrypt from 'bcrypt';
import { scopedPrisma } from '../../middleware/venueScope';
import { pinLookup } from '../../shared/pin';
import { Prisma, type User, type UserRole } from '../../generated/prisma/client';
import { err, type DomainError } from '../../lib/domainError';

// All five roles are assignable as of session 2a-ii — the Phase 1
// ALLOWED_ROLES restriction (and ROLE_NOT_AVAILABLE_IN_PHASE_1) is removed.
const ALL_ROLES: UserRole[] = ['waiter', 'kitchen', 'admin', 'manager', 'bar'];
// A manager may only create/edit accounts with these roles — enforced here
// in the service layer (not just middleware), per docs/phase2/2a-ii.md
// section 5, so it applies uniformly regardless of which route reaches
// createUser/updateUser.
const MANAGER_ASSIGNABLE_ROLES: UserRole[] = ['waiter', 'kitchen', 'bar'];
const BCRYPT_COST = 10;

export type UserDomainError = DomainError;

export type UserResult<T> = { ok: true; value: T } | { ok: false; error: UserDomainError };

function validateRole(role: string): UserDomainError | null {
  if (!ALL_ROLES.includes(role as UserRole)) {
    return err(422, 'VALIDATION_ERROR', `role must be one of: ${ALL_ROLES.join(', ')}`);
  }
  return null;
}

// Rule 5: a manager may create/edit waiter, kitchen, or bar accounts only —
// never another manager, and never an admin. Checked against whichever role
// is actually in play (the target's current role, and/or the role being
// assigned), independent of which of those is being validated at the time.
export function checkManagerAuthority(actorRole: UserRole, targetRole: UserRole): UserDomainError | null {
  if (actorRole === 'manager' && !MANAGER_ASSIGNABLE_ROLES.includes(targetRole)) {
    return err(403, 'INSUFFICIENT_ROLE_AUTHORITY', 'Managers may only manage waiter, kitchen, or bar accounts');
  }
  return null;
}

export function assignableRoles(actorRole: UserRole): UserRole[] {
  return actorRole === 'manager' ? MANAGER_ASSIGNABLE_ROLES : ALL_ROLES;
}

function validateCredentials(hasEmail: boolean, hasPassword: boolean, hasPin: boolean): UserDomainError | null {
  if ((hasEmail && hasPassword) || hasPin) return null;
  return err(422, 'CREDENTIALS_REQUIRED', 'Provide either email+password or a pin');
}

function isPinConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

// ── List / read ──────────────────────────────────────────────────────────────

export interface ListUsersParams {
  role?: string;
  isActive?: boolean;
  page?: number;
  perPage?: number;
}

export async function listUsers(venueId: string, params: ListUsersParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 50));
  const where: Prisma.UserWhereInput = { venueId, deletedAt: null };
  if (params.role) where.role = params.role as UserRole;
  if (params.isActive !== undefined) where.isActive = params.isActive;

  const [users, total] = await Promise.all([
    scopedPrisma.user.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (page - 1) * perPage, take: perPage }),
    scopedPrisma.user.count({ where }),
  ]);

  return { users, page, perPage, total };
}

export async function getUser(venueId: string, userId: string): Promise<User | null> {
  return scopedPrisma.user.findFirst({ where: { id: userId, venueId, deletedAt: null } });
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateUserInput {
  fullName: string;
  role: string;
  email?: string | null;
  password?: string;
  pin?: string;
}

export async function createUser(venueId: string, actorRole: UserRole, input: CreateUserInput): Promise<UserResult<User>> {
  const roleError = validateRole(input.role);
  if (roleError) return { ok: false, error: roleError };

  const authorityError = checkManagerAuthority(actorRole, input.role as UserRole);
  if (authorityError) return { ok: false, error: authorityError };

  const credError = validateCredentials(!!input.email, !!input.password, !!input.pin);
  if (credError) return { ok: false, error: credError };

  if (input.email) {
    const existing = await scopedPrisma.user.findFirst({ where: { venueId, email: input.email, deletedAt: null } });
    if (existing) return { ok: false, error: err(409, 'EMAIL_ALREADY_IN_USE', 'That email is already in use at this venue') };
  }
  if (input.pin) {
    const existing = await scopedPrisma.user.findFirst({ where: { venueId, pinLookup: pinLookup(input.pin), deletedAt: null } });
    if (existing) return { ok: false, error: err(409, 'PIN_ALREADY_IN_USE', 'That PIN is already in use at this venue') };
  }

  try {
    const user = await scopedPrisma.user.create({
      data: {
        venueId,
        role: input.role as UserRole,
        fullName: input.fullName,
        email: input.email ?? null,
        passwordHash: input.password ? await bcrypt.hash(input.password, BCRYPT_COST) : null,
        pinHash: input.pin ? await bcrypt.hash(input.pin, BCRYPT_COST) : null,
        pinLookup: input.pin ? pinLookup(input.pin) : null,
      },
    });
    return { ok: true, value: user };
  } catch (e) {
    // Backstop for the race between the pre-check above and the insert —
    // the pre-check makes the common case precise, this just guarantees
    // correctness under concurrent requests.
    if (isPinConflict(e)) return { ok: false, error: err(409, 'DUPLICATE_CREDENTIAL', 'That email or PIN is already in use at this venue') };
    throw e;
  }
}

// ── Update ───────────────────────────────────────────────────────────────────

export interface UpdateUserInput {
  fullName?: string;
  role?: string;
  isActive?: boolean;
  email?: string | null;
}

export async function updateUser(
  venueId: string,
  actorUserId: string,
  actorRole: UserRole,
  userId: string,
  input: UpdateUserInput,
): Promise<UserResult<User>> {
  const user = await scopedPrisma.user.findFirst({ where: { id: userId, venueId, deletedAt: null } });
  if (!user) return { ok: false, error: err(404, 'NOT_FOUND', 'User not found') };

  // A manager can't touch an existing manager/admin account at all, and
  // can't promote a target INTO manager/admin either — check both the
  // subject's current role and (if changing) the role being assigned.
  const currentRoleAuthorityError = checkManagerAuthority(actorRole, user.role);
  if (currentRoleAuthorityError) return { ok: false, error: currentRoleAuthorityError };

  if (input.role !== undefined) {
    const roleError = validateRole(input.role);
    if (roleError) return { ok: false, error: roleError };

    const newRoleAuthorityError = checkManagerAuthority(actorRole, input.role as UserRole);
    if (newRoleAuthorityError) return { ok: false, error: newRoleAuthorityError };
  }

  if (input.isActive === false && userId === actorUserId) {
    return { ok: false, error: err(422, 'CANNOT_MODIFY_SELF', 'An admin cannot deactivate their own account') };
  }

  const mergedEmail = input.email !== undefined ? input.email : user.email;
  if (!((mergedEmail && user.passwordHash) || user.pinHash)) {
    return { ok: false, error: err(422, 'CREDENTIALS_REQUIRED', 'User must keep either email+password or a pin') };
  }

  if (input.email) {
    const existing = await scopedPrisma.user.findFirst({
      where: { venueId, email: input.email, deletedAt: null, id: { not: userId } },
    });
    if (existing) return { ok: false, error: err(409, 'EMAIL_ALREADY_IN_USE', 'That email is already in use at this venue') };
  }

  const data: Prisma.UserUpdateInput = {};
  if (input.fullName !== undefined) data.fullName = input.fullName;
  if (input.role !== undefined) data.role = input.role as UserRole;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.email !== undefined) data.email = input.email;

  const updated = await scopedPrisma.user.update({ where: { id: userId }, data });
  return { ok: true, value: updated };
}

// ── Delete ───────────────────────────────────────────────────────────────────

export async function softDeleteUser(venueId: string, actorUserId: string, userId: string): Promise<UserResult<null>> {
  if (userId === actorUserId) {
    return { ok: false, error: err(422, 'CANNOT_MODIFY_SELF', 'An admin cannot delete their own account') };
  }
  const user = await scopedPrisma.user.findFirst({ where: { id: userId, venueId, deletedAt: null } });
  if (!user) return { ok: false, error: err(404, 'NOT_FOUND', 'User not found') };

  // email/pin_lookup back partial-unique indexes that don't exclude deleted
  // rows (WHERE email/pin_lookup IS NOT NULL only) — clearing them here is
  // what actually frees the identifier for reuse by a future hire.
  await scopedPrisma.user.update({
    where: { id: userId },
    data: { deletedAt: new Date(), isActive: false, email: null, pinLookup: null },
  });
  return { ok: true, value: null };
}

// ── Reset PIN / password ─────────────────────────────────────────────────────

export async function resetPin(venueId: string, userId: string, pin: string): Promise<UserResult<User>> {
  const user = await scopedPrisma.user.findFirst({ where: { id: userId, venueId, deletedAt: null } });
  if (!user) return { ok: false, error: err(404, 'NOT_FOUND', 'User not found') };

  const lookup = pinLookup(pin);
  const existing = await scopedPrisma.user.findFirst({
    where: { venueId, pinLookup: lookup, deletedAt: null, id: { not: userId } },
  });
  if (existing) return { ok: false, error: err(409, 'PIN_ALREADY_IN_USE', 'That PIN is already in use at this venue') };

  try {
    const updated = await scopedPrisma.user.update({
      where: { id: userId },
      data: { pinHash: await bcrypt.hash(pin, BCRYPT_COST), pinLookup: lookup },
    });
    return { ok: true, value: updated };
  } catch (e) {
    if (isPinConflict(e)) return { ok: false, error: err(409, 'PIN_ALREADY_IN_USE', 'That PIN is already in use at this venue') };
    throw e;
  }
}

export async function resetPassword(venueId: string, userId: string, password: string): Promise<UserResult<User>> {
  const user = await scopedPrisma.user.findFirst({ where: { id: userId, venueId, deletedAt: null } });
  if (!user) return { ok: false, error: err(404, 'NOT_FOUND', 'User not found') };
  if (!user.email) {
    return { ok: false, error: err(422, 'EMAIL_REQUIRED_FOR_PASSWORD', 'User has no email on file — cannot set a password') };
  }

  const updated = await scopedPrisma.user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(password, BCRYPT_COST) },
  });
  return { ok: true, value: updated };
}
