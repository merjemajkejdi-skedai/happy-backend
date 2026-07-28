import type { CourseStatus, OrderItemStatus, OrderStatus } from '../../generated/prisma/client';

export type ExplicitOrderFlag = 'closed' | 'cancelled' | 'merged' | null | undefined;

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
  if (explicitFlag === 'merged') return 'merged';

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

// Phase 2, session 2c — course_status roll-up. A course only progresses past
// 'pending' once explicitly fired (fireCourse sets 'fired' directly, outside
// this function); this function only rolls a *fired* course forward toward
// preparing/ready/served as its items progress, and never invents a status
// on a course nobody has fired yet.
export function deriveCourseStatus(currentStatus: CourseStatus, activeItems: { status: OrderItemStatus }[]): CourseStatus {
  if (currentStatus === 'pending') return 'pending';
  if (activeItems.length === 0) return currentStatus; // fired but empty — stays 'fired' (or wherever it was)
  if (activeItems.every(i => i.status === 'served')) return 'served';
  if (activeItems.every(i => i.status === 'ready' || i.status === 'served')) return 'ready';
  if (activeItems.some(i => i.status === 'preparing' || i.status === 'ready' || i.status === 'served')) return 'preparing';
  return currentStatus; // still just 'sent' items, nothing prepared yet — stays 'fired'
}

// course_names is stored as a JSON array (default '["Starters","Mains","Desserts"]'),
// 1-indexed by course_number against a 0-indexed array. Falls back to a
// generic label rather than throwing if the array is short or malformed —
// firing course 4 on a venue that only named 3 courses is a config gap, not
// a reason to fail the fire.
export function courseNameFromSettings(courseNames: unknown, courseNumber: number): string {
  if (Array.isArray(courseNames) && typeof courseNames[courseNumber - 1] === 'string') {
    return courseNames[courseNumber - 1] as string;
  }
  return `Course ${courseNumber}`;
}
