import type { Order, OrderItem, OrderItemModifier } from '../../generated/prisma/client';

// Same Decimal-serializes-as-string issue as menu/serializers.ts — every
// money field in this API is a real number on the wire, never a string.
export function serializeOrderItemModifier<T extends OrderItemModifier>(modifier: T) {
  return { ...modifier, priceDeltaSnapshot: Number(modifier.priceDeltaSnapshot) };
}

export function serializeOrderItem<T extends OrderItem & { modifiers?: OrderItemModifier[] }>(item: T) {
  return {
    ...item,
    unitPriceSnapshot: Number(item.unitPriceSnapshot),
    taxRateSnapshot: Number(item.taxRateSnapshot),
    modifiersTotal: Number(item.modifiersTotal),
    lineTotal: Number(item.lineTotal),
    ...(item.modifiers ? { modifiers: item.modifiers.map(serializeOrderItemModifier) } : {}),
  };
}

// pmsEnabled defaults false so every existing call site keeps working
// unchanged — pass the venue's real flag explicitly wherever it's cheaply
// available. pms_folio_id/pms_room_number/pms_posted_at are schema-only,
// always-null-in-Phase-1 columns; they're omitted (not sent as null) while
// the flag is off, matching the same convention already used for
// whatsapp_config/ai_config/pms_room_charge_enabled in settingsSerializer.ts.
export function serializeOrder<T extends Order & { items?: (OrderItem & { modifiers?: OrderItemModifier[] })[] }>(
  order: T,
  pmsEnabled = false,
) {
  const { pmsFolioId, pmsRoomNumber, pmsPostedAt, ...rest } = order;
  return {
    ...rest,
    subtotal: Number(order.subtotal),
    taxTotal: Number(order.taxTotal),
    serviceChargeTotal: Number(order.serviceChargeTotal),
    discountTotal: Number(order.discountTotal),
    grandTotal: Number(order.grandTotal),
    ...(pmsEnabled ? { pmsFolioId, pmsRoomNumber, pmsPostedAt } : {}),
    ...(order.items ? { items: order.items.map(serializeOrderItem) } : {}),
  };
}
