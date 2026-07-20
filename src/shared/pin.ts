import crypto from 'crypto';
import { pinPepper } from './config';

// Deterministic HMAC of a PIN — lets us look a candidate user row up by PIN
// in O(1) without scanning every user in a venue. The real security boundary
// is still bcrypt(pin, pin_hash), checked separately after this lookup finds
// a candidate; pin_lookup on its own is not a secret-equivalent value in the
// way pin_hash is, but it must never be computed from anything other than
// PIN_PEPPER + the raw PIN, and never logged or returned to a client.
//
// The DB enforces PIN uniqueness per venue via a partial unique index on
// (venue_id, pin_lookup) — see docs/SCHEMA.md — so this same function must be
// used for every PIN a user is ever assigned, at login time and at
// create/update time alike, or the uniqueness guarantee silently stops meaning
// anything.
export function pinLookup(pin: string): string {
  return crypto.createHmac('sha256', pinPepper()).update(pin).digest('hex');
}
