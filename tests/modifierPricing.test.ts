// Session 2b-i, section 1 — resolveModifierPrice is a pure function so it can
// be fully unit-tested here, before session 2b-ii wires it into order-item
// pricing. Written before the implementation (TESTS FIRST).
import { describe, it, expect } from 'vitest';
import { resolveModifierPrice } from '../src/modules/menu/modifierPricing';
import type { ModifierPricing } from '../src/generated/prisma/client';

function group(pricingMode: ModifierPricing) {
  return { pricingMode };
}
function settings(modifierPricingMode: ModifierPricing) {
  return { modifierPricingMode };
}
function option(priceDelta: number, tierPrices: unknown = null) {
  return { priceDelta, tierPrices };
}

describe('resolveModifierPrice — free mode', () => {
  it('forces 0 regardless of the stored price_delta', () => {
    expect(resolveModifierPrice(option(500), 1, group('free'), settings('fixed'))).toBe(0);
    expect(resolveModifierPrice(option(-100), 3, group('free'), settings('fixed'))).toBe(0);
  });
});

describe('resolveModifierPrice — fixed mode', () => {
  it('uses price_delta as stored, ignoring ordinal', () => {
    expect(resolveModifierPrice(option(150), 1, group('fixed'), settings('free'))).toBe(150);
    expect(resolveModifierPrice(option(150), 7, group('fixed'), settings('free'))).toBe(150);
  });
  it('handles a zero price_delta', () => {
    expect(resolveModifierPrice(option(0), 1, group('fixed'), settings('free'))).toBe(0);
  });
});

describe('resolveModifierPrice — tiered mode', () => {
  const tiers = { '1': 0, '2': 50, '3': 100 };

  it('resolves the exact ordinal from tier_prices', () => {
    expect(resolveModifierPrice(option(999, tiers), 1, group('tiered'), settings('fixed'))).toBe(0);
    expect(resolveModifierPrice(option(999, tiers), 2, group('tiered'), settings('fixed'))).toBe(50);
    expect(resolveModifierPrice(option(999, tiers), 3, group('tiered'), settings('fixed'))).toBe(100);
  });

  it('beyond the highest key, uses the highest value', () => {
    expect(resolveModifierPrice(option(999, tiers), 4, group('tiered'), settings('fixed'))).toBe(100);
    expect(resolveModifierPrice(option(999, tiers), 100, group('tiered'), settings('fixed'))).toBe(100);
  });

  it('below the lowest defined key, resolves to 0 (nothing defined yet at that position)', () => {
    const gappyTiers = { '2': 50, '3': 100 }; // no tier for ordinal 1
    expect(resolveModifierPrice(option(999, gappyTiers), 1, group('tiered'), settings('fixed'))).toBe(0);
  });

  it('fills gaps by carrying forward the last applicable tier', () => {
    const gappyTiers = { '1': 10, '3': 100 }; // no explicit tier for ordinal 2
    expect(resolveModifierPrice(option(999, gappyTiers), 2, group('tiered'), settings('fixed'))).toBe(10);
  });

  it('empty/missing tier_prices resolves to 0', () => {
    expect(resolveModifierPrice(option(999, null), 1, group('tiered'), settings('fixed'))).toBe(0);
    expect(resolveModifierPrice(option(999, {}), 1, group('tiered'), settings('fixed'))).toBe(0);
  });

  it('ignores non-positive-integer keys and non-finite values', () => {
    const dirty = { '0': 999, '-1': 999, 'abc': 999, '2': 50 };
    expect(resolveModifierPrice(option(999, dirty), 2, group('tiered'), settings('fixed'))).toBe(50);
    expect(resolveModifierPrice(option(999, dirty), 1, group('tiered'), settings('fixed'))).toBe(0);
  });
});

describe('resolveModifierPrice — resolution order (group.pricing_mode overrides settings.modifier_pricing_mode)', () => {
  it("group='free' wins even when settings='fixed'", () => {
    expect(resolveModifierPrice(option(500), 1, group('free'), settings('fixed'))).toBe(0);
  });
  it("group='fixed' wins even when settings='free'", () => {
    expect(resolveModifierPrice(option(500), 1, group('fixed'), settings('free'))).toBe(500);
  });
  it("group='tiered' wins even when settings='fixed'", () => {
    expect(resolveModifierPrice(option(500, { '1': 25 }), 1, group('tiered'), settings('fixed'))).toBe(25);
  });
});
