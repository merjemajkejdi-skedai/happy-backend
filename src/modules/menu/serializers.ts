import type { MenuItem, ModifierOption } from '../../generated/prisma/client';

// Prisma's Decimal serializes to a string by default (decimal.js toJSON) —
// every money/percent field in this API is a real number on the wire, never
// a string, matching how settingsSerializer already handles this.
export function serializeMenuItem<T extends MenuItem>(item: T) {
  return {
    ...item,
    price: Number(item.price),
    taxRatePercent: item.taxRatePercent != null ? Number(item.taxRatePercent) : null,
  };
}

export function serializeModifierOption<T extends ModifierOption>(option: T) {
  return { ...option, priceDelta: Number(option.priceDelta) };
}
