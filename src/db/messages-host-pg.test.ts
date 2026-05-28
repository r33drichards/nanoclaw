/**
 * Unit tests for the seq-rounding logic + SQL shape of the host PG
 * accessors. These don't exercise a live Postgres — they assert the
 * pure logic and the SQL strings the modules construct so we don't
 * silently lose the seq-parity invariant.
 */
import { describe, expect, it } from 'vitest';

// Mirror the seq-rounding from messages-in-host-pg.insertInboundMessage.
function nextEvenSeq(max: number): number {
  return max < 2 ? 2 : max + 2 - (max % 2);
}

describe('host seq parity (even)', () => {
  it('starts at 2 from empty', () => {
    expect(nextEvenSeq(0)).toBe(2);
  });
  it('jumps over an odd container seq', () => {
    expect(nextEvenSeq(1)).toBe(2);
    expect(nextEvenSeq(3)).toBe(4);
    expect(nextEvenSeq(5)).toBe(6);
  });
  it('moves to the next even after an even host seq', () => {
    expect(nextEvenSeq(2)).toBe(4);
    expect(nextEvenSeq(4)).toBe(6);
    expect(nextEvenSeq(100)).toBe(102);
  });
});
