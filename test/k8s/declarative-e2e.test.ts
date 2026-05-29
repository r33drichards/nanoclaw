/**
 * Declarative-mode E2E driver.
 *
 * Gated on RUN_K8S_E2E=1 because it spins up a kind cluster and installs
 * three operators (CNPG, cert-manager, agent-sandbox). Takes ~5 minutes.
 *
 * Invocation:
 *   RUN_K8S_E2E=1 pnpm test test/k8s/
 *
 * The actual driver lives in test/k8s/declarative-e2e.sh — this wrapper
 * shells out to it so the script stays usable standalone.
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { describe, expect, it } from 'vitest';

const E2E_ENABLED = process.env.RUN_K8S_E2E === '1';

describe.skipIf(!E2E_ENABLED)('declarative k8s e2e', () => {
  it('drives a kind cluster through CRD + controller + chart bringup', { timeout: 15 * 60_000 }, () => {
    const script = path.resolve(__dirname, 'declarative-e2e.sh');
    const result = spawnSync('bash', [script], {
      stdio: 'inherit',
      env: process.env,
    });
    expect(result.status, `e2e script exited ${result.status}`).toBe(0);
  });
});

// When not enabled, surface a single trivial assertion so the test file
// isn't reported as empty.
describe.skipIf(E2E_ENABLED)('declarative k8s e2e (skipped)', () => {
  it('skipped — set RUN_K8S_E2E=1 to enable', () => {
    expect(E2E_ENABLED).toBe(false);
  });
});
