/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * Public types for @teamscala/worker-pool.
 */

	/**
	 * Crash-halt breaker (`no-uncontrolled-repetition-or-cascade`): the max
	 * number of times a single slot may be respawned within `crashWindowMs`
	 * before the pool STOPs respawning it. A worker whose entry script
	 * crashes on boot would otherwise be respawned forever (an in-process
	 * crash-loop the PM2/loga supervisor cannot see — it restarts the DAEMON,
	 * not the daemon's worker threads). On reaching the limit the slot is
	 * marked dead: it drops out of the dispatch rotation, so under load the
	 * queue fills and dispatches reject with `WorkerPoolQueueFullError` →
	 * fail-open per `worker-pool-fails-open-and-silent` (the daemon survives
	 * in degraded mode instead of churning). Default `5`.
	 */
	/**
	 * Recycle a worker after it completes this many tasks (0 = unlimited, the
	 * default, so existing consumers are unaffected).
	 *
	 * WHY (2026-07-26): native addons that allocate through a Rust/NAPI arena —
	 * oxc-parser is the one that bites here — hold pages the JS GC cannot see, so
	 * a LONG-LIVED worker's RSS only ever grows and ONLY PROCESS EXIT reclaims it
	 * (bun#5709). Measured on scala-sentinel: ~3.5MB leaked per tool-check and
	 * ~8.7MB per turn-end, climbing to 2031MB, at which point it trips its
	 * maxMemoryRestart ceiling and drops enforcement for every pane.
	 *
	 * Doctrine already answers this for one-off heavy passes by running them in a
	 * subprocess that EXITS (native-loader-workers-split-by-workload-weight). A
	 * persistent pool cannot exit, so the same reclamation is achieved by giving
	 * each worker a bounded lifetime. This makes unbounded growth structurally
	 * impossible rather than monitored, which is what prevention-over-detection
	 * requires; a memory ceiling or an auto-restart would only paper over it.
	 */

export interface WorkerPoolOptions {
	/**
	 * Pool identity. Convention: `<system>:<purpose>` (e.g.
	 * `scala-guard:validators`, `service-runtime:ssr`). Duplicate names in
	 * one process throw at construction.
	 */
	name: string;

	/**
	 * URL to the worker script. Use
	 * `new URL("./<file>.ts", import.meta.url).href` from the consumer.
	 */
	workerScript: string;

	/**
	 * Number of worker threads. Defaults to
	 * `navigator.hardwareConcurrency` (= os.cpus().length on Bun). Override
	 * to a lower count when the host process also serves HTTP and main-loop
	 * contention matters (e.g. `cpus - 1`).
	 */
	size?: number;

	/**
	 * Bounded queue depth. When a `dispatch()` finds all workers busy AND
	 * the queue already holds `queueCap` tasks, the dispatch rejects with
	 * `WorkerPoolQueueFullError`. Default `4 × size`. Unbounded queues are
	 * prohibited per `worker-pool-is-the-only-worker-pool` rule 4.
	 */
	queueCap?: number;

	/**
	 * Per-task wall-clock budget in ms. A worker that does not reply
	 * within this window has its task rejected with
	 * `WorkerPoolTimeoutError`; the worker is terminated and respawned.
	 * Default `300_000` (5 min).
	 */
	taskTimeoutMs?: number;

	/**
	 * Memory-conscious mode. Passed through to `new Worker(url, { smol })`
	 * per Bun's docs (https://bun.com/docs/runtime/workers#memory-usage-with-smol).
	 * Use when many small pools coexist in one process.
	 */
	smol?: boolean;

	/**
	 * Modules to preload before the worker entry script runs. Passed
	 * through to `new Worker(url, { preload })`. Use for OpenTelemetry,
	 * Sentry, or other instrumentation that MUST attach before
	 * application code imports.
	 */
	preload?: string | string[];

	maxTasksPerWorker?: number;

	maxRespawns?: number;

	/**
	 * Rolling window for the crash-halt breaker (see `maxRespawns`). Crashes
	 * older than this are pruned, so a slot that crashed repeatedly then
	 * stabilized is NOT permanently dead. Default `30_000` (30s).
	 */
	crashWindowMs?: number;
}

export interface WorkerPoolStats {
	name: string;
	size: number;
	busy: number;
	idle: number;
	/** Slots crash-halted by the breaker (no-uncontrolled-repetition-or-cascade). */
	halted: number;
	queueDepth: number;
	queueCap: number;
	dispatched: number;
	failed: number;
	respawned: number;
	lastError: string | null;
}

export interface DispatchOptions {
	/**
	 * Override the pool's default `taskTimeoutMs` for this single task.
	 */
	timeoutMs?: number;
}

/**
 * Internal: messages exchanged with worker threads.
 *
 * The protocol is intentionally minimal — `id` correlates request/response;
 * `payload` and `result` are caller-defined. Bun's `postMessage` plain-object
 * fast path serialises in ~1.26µs for 3MB payloads, so per-task payload
 * duplication is acceptable; consumers do not need to share state via
 * `setEnvironmentData`.
 */
export interface WorkerRequest {
	id: number;
	payload: unknown;
}

export interface WorkerResponse {
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string;
}
