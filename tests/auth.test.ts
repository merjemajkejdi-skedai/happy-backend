import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as authService from '../src/modules/auth/service';
import { createTestVenue, destroyTestVenue, TEST_VENUE_SLUG } from './fixtures';

describe('PIN login — all three seeded venues', () => {
  const cases: Array<{ slug: string; role: string; pin: string }> = [
    { slug: 'happy-resto', role: 'waiter', pin: '1111' },
    { slug: 'happy-resto', role: 'kitchen', pin: '2222' },
    { slug: 'happy-resto', role: 'admin', pin: '3333' },
    { slug: 'happy-bar', role: 'waiter', pin: '1111' },
    { slug: 'happy-bar', role: 'kitchen', pin: '2222' },
    { slug: 'happy-bar', role: 'admin', pin: '3333' },
    // happy-hybrid's login_method is 'email' — PIN login must be rejected
    // there, not attempted as a success case (tested below).
  ];

  for (const c of cases) {
    it(`logs in ${c.role}@${c.slug} by PIN`, async () => {
      const result = await authService.loginWithPin(c.slug, c.pin);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.user.role).toBe(c.role);
        expect(result.venue.slug).toBe(c.slug);
        expect(result.accessToken).toBeTruthy();
        expect(result.refreshToken).toBeTruthy();
      }
    });
  }

  it('rejects PIN login at happy-hybrid (login_method=email)', async () => {
    const result = await authService.loginWithPin('happy-hybrid', '1111');
    expect(result).toEqual({ ok: false, error: 'wrong_login_method' });
  });

  it('rejects an unknown venue slug', async () => {
    const result = await authService.loginWithPin('no-such-venue', '1111');
    expect(result).toEqual({ ok: false, error: 'venue_not_found' });
  });
});

describe('Email login — where allowed', () => {
  it('logs in via email at happy-hybrid (login_method=email)', async () => {
    const result = await authService.loginWithEmail('happy-hybrid', 'waiter@happy-hybrid.test', 'Passw0rd!');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.role).toBe('waiter');
  });

  it('logs in via email at happy-bar (login_method=both)', async () => {
    const result = await authService.loginWithEmail('happy-bar', 'admin@happy-bar.test', 'Passw0rd!');
    expect(result.ok).toBe(true);
  });

  it('rejects email login at happy-resto (login_method=pin)', async () => {
    const result = await authService.loginWithEmail('happy-resto', 'waiter@happy-resto.test', 'Passw0rd!');
    expect(result).toEqual({ ok: false, error: 'wrong_login_method' });
  });

  // Deliberately not run against the shared seeded accounts — any failed
  // attempt bumps failed_login_count on a real dev-seed user, which the
  // "Lockout" suite below already covers properly with a throwaway fixture.
  it('rejects a wrong password', async () => {
    await createTestVenue('email', [{ role: 'waiter', email: 'wrongpass@test.local', password: 'CorrectPass1!' }]);
    try {
      const result = await authService.loginWithEmail(TEST_VENUE_SLUG, 'wrongpass@test.local', 'NotThePassword!');
      expect(result).toEqual({ ok: false, error: 'invalid_credentials' });
    } finally {
      await destroyTestVenue();
    }
  });
});

describe('Lockout after 5 failures', () => {
  // Uses a dedicated throwaway venue/user — deliberately NOT the shared dev
  // seed data, since triggering a lockout would corrupt it for manual testing.
  beforeAll(async () => {
    await createTestVenue('both', [
      { role: 'waiter', email: 'lockout@test.local', password: 'CorrectPass1!', pin: '4321' },
    ]);
  });
  afterAll(async () => { await destroyTestVenue(); });

  it('locks the account after 5 wrong-password attempts, rejecting even the correct password while locked', async () => {
    for (let i = 0; i < 5; i++) {
      const attempt = await authService.loginWithEmail(TEST_VENUE_SLUG, 'lockout@test.local', 'WrongPassword!');
      expect(attempt).toEqual({ ok: false, error: 'invalid_credentials' });
    }
    const stillLocked = await authService.loginWithEmail(TEST_VENUE_SLUG, 'lockout@test.local', 'CorrectPass1!');
    expect(stillLocked).toEqual({ ok: false, error: 'locked' });
  });
});

describe('PIN login and lockout — a wrong PIN never identifies an account', () => {
  // /login/pin takes only { venue_slug, pin } — no separate username. A
  // wrong PIN's HMAC lookup simply matches no row, so there's no specific
  // account to attribute the failure to and therefore nothing to lock. This
  // is the correct, expected behavior given that endpoint contract (see the
  // comment in modules/auth/service.ts), not a gap in the lockout logic —
  // per-account PIN lockout only shows up in the email flow, tested above.
  beforeAll(async () => {
    await createTestVenue('pin', [{ role: 'waiter', pin: '7777' }]);
  });
  afterAll(async () => { await destroyTestVenue(); });

  it('5 wrong PIN guesses never lock the account, and the correct PIN still works afterwards', async () => {
    for (let i = 0; i < 5; i++) {
      const attempt = await authService.loginWithPin(TEST_VENUE_SLUG, '0000');
      expect(attempt).toEqual({ ok: false, error: 'invalid_credentials' });
    }
    const correct = await authService.loginWithPin(TEST_VENUE_SLUG, '7777');
    expect(correct.ok).toBe(true);
  });
});

describe('Refresh rotation and revoked-token reuse detection', () => {
  it('issues a different refresh token on every /refresh call, and the old one stops working', async () => {
    const login = await authService.loginWithPin('happy-bar', '1111');
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const r1 = await authService.refreshSession(login.refreshToken);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.refreshToken).not.toBe(login.refreshToken);

    const reuseOld = await authService.refreshSession(login.refreshToken);
    expect(reuseOld).toEqual({ ok: false, reason: 'reused' });
  });

  it('revokes the entire token family when a revoked token is reused', async () => {
    const login = await authService.loginWithPin('happy-bar', '2222');
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const r1 = await authService.refreshSession(login.refreshToken);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Reusing the original (already-rotated, now-revoked) token triggers
    // family-wide revocation...
    const reuse = await authService.refreshSession(login.refreshToken);
    expect(reuse).toEqual({ ok: false, reason: 'reused' });

    // ...so the token issued by the otherwise-legitimate rotation above is
    // now revoked too, even though it was never itself reused.
    const familyVictim = await authService.refreshSession(r1.refreshToken);
    expect(familyVictim).toEqual({ ok: false, reason: 'reused' });
  });

  it('rejects an unknown refresh token', async () => {
    const result = await authService.refreshSession('not-a-real-token');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('getMe / getVenueConfig', () => {
  it('returns the user (no hashes), venue, and settings with disabled bolt-ons omitted', async () => {
    const login = await authService.loginWithPin('happy-resto', '3333');
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const me = await authService.getMe(login.user.id, login.venue.id);
    expect(me).not.toBeNull();
    expect(me!.user).not.toHaveProperty('passwordHash');
    expect(me!.user).not.toHaveProperty('pinHash');
    expect(me!.user).not.toHaveProperty('pinLookup');
    // happy-resto seeds whatsapp/ai/pms all disabled — their config keys must be absent entirely.
    expect(me!.settings).not.toHaveProperty('whatsappConfig');
    expect(me!.settings).not.toHaveProperty('aiConfig');
    expect(me!.settings).not.toHaveProperty('pmsRoomChargeEnabled');
    expect(me!.settings.pmsEnabled).toBe(false); // the gating flag itself is always present
  });

  it('venue-config exposes only the public fields', async () => {
    const config = await authService.getVenueConfig('happy-bar');
    expect(config).toEqual({
      name: 'Happy Bar',
      venue_type: 'happy_bar',
      login_method: 'both',
      locale: 'sq-AL',
      currency: 'ALL',
    });
  });
});
