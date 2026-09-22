/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * Typed errors emitted by the pool. Every export — the 4 error classes,
 * POOL_ERROR_NAMES, isPoolError — is part of the one canonical "pool error
 * surface" the wrappers and ast guards detect together. Adding a new
 * error class adds it to the file AND to POOL_ERROR_NAMES.
 *
 * DOCTRINE: `worker-pool-fails-open-and-silent` (constitution sub-rule).
 * These errors are PROTOCOL SIGNALS, not exceptional bugs. Stack traces are
 * STRIPPED at construction so they cannot spam consumer error channels.
 * The 2026-05-28 incident saw 30 concurrent saturation errors × 188-line
 * stack traces overflow the daemon's hook response body — that class is
 * structurally impossible now: `error.stack === ""` for every instance.
 *
 * Consumers MUST treat these classes as "pool is saturated/closed, allow
 * through" — never `decision: block` or `pass: false`. The
 * `respondAllowOnPoolError` wrapper in `./server-wrappers.ts` is the
 * sanctioned way for HTTP consumers to enforce this; AST guards
 * (`no-pool-error-becomes-block`, `daemon-uses-respond-allow-wrapper`)
 * mechanically reject regressions.
 */

/**
 * Set on every saturation/lifecycle error class. The empty string is
 * V8-honored: `Error.captureStackTrace` and the default getter both yield
 * the same empty value, so consumers that JSON.stringify the error see
 * `stack: ""` (zero bytes) instead of a 30-frame trace.
 */
function stripStack(err: Error): void {
	// Direct assignment overrides the lazy v8 capture; subsequent reads
	// of .stack return this empty string.
	err.stack = "";
}

export class WorkerPoolQueueFullError extends Error {
	readonly code = "WORKER_POOL_QUEUE_FULL" as const;
	constructor(
		readonly poolName: string,
		readonly queueCap: number,
	) {
		super(
			`worker pool "${poolName}" queue full (cap=${queueCap}); shedding load`,
		);
		this.name = "WorkerPoolQueueFullError";
		stripStack(this);
	}
}

export class WorkerPoolTimeoutError extends Error {
	readonly code = "WORKER_POOL_TIMEOUT" as const;
	constructor(
		readonly poolName: string,
		readonly timeoutMs: number,
	) {
		super(`worker pool "${poolName}" task exceeded ${timeoutMs}ms`);
		this.name = "WorkerPoolTimeoutError";
		stripStack(this);
	}
}

export class WorkerPoolTerminatedError extends Error {
	readonly code = "WORKER_POOL_TERMINATED" as const;
	constructor(readonly poolName: string) {
		super(`worker pool "${poolName}" is terminated`);
		this.name = "WorkerPoolTerminatedError";
		stripStack(this);
	}
}

export class WorkerPoolWorkerCrashError extends Error {
	readonly code = "WORKER_POOL_WORKER_CRASH" as const;
	constructor(
		readonly poolName: string,
		readonly slotIndex: number,
		readonly exitCode: number,
	) {
		super(
			`worker pool "${poolName}" slot ${slotIndex} crashed (exit ${exitCode})`,
		);
		this.name = "WorkerPoolWorkerCrashError";
		stripStack(this);
	}
}

/**
 * Names of every error class that consumers MUST treat as fail-open.
 * Used by `isPoolError()` and `respondAllowOnPoolError()` to detect the
 * full set without per-class imports at every callsite. Adding a new
 * pool error class requires adding its name here AND the matching ast
 * guard in scala-guard catches it without case-by-case maintenance.
 */
export const POOL_ERROR_NAMES = new Set<string>([
	"WorkerPoolQueueFullError",
	"WorkerPoolTimeoutError",
	"WorkerPoolTerminatedError",
	"WorkerPoolWorkerCrashError",
]);

/**
 * Type guard: is this thrown value one of the pool's typed errors?
 * Consumers route to fail-open allow-through when true.
 */
export function isPoolError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return POOL_ERROR_NAMES.has(err.name);
}
