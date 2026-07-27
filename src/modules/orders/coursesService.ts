import { scopedPrisma } from '../../middleware/venueScope';
import { err, getVenueAndSettings, type OrderDomainError, type Tx } from './validation';
import { validateCourseNumber } from '../menu/validation';
import { courseNameFromSettings } from './statusMachine';
import { recomputeOrder } from './ordersService';
import { sendItemsCore } from './lifecycleService';
import type { OrderCourse, RestaurantSettings } from '../../generated/prisma/client';

export type CoursesResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

// Every route in this module shares this gate. Venue type is checked before
// the setting so a happy_bar caller always gets the venue-type message, even
// if send_by_course also happens to be false there — per 2c.md: "Check the
// venue type BEFORE the setting so the error is accurate."
// Exported for the displays module's GET /displays/kitchen/fire-alerts,
// which shares this exact gate.
export async function checkCoursesAvailable(venueId: string): Promise<CoursesResult<{ settings: RestaurantSettings }>> {
  const { venue, settings } = await getVenueAndSettings(venueId);
  if (venue.venueType === 'happy_bar') {
    return { ok: false, error: err(403, 'COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE', 'Course firing is not available for a happy_bar venue') };
  }
  if (!settings.sendByCourse) {
    return { ok: false, error: err(403, 'COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE', 'Course firing is not enabled for this venue') };
  }
  return { ok: true, value: { settings } };
}

async function ensureCourseRow(tx: Tx, venueId: string, orderId: string, courseNumber: number, settings: RestaurantSettings): Promise<OrderCourse> {
  const existing = await tx.orderCourse.findUnique({ where: { orderId_courseNumber: { orderId, courseNumber } } });
  if (existing) return existing;
  return tx.orderCourse.create({
    data: { venueId, orderId, courseNumber, courseNameSnapshot: courseNameFromSettings(settings.courseNames, courseNumber) },
  });
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function listCourses(venueId: string, orderId: string): Promise<CoursesResult<OrderCourse[]>> {
  const gate = await checkCoursesAvailable(venueId);
  if (!gate.ok) return gate;

  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const courses = await scopedPrisma.orderCourse.findMany({ where: { orderId, venueId }, orderBy: { courseNumber: 'asc' } });
  return { ok: true, value: courses };
}

// ── Fire ─────────────────────────────────────────────────────────────────────

export async function fireCourse(
  venueId: string,
  actorUserId: string,
  orderId: string,
  courseNumber: number,
): Promise<CoursesResult<OrderCourse>> {
  if (!Number.isInteger(courseNumber) || courseNumber < 1) {
    return { ok: false, error: err(422, 'VALIDATION_ERROR', 'course number must be a positive integer') };
  }

  const gate = await checkCoursesAvailable(venueId);
  if (!gate.ok) return gate;
  const { settings } = gate.value;

  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  if (settings.courseFireRequiresPreviousServed && courseNumber > 1) {
    const previous = await scopedPrisma.orderCourse.findUnique({
      where: { orderId_courseNumber: { orderId, courseNumber: courseNumber - 1 } },
    });
    // No row for the previous course means nothing was ever assigned to
    // it — vacuously "served" (there's nothing to wait on).
    if (previous && !previous.allServedAt) {
      return {
        ok: false,
        error: err(409, 'PREVIOUS_COURSE_NOT_SERVED', `Course ${courseNumber - 1} must be fully served before firing course ${courseNumber}`),
      };
    }
  }

  const updated = await scopedPrisma.$transaction(async tx => {
    const course = await ensureCourseRow(tx, venueId, orderId, courseNumber, settings);
    // Re-firing an already-fired course is a no-op success — idempotent,
    // not specified either way by the spec, but safer than double-writing
    // fired_at/fired_by and re-emitting a course.fired event.
    if (course.firedAt) return course;

    const now = new Date();
    const pendingItems = await tx.orderItem.findMany({ where: { orderId, venueId, courseNumber, status: 'pending' } });
    if (pendingItems.length > 0) {
      // Handles pending->sent/served transitions, per-item events, order
      // recompute (which rolls this course's item_count/status forward too),
      // and order.first_sent_at on the very first ever send — do not
      // reimplement any of that here.
      await sendItemsCore(tx, venueId, orderId, actorUserId, pendingItems.map(i => i.id));
      await tx.orderItem.updateMany({ where: { id: { in: pendingItems.map(i => i.id) }, venueId }, data: { courseFiredAt: now } });
    } else {
      // Empty course: no items to transition, but still recompute so the
      // course row's own bookkeeping (item_count staying 0) is current.
      await recomputeOrder(tx, venueId, orderId);
    }

    const firedCourse = await tx.orderCourse.update({
      where: { id: course.id },
      data: { status: 'fired', firedAt: now, firedByUserId: actorUserId },
    });

    const currentOrder = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    await tx.order.update({
      where: { id: orderId },
      data: { currentCourseFired: Math.max(currentOrder.currentCourseFired ?? 0, courseNumber) },
    });

    await tx.orderEvent.create({
      data: {
        venueId,
        orderId,
        eventType: 'course.fired',
        actorUserId,
        payload: { courseNumber, itemIds: pendingItems.map(i => i.id) },
      },
    });

    return firedCourse;
  });

  return { ok: true, value: updated };
}

// ── Hold ─────────────────────────────────────────────────────────────────────

// "Only if nothing started" — CourseStatus has no distinct 'held' value, so
// hold is interpreted as un-firing: reverting a course from 'fired' back to
// 'pending' (its 'sent' items back to 'pending'), allowed only while nothing
// in the course has been picked up by kitchen/bar yet (no item past 'sent').
export async function holdCourse(
  venueId: string,
  actorUserId: string,
  orderId: string,
  courseNumber: number,
): Promise<CoursesResult<OrderCourse>> {
  const gate = await checkCoursesAvailable(venueId);
  if (!gate.ok) return gate;
  const { settings } = gate.value;

  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const course = await scopedPrisma.$transaction(tx => ensureCourseRow(tx, venueId, orderId, courseNumber, settings));
  if (course.status === 'pending') {
    // Nothing to hold — already in the held (never-fired) state. Same no-op
    // convention as re-firing an already-fired course.
    return { ok: true, value: course };
  }

  const items = await scopedPrisma.orderItem.findMany({ where: { orderId, venueId, courseNumber, status: { not: 'cancelled' } } });
  const started = items.some(i => i.status === 'preparing' || i.status === 'ready' || i.status === 'served');
  if (started) {
    return { ok: false, error: err(409, 'COURSE_ALREADY_STARTED', `Course ${courseNumber} has already started and can no longer be held`) };
  }

  const updated = await scopedPrisma.$transaction(async tx => {
    const sentItems = items.filter(i => i.status === 'sent');
    for (const item of sentItems) {
      await tx.orderItem.update({ where: { id: item.id }, data: { status: 'pending', sentAt: null, courseFiredAt: null } });
      await tx.orderEvent.create({
        data: { venueId, orderId, orderItemId: item.id, eventType: 'item.status_changed', actorUserId, payload: { from: 'sent', to: 'pending' } },
      });
    }

    const heldCourse = await tx.orderCourse.update({
      where: { id: course.id },
      data: { status: 'pending', firedAt: null, firedByUserId: null },
    });

    await recomputeOrder(tx, venueId, orderId);

    await tx.orderEvent.create({
      data: { venueId, orderId, eventType: 'course.held', actorUserId, payload: { courseNumber, itemIds: sentItems.map(i => i.id) } },
    });

    return heldCourse;
  });

  return { ok: true, value: updated };
}

// ── Reorder ──────────────────────────────────────────────────────────────────

// Best-effort interpretation — the spec gives no payload example for this
// route (unlike the fire-alert JSON, which is fully specified) and it's
// untested by 2c.md's own test list. Accepts a full permutation of this
// order's existing course numbers in their new desired sequence; position in
// the array becomes the new course_number (1-indexed), applied to both the
// order_courses rows and every item currently carrying the old number.
// Flagged explicitly in the handoff as low-confidence — revisit if the real
// intended shape turns out to differ.
export async function reorderCourses(venueId: string, actorUserId: string, orderId: string, courseNumbers: number[]): Promise<CoursesResult<OrderCourse[]>> {
  const gate = await checkCoursesAvailable(venueId);
  if (!gate.ok) return gate;

  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const existing = await scopedPrisma.orderCourse.findMany({ where: { orderId, venueId } });
  const existingNumbers = new Set(existing.map(c => c.courseNumber));
  const uniqueRequested = new Set(courseNumbers);
  if (uniqueRequested.size !== courseNumbers.length || courseNumbers.length !== existingNumbers.size || [...uniqueRequested].some(n => !existingNumbers.has(n))) {
    return { ok: false, error: err(422, 'VALIDATION_ERROR', 'course_numbers must be a permutation of this order\'s existing course numbers') };
  }

  // Two-phase renumber (old -> temporary negative, then temporary -> new) to
  // avoid colliding with the (order_id, course_number) unique constraint
  // while numbers are mid-shuffle.
  const mapping = courseNumbers.map((oldNumber, index) => ({ oldNumber, newNumber: index + 1 }));

  const updated = await scopedPrisma.$transaction(async tx => {
    for (const { oldNumber } of mapping) {
      await tx.orderCourse.updateMany({ where: { orderId, venueId, courseNumber: oldNumber }, data: { courseNumber: -oldNumber } });
      await tx.orderItem.updateMany({ where: { orderId, venueId, courseNumber: oldNumber }, data: { courseNumber: -oldNumber } });
    }
    for (const { oldNumber, newNumber } of mapping) {
      await tx.orderCourse.updateMany({ where: { orderId, venueId, courseNumber: -oldNumber }, data: { courseNumber: newNumber } });
      await tx.orderItem.updateMany({ where: { orderId, venueId, courseNumber: -oldNumber }, data: { courseNumber: newNumber } });
    }

    await tx.orderEvent.create({
      data: { venueId, orderId, eventType: 'courses.reordered', actorUserId, payload: { mapping } },
    });

    return tx.orderCourse.findMany({ where: { orderId, venueId }, orderBy: { courseNumber: 'asc' } });
  });

  return { ok: true, value: updated };
}

// ── Move item between courses ───────────────────────────────────────────────

export async function moveItemCourse(
  venueId: string,
  actorUserId: string,
  orderId: string,
  itemId: string,
  newCourseNumber: number | null,
): Promise<CoursesResult<null>> {
  const gate = await checkCoursesAvailable(venueId);
  if (!gate.ok) return gate;
  const { settings } = gate.value;

  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const item = await scopedPrisma.orderItem.findFirst({ where: { id: itemId, orderId, venueId } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Order item not found') };

  // "Moving an item between courses is allowed only while it is pending."
  if (item.status !== 'pending') {
    return { ok: false, error: err(409, 'ITEM_ALREADY_SENT', 'This item has already been sent and can no longer be moved between courses') };
  }

  const courseError = validateCourseNumber(settings.coursesEnabled, newCourseNumber);
  if (courseError) return { ok: false, error: courseError };

  const before = item.courseNumber;

  await scopedPrisma.$transaction(async tx => {
    await tx.orderItem.update({ where: { id: itemId }, data: { courseNumber: newCourseNumber } });
    await tx.orderEvent.create({
      data: { venueId, orderId, orderItemId: itemId, eventType: 'item.course_changed', actorUserId, payload: { from: before, to: newCourseNumber } },
    });
    await recomputeOrder(tx, venueId, orderId);
  });

  return { ok: true, value: null };
}
