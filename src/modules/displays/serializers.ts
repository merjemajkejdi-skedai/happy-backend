import type { Order, OrderCourse, OrderItem, OrderItemModifier, RestaurantTable, TableNaming } from '../../generated/prisma/client';
import { computeDisplayLabel } from '../tables/service';

// Response shape is locked per spec (snake_case, unlike the rest of this
// API's camelCase Prisma-passthrough responses) — Phase 2 swaps polling for
// push transport without touching this shape or any client rendering code.
export interface DisplayModifierDTO {
  group_name: string;
  option_name: string;
}

export interface DisplayItemDTO {
  id: string;
  item_name: string;
  quantity: number;
  notes: string | null;
  status: string;
  sent_at: string | null;
  preparing_at: string | null;
  ready_at: string | null;
  elapsed_seconds: number;
  modifiers: DisplayModifierDTO[];
}

export interface DisplayCourseDTO {
  course_number: number | null;
  items: DisplayItemDTO[];
}

export interface DisplayTicketDTO {
  order_id: string;
  order_number: number;
  ticket_number: string | null;
  service_mode: string;
  table_display_label: string | null;
  guest_count: number | null;
  customer_name: string | null;
  opened_at: string;
  first_sent_at: string | null;
  waiter_name: string;
  elapsed_seconds: number;
  is_warning: boolean;
  courses: DisplayCourseDTO[];
}

export interface DisplayMetaDTO {
  generated_at: string;
  refresh_seconds: number;
  ticket_count: number;
  item_count: number;
}

function elapsedSeconds(from: Date | null, now: Date): number {
  if (!from) return 0;
  return Math.floor((now.getTime() - from.getTime()) / 1000);
}

// item_name / modifier names / destination all come from the snapshot
// columns already on the OrderItem/OrderItemModifier rows passed in here —
// this function never touches menu_items/menu_categories/modifier_options.
export function buildTicket(
  order: Order,
  items: (OrderItem & { modifiers: OrderItemModifier[] })[],
  waiterName: string,
  tableDisplayLabel: string | null,
  warnAfterMinutes: number,
  now: Date,
): DisplayTicketDTO {
  const byCourse = new Map<number | null, DisplayItemDTO[]>();
  for (const item of items) {
    const dto: DisplayItemDTO = {
      id: item.id,
      item_name: item.itemNameSnapshot,
      quantity: item.quantity,
      notes: item.notes,
      status: item.status,
      sent_at: item.sentAt ? item.sentAt.toISOString() : null,
      preparing_at: item.preparingAt ? item.preparingAt.toISOString() : null,
      ready_at: item.readyAt ? item.readyAt.toISOString() : null,
      elapsed_seconds: elapsedSeconds(item.sentAt, now),
      modifiers: item.modifiers.map(m => ({ group_name: m.groupNameSnapshot, option_name: m.optionNameSnapshot })),
    };
    const key = item.courseNumberSnapshot;
    const list = byCourse.get(key) ?? [];
    list.push(dto);
    byCourse.set(key, list);
  }

  // Single course numbered null when courses are off for the venue falls
  // out naturally here: every item's courseNumberSnapshot is null in that
  // case (enforced at add-item time), so there's exactly one bucket.
  const courses: DisplayCourseDTO[] = [...byCourse.entries()]
    .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
    .map(([course_number, courseItems]) => ({
      course_number,
      items: courseItems.sort((a, b) => (a.sent_at ?? '').localeCompare(b.sent_at ?? '')),
    }));

  const ticketElapsed = elapsedSeconds(order.firstSentAt, now);

  return {
    order_id: order.id,
    order_number: order.orderNumber,
    ticket_number: order.ticketNumber,
    service_mode: order.serviceMode,
    table_display_label: tableDisplayLabel,
    guest_count: order.guestCount,
    customer_name: order.customerName,
    opened_at: order.openedAt.toISOString(),
    first_sent_at: order.firstSentAt ? order.firstSentAt.toISOString() : null,
    waiter_name: waiterName,
    elapsed_seconds: ticketElapsed,
    is_warning: ticketElapsed > warnAfterMinutes * 60,
    courses,
  };
}

export function buildMeta(refreshSeconds: number, tickets: DisplayTicketDTO[], now: Date): DisplayMetaDTO {
  const itemCount = tickets.reduce((sum, t) => sum + t.courses.reduce((s, c) => s + c.items.length, 0), 0);
  return { generated_at: now.toISOString(), refresh_seconds: refreshSeconds, ticket_count: tickets.length, item_count: itemCount };
}

// Phase 2, session 2c. The backend composes headline/table_label — the
// client never builds them.
export interface FireAlertDTO {
  id: string;
  type: 'fire';
  course_number: number;
  course_name: string;
  order_number: number;
  table_label: string | null;
  item_count: number;
  fired_at: string;
  expires_at: string;
  headline: string;
  acknowledged: boolean;
}

export function buildFireAlert(
  course: OrderCourse,
  order: Order,
  table: RestaurantTable | null,
  tableNamingMode: TableNaming,
  showFireAlertSeconds: number,
): FireAlertDTO {
  const firedAt = course.firedAt!; // callers only pass already-fired courses
  const expiresAt = new Date(firedAt.getTime() + showFireAlertSeconds * 1000);

  const isCounter = order.serviceMode === 'counter';
  const tableLabel = !isCounter && table ? `Table ${computeDisplayLabel(tableNamingMode, table.tableNumber, table.tableName)}` : null;
  const locationForHeadline = isCounter
    ? `TICKET ${order.ticketNumber}`
    : `TABLE ${(table ? computeDisplayLabel(tableNamingMode, table.tableNumber, table.tableName) : '').toUpperCase()}`;

  return {
    id: course.id,
    type: 'fire',
    course_number: course.courseNumber,
    course_name: course.courseNameSnapshot,
    order_number: order.orderNumber,
    table_label: tableLabel,
    item_count: course.itemCount,
    fired_at: firedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    headline: `FIRE ${course.courseNameSnapshot.toUpperCase()} — ${locationForHeadline}`,
    acknowledged: course.fireAlertAckedAt != null,
  };
}
