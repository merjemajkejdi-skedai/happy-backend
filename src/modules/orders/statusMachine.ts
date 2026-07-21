import type { OrderItemStatus, OrderStatus } from '../../generated/prisma/client';

export type ExplicitOrderFlag = 'closed' | 'cancelled' | null | undefined;

// The single place order_status is decided — every mutation that can change
// item state (add, update, void, send, serve, close, cancel) recomputes and
// persists through this, never assigns a status by hand elsewhere.
//
// Cancelled items are excluded from the derivation entirely: a fully-voided
// order behaves the same as an empty one for status purposes, right up until
// something explicitly closes or cancels the order itself.
export function deriveOrderStatus(items: { status: OrderItemStatus }[], explicitFlag?: ExplicitOrderFlag): OrderStatus {
  if (explicitFlag === 'closed') return 'closed';
  if (explicitFlag === 'cancelled') return 'cancelled';

  const active = items.filter(i => i.status !== 'cancelled');
  if (active.length === 0) return 'draft';
  if (active.every(i => i.status === 'pending')) return 'open';
  if (active.every(i => i.status === 'served')) return 'served';
  if (active.some(i => i.status === 'served')) return 'partially_served';
  // Everything left is some mix of pending/sent/preparing/ready, with at
  // least one item past 'pending' (otherwise the 'open' branch above would
  // already have matched) and nothing served yet.
  return 'sent';
}
