import type { User } from '../generated/prisma/client';

// Never return password_hash, pin_hash, or pin_lookup in any response — this
// is the one place that strips them, used by every route that returns a user.
export function serializeUser(user: User) {
  const { passwordHash, pinHash, pinLookup, ...safe } = user;
  void passwordHash;
  void pinHash;
  void pinLookup;
  return safe;
}
