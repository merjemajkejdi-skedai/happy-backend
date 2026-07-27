import type { OrderItemStatus, RestaurantSettings, UserRole, VoidStage } from '../../generated/prisma/client';
import { roleHasPermission } from '../../shared/permissions';

export interface VoidPolicy {
  stage: VoidStage;
  requiresApproval: boolean;
  autoApprove: boolean;
}

// Only manager/admin ever hold void.approve (see src/shared/permissions.ts),
// so "actor's role satisfies settings.void_approval_role" reduces to a
// two-level seniority check between those two. A voidApprovalRole value
// outside this table (nothing in schema stops one being set) is treated as
// unreachable by anyone, matching "A manager never queues for themselves"
// for the common case (voidApprovalRole='manager') while still requiring
// admin specifically when voidApprovalRole='admin'.
const APPROVAL_ROLE_RANK: Partial<Record<UserRole, number>> = { manager: 1, admin: 2 };

function roleSatisfiesApprovalRequirement(actorRole: UserRole, requiredRole: UserRole): boolean {
  if (!roleHasPermission(actorRole, 'void.approve')) return false;
  const actorRank = APPROVAL_ROLE_RANK[actorRole] ?? 0;
  const requiredRank = APPROVAL_ROLE_RANK[requiredRole] ?? Infinity;
  return actorRank >= requiredRank;
}

// The one pure decision function for the whole void flow (session 2d-i,
// section 1). Everything else (writing restaurant_void_log, cancelling the
// item, queuing an approval_requests row) is a mechanical consequence of
// what this returns.
export function resolveVoidPolicy(
  item: { status: OrderItemStatus },
  actorRole: UserRole,
  settings: Pick<RestaurantSettings, 'voidBeforeSendRequiresApproval' | 'voidRequiresApproval' | 'voidApprovalRole'>,
): VoidPolicy {
  const stage: VoidStage = item.status === 'pending' ? 'before_send' : 'after_send';
  const requiresApproval = stage === 'before_send' ? settings.voidBeforeSendRequiresApproval : settings.voidRequiresApproval;
  const autoApprove = roleSatisfiesApprovalRequirement(actorRole, settings.voidApprovalRole);
  return { stage, requiresApproval, autoApprove };
}
