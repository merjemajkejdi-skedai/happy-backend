// Dev convenience: creates one venue of each type with an admin login,
// so you can log into the frontend locally without building an admin UI first.
import bcrypt from 'bcrypt';
import { pool, query, queryOne } from './connection';
import { runMigrations } from './migrate';

interface SeedVenue {
  code: string;
  name: string;
  venue_type: 'happy_restaurant' | 'happy_bar' | 'happy_hybrid';
  pin: string;
}

const VENUES: SeedVenue[] = [
  { code: 'dev-restaurant', name: 'Dev Trattoria',    venue_type: 'happy_restaurant', pin: '1111' },
  { code: 'dev-bar',        name: 'Dev Cocktail Bar',  venue_type: 'happy_bar',        pin: '2222' },
  { code: 'dev-hybrid',     name: 'Dev Hybrid Venue',  venue_type: 'happy_hybrid',     pin: '3333' },
];

async function seedVenue(v: SeedVenue) {
  const existing = await queryOne<{ id: string }>('SELECT id FROM venues WHERE code = $1', [v.code]);
  if (existing) {
    console.log(`skip (already exists): ${v.code}`);
    return;
  }

  const isBar = v.venue_type === 'happy_bar';
  const venue = await queryOne<{ id: string }>(
    `INSERT INTO venues (code, name, venue_type, counter_service_enabled, send_by_course, kitchen_display_enabled, bar_display_enabled)
     VALUES ($1, $2, $3, $4, FALSE, $5, $6)
     RETURNING id`,
    [v.code, v.name, v.venue_type, isBar, !isBar, v.venue_type !== 'happy_restaurant'],
  );
  if (!venue) throw new Error(`failed to create venue ${v.code}`);

  const pinHash = await bcrypt.hash(v.pin, 10);
  await query(
    `INSERT INTO staff (venue_id, name, role, pin_hash) VALUES ($1, 'Admin', 'admin', $2)`,
    [venue.id, pinHash],
  );

  console.log(`seeded venue "${v.code}" (${v.venue_type}) — admin PIN: ${v.pin}`);
}

async function main() {
  await runMigrations();
  for (const v of VENUES) await seedVenue(v);
}

main()
  .then(() => { console.log('seed complete'); return pool.end(); })
  .catch(err => { console.error(err); process.exit(1); });
