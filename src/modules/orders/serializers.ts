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

export function serializeOrder<T extends Order & { items?: (OrderItem & { modifiers?: OrderItemModifier[] })[] }>(order: T) {
  return {
    ...order,
    subtotal: Number(order.subtotal),
    taxTotal: Number(order.taxTotal),
    serviceChargeTotal: Number(order.serviceChargeTotal),
    discountTotal: Number(order.discountTotal),
    grandTotal: Number(order.grandTotal),
    ...(order.items ? { items: order.items.map(serializeOrderItem) } : {}),
  };
}
