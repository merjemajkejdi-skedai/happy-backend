import { describe, it, expect } from 'vitest';
import { scopedPrisma } from '../src/middleware/venueScope';

describe('venueScope Prisma guard', () => {
  it('throws when a venue-scoped query has no where clause at all', async () => {
    await expect(scopedPrisma.menuCategory.findMany()).rejects.toThrow(/venue_id filter/);
  });

  it('throws when filtered by something other than venue_id', async () => {
    await expect(scopedPrisma.menuCategory.findMany({ where: { name: 'Starters' } })).rejects.toThrow(/venue_id filter/);
  });

  it('succeeds once venue_id is present in the filter', async () => {
    await expect(
      scopedPrisma.menuCategory.findMany({ where: { venueId: '00000000-0000-0000-0000-000000000000' } }),
    ).resolves.toBeInstanceOf(Array);
  });

  it('guards updateMany and deleteMany too, not just reads', async () => {
    await expect(scopedPrisma.menuItem.updateMany({ data: { isActive: false } } as any)).rejects.toThrow(/venue_id filter/);
    await expect(scopedPrisma.order.deleteMany()).rejects.toThrow(/venue_id filter/);
  });

  it('does not guard models with no venue_id column (Venue itself)', async () => {
    await expect(scopedPrisma.venue.findMany()).resolves.toBeInstanceOf(Array);
  });

  it('does not guard findUnique — a single row by primary key structurally cannot carry an extra filter', async () => {
    await expect(scopedPrisma.user.findUnique({ where: { id: '00000000-0000-0000-0000-000000000000' } })).resolves.toBeNull();
  });
});
