// Writes docs/openapi.json from the same spec object GET /api/v1/openapi.json
// serves — run `npm run openapi:generate` after changing src/shared/openapi.ts
// so the checked-in snapshot doesn't drift from what the live route returns.
import fs from 'fs';
import path from 'path';
import { openApiSpec } from '../src/shared/openapi';

const outPath = path.join(__dirname, '..', 'docs', 'openapi.json');
fs.writeFileSync(outPath, JSON.stringify(openApiSpec, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
