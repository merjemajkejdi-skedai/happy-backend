import { describe, it, expect } from 'vitest';
import { openApiSpec } from '../src/shared/openapi';

// Regression guard for a real bug found while building a typed client against
// this spec: op()'s default 200 response silently fell back to the *error*
// envelope shape ({error:{...}}) instead of the real success shape
// ({data, meta}), because `response('OK')` (no schema arg) defaults to
// errorEnvelope. 49 of 69 operations were affected before the fix. Two
// operations are legitimately exempt — they don't use the {data,meta}
// envelope at all (see EXEMPT_FROM_ENVELOPE below).
const EXEMPT_FROM_ENVELOPE = new Set(['GET /health', 'GET /openapi.json']);

describe('openApiSpec — 200 response shapes', () => {
  const operations: { key: string; schema: unknown }[] = [];
  for (const [path, methods] of Object.entries(openApiSpec.paths as Record<string, Record<string, any>>)) {
    for (const [method, op] of Object.entries(methods)) {
      const ok = op?.responses?.['200'];
      if (!ok) continue;
      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        schema: ok.content?.['application/json']?.schema,
      });
    }
  }

  it('found the expected number of operations with a 200 response', () => {
    expect(operations.length).toBe(69);
  });

  it.each(operations)('$key never types 200 as the error envelope', ({ key, schema }) => {
    if (EXEMPT_FROM_ENVELOPE.has(key)) return;
    const props = (schema as any)?.properties ?? {};
    const keys = Object.keys(props);
    expect(keys).not.toEqual(['error']);
    // Every non-exempt success response uses the {data, meta} envelope.
    expect(keys).toContain('data');
  });
});
