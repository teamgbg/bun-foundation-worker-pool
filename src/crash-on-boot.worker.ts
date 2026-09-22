/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * Fixture worker for the crash-halt breaker test (pool.test.ts). Crashes
 * immediately on boot via process.exit(1) so the pool's close handler fires,
 * records the crash, and respawns — repeating until the per-slot limit halts
 * it. NEVER imported by runtime code; test fixture only.
 */
process.exit(1);
