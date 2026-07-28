import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../src/db/prisma';

// Phase 2, session 2h-ii, section 5 — static/structural guards for the
// scope boundaries in docs/phase2/NOT-IN-PHASE-2.md that aren't (and
// mostly can't be) proven by hitting a route with test data. discount_total
// and pms_folio_id/pms_room_number/pms_posted_at already have full
// lifecycle coverage in tests/phase1Guards.test.ts (still green post-Phase
// 2 — not duplicated here); this file covers the checklist items that are
// genuinely new: no payment-gateway code, no realtime transport, no
// printing code.

const SRC_DIR = path.join(__dirname, '..', 'src');

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') continue; // Prisma client output — not hand-written source
      out.push(...allSourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = allSourceFiles(SRC_DIR);
const sourceBlobs = sourceFiles.map(f => ({ file: f, text: fs.readFileSync(f, 'utf8') }));

function grepSource(pattern: RegExp): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const { file, text } of sourceBlobs) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line)) hits.push({ file: path.relative(SRC_DIR, file), line: i + 1, text: line.trim() });
    });
  }
  return hits;
}

describe('No payment processing, gateway, or card-number field exists anywhere', () => {
  it('package.json declares no payment-gateway or card-processing SDK', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const forbidden = ['stripe', 'square', 'braintree', 'adyen', 'paypal', 'authorizenet', 'worldpay'];
    for (const name of Object.keys(allDeps)) {
      for (const bad of forbidden) {
        expect(name.toLowerCase()).not.toContain(bad);
      }
    }
  });

  it('the Payment model has no card-number/CVV/expiry column', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    const modelMatch = schema.match(/model Payment \{[\s\S]*?\n\}/);
    expect(modelMatch).not.toBeNull();
    const modelBody = modelMatch![0].toLowerCase();
    for (const bad of ['card_number', 'cardnumber', 'cvv', 'cvc', 'expiry', 'pan ']) {
      expect(modelBody).not.toContain(bad);
    }
  });

  it('no source file references a card PAN, CVV, or gateway/terminal integration', () => {
    const hits = grepSource(/\b(card_?number|cvv|cvc|pci|payment_?gateway|stripe|square_?up|braintree|payment_?terminal)\b/i);
    expect(hits).toEqual([]);
  });
});

describe('No WebSocket or SSE code exists', () => {
  it('no source file imports ws/socket.io or opens an SSE stream', () => {
    const hits = grepSource(/\b(new WebSocket|require\(['"]ws['"]\)|socket\.io|EventSource|text\/event-stream|res\.flushHeaders)\b/);
    expect(hits).toEqual([]);
  });

  it('package.json declares no realtime-transport dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const bad of ['ws', 'socket.io', 'socket.io-client', 'sockjs']) {
      expect(Object.keys(allDeps)).not.toContain(bad);
    }
  });
});

describe('No printing code exists', () => {
  it('kitchen_printer_enabled/bar_printer_enabled are inert — no source file talks to a printer', () => {
    const hits = grepSource(/\b(escpos|thermal_?printer|printer\.(write|print)|require\(['"]printer['"]\)|node-printer)\b/i);
    expect(hits).toEqual([]);
  });
});

describe('reports.export never emits PDF', () => {
  it('the export route only recognizes csv/json formats', () => {
    const routesSrc = fs.readFileSync(path.join(SRC_DIR, 'modules', 'reports', 'routes.ts'), 'utf8');
    expect(routesSrc).toMatch(/EXPORT_FORMATS = \['csv', 'json'\]/);
    expect(routesSrc.toLowerCase()).not.toContain('pdf');
  });
});

describe('discount_total and pms_* stay inert under Phase 2 flows too', () => {
  it('a payment does not touch discount_total, and no pms_* column is ever written by paymentsService', async () => {
    const venue = await prisma.venue.findUniqueOrThrow({ where: { slug: 'happy-bar' } });
    const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { venueId: venue.id } });
    expect(settings.pmsEnabled).toBe(false);

    const paymentsServiceSrc = fs.readFileSync(path.join(SRC_DIR, 'modules', 'orders', 'paymentsService.ts'), 'utf8');
    expect(paymentsServiceSrc).not.toMatch(/pmsFolioId|pmsRoomNumber|pmsPostedAt|discountTotal/);
  });
});
