import { describe, expect, it } from 'bun:test';

import { sessionChannel } from './connection-pg.js';

describe('sessionChannel', () => {
  it('replaces dashes with underscores to match the SQL identifier', () => {
    expect(sessionChannel('abc-def-1234')).toBe('ncl_session_abc_def_1234');
  });
  it('handles ids with no dashes', () => {
    expect(sessionChannel('plain')).toBe('ncl_session_plain');
  });
  it('preserves underscores already present', () => {
    expect(sessionChannel('a_b-c')).toBe('ncl_session_a_b_c');
  });
});

describe('session channel matches deploy/postgres/20-triggers.sql convention', () => {
  // The trigger function builds: 'ncl_session_' || replace(NEW.session_id, '-', '_')
  // If this mismatches, LISTEN never receives wake notifications.
  it('uses ncl_session_ prefix', () => {
    expect(sessionChannel('x')).toMatch(/^ncl_session_/);
  });
});
