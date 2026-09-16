import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixtures } from './index.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('determinizm generatora fixture\'ow', () => {
  it.each(fixtures.map((f) => [f.id, f] as const))('%s: dwa wywolania build() daja identyczny hash SHA-256', (_id, fixture) => {
    const a = sha256(fixture.build());
    const b = sha256(fixture.build());
    expect(a).toBe(b);
  });
});
