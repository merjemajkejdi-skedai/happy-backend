import type { ModifierPricing } from '../../generated/prisma/client';

// Pure pricing resolution — session 2b-i, section 1. No DB access, no
// side effects, so both this session's tests and session 2b-ii's
// order-item pricing logic can call it directly. Do NOT inline this
// elsewhere; this is the one place the three pricing modes are resolved.

export interface PricedOption {
  priceDelta: number;
  // Prisma's Json column type — validated/normalized internally, callers
  // pass the raw stored value straight through.
  tierPrices: unknown;
}

export interface PricingGroup {
  pricingMode: ModifierPricing;
}

export interface PricingSettings {
  modifierPricingMode: ModifierPricing;
}

// tier_prices is stored as {"1": 0, "2": 50, ...} — string keys (JSON object
// keys are always strings) mapping a 1-indexed selection ordinal to a price.
// Non-positive-integer keys or non-finite values are silently dropped rather
// than thrown on here — write-time validation (modifiersService.ts) is what
// rejects bad input; this resolver just has to be safe against whatever is
// already stored.
function normalizeTierPrices(raw: unknown): [number, number][] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>)
    .map(([key, value]): [number, number] => [Number(key), Number(value)])
    .filter(([key, value]) => Number.isInteger(key) && key > 0 && Number.isFinite(value))
    .sort((a, b) => a[0] - b[0]);
}

// "1st selection is free, 2nd costs 50, 3rd costs 100. Beyond the highest
// key, use the highest value." Below the lowest defined key (a gap at the
// start), resolves to 0 — nothing has been defined for that position yet,
// same convention as free mode's zero. A single ascending pass naturally
// implements both "carry the last applicable tier forward" and "beyond the
// highest key" in one loop, since every tier at or below `ordinal` updates
// `value`, in order — so the last update before the loop ends is always the
// largest key <= ordinal.
function tieredPrice(tierPrices: unknown, ordinal: number): number {
  const tiers = normalizeTierPrices(tierPrices);
  let value = 0;
  for (const [key, price] of tiers) {
    if (key <= ordinal) value = price;
    else break;
  }
  return value;
}

// Resolution order: group.pricing_mode overrides settings.modifier_pricing_mode.
// In the current schema group.pricingMode is NOT NULL (defaults to 'fixed'),
// so it's always the authoritative value in practice — the `??` fallback to
// `settings.modifierPricingMode` exists to match the stated resolution order
// literally / defensively, not because it's currently reachable.
export function resolveModifierPrice(
  option: PricedOption,
  ordinal: number,
  group: PricingGroup,
  settings: PricingSettings,
): number {
  const mode = group.pricingMode ?? settings.modifierPricingMode;

  if (mode === 'free') return 0;
  if (mode === 'fixed') return Number(option.priceDelta);
  return tieredPrice(option.tierPrices, ordinal);
}
