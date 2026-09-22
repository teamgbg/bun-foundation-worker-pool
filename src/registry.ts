/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * Process-global WorkerPoolRegistry singleton. Every WorkerPool
 * auto-registers on construction. Mirrors the shape of CacheRegistry,
 * WatchdogRegistry, RateLimitRegistry — the operator's single observability
 * surface for in-process resource pools.
 *
 * Per `worker-pool-is-the-only-worker-pool` rule 7: a pool that bypasses
 * this registry is invisible to troubleshooting and is forbidden.
 */

import type { WorkerPool } from "./pool.ts";
import type { WorkerPoolStats } from "./types.ts";

class WorkerPoolRegistry {
	private readonly pools = new Map<string, WorkerPool>();

	register(pool: WorkerPool): void {
		if (this.pools.has(pool.name)) {
			throw new Error(
				`WorkerPool "${pool.name}" is already registered — duplicate ` +
					`names in one process are forbidden per ` +
					`worker-pool-is-the-only-worker-pool rule 2`,
			);
		}
		this.pools.set(pool.name, pool);
	}

	unregister(name: string): void {
		this.pools.delete(name);
	}

	get(name: string): WorkerPool | undefined {
		return this.pools.get(name);
	}

	getAll(): WorkerPoolStats[] {
		return Array.from(this.pools.values()).map((p) => p.stats());
	}

	terminate(name: string): void {
		this.pools.get(name)?.terminate();
	}

	terminateAll(): void {
		for (const pool of Array.from(this.pools.values())) {
			pool.terminate();
		}
	}
}

export const workerPoolRegistry = new WorkerPoolRegistry();
