#!/usr/bin/env bun
/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * Fixture worker for the crash-halt breaker test (pool.test.ts). Crashes
 * immediately on boot via process.exit(1) so the pool's close handler fires,
 * records the crash, and respawns — repeating until the per-slot limit halts
 * it. NEVER imported by runtime code; test fixture only.
 *
 * The shebang is load-bearing, not decoration: the publish smoke splits
 * exports by the entry's own declared contract, and a first-line shebang
 * declares an executable entry it verifies by resolution + module-graph
 * parse — never by import. Without it this script is import-evaluated at
 * publish and its process.exit(1) fails the smoke for the whole package
 * (publish-consumer-import-smoke).
 */
process.exit(1);
