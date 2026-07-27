import type { MenuItem, ModifierOption } from '../../generated/prisma/client';
import { computeIsOrderable, computeStockRemaining, type StockSnapshot } from './stockService';

// Prisma's Decimal serializes to a string by default (decimal.js toJSON) —
// every money/percent field in this API is a real number on the wire, never
// a string, matching how settingsSerializer already handles this.
//
// is_orderable/stock_remaining (Phase 2, session 2e) are exposed camelCase
// like every other field here — the spec's own prose uses snake_case for
// these names, but that's true of every field description in this API's
// docs regardless of wire casing; the displays module is the only one with
// a genuinely locked snake_case shape, and this isn't it.
export function serializeMenuItem<T extends MenuItem>(item: T, stock: StockSnapshot | null, allowNegativeStock: boolean) {
  return {
    ...item,
    price: Number(item.price),
    taxRatePercent: item.taxRatePercent != null ? Number(item.taxRatePercent) : null,
    isOrderable: computeIsOrderable(item, stock, allowNegativeStock),
    stockRemaining: computeStockRemaining(stock),
  };
}

export function serializeModifierOption<T extends ModifierOption>(option: T) {
  return { ...option, priceDelta: Number(option.priceDelta) };
}
