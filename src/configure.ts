/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * Bootloader entry per `configured-primitives` doctrine. Reads
 * `configurable_primitive` row 'worker-pool' to apply per-pool overrides
 * (size, queueCap). Module-level state; safe default = no overrides.
 *
 * Pools constructed before configure() runs use their defaults; configure()
 * registers overrides that future createWorkerPool() calls apply. Existing
 * pools are NOT mutated — operators terminate + recreate them if they want
 * the new shape (rare; sizes are usually static for the process lifetime).
 */

interface PoolOverride {
	size?: number;
	queueCap?: number;
	taskTimeoutMs?: number;
}

let overrides: Record<string, PoolOverride> = {};

export interface WorkerPoolConfig {
	pools?: Record<string, PoolOverride>;
}

export function configure(config: WorkerPoolConfig): void {
	overrides = config.pools ?? {};
}

export function getConfiguredOverride(name: string): PoolOverride | undefined {
	return overrides[name];
}
