/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * Factory function — the public surface consumers call. Mirrors
 * `createCache`, `createWatchdog`, etc. so the workspace-wide primitive
 * factory pattern stays uniform.
 */

import { getConfiguredOverride } from "./configure.ts";
import { WorkerPool } from "./pool.ts";
import type { WorkerPoolOptions } from "./types.ts";

export function createWorkerPool(opts: WorkerPoolOptions): WorkerPool {
	const override = getConfiguredOverride(opts.name);
	return new WorkerPool({
		...opts,
		size: override?.size ?? opts.size,
		queueCap: override?.queueCap ?? opts.queueCap,
		taskTimeoutMs: override?.taskTimeoutMs ?? opts.taskTimeoutMs,
	});
}
