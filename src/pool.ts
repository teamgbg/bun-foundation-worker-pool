/**
 * @system worker-pool
 * @status handwritten @indivisible-unit owner=split-ts-primitives reason="single WorkerPool class: slots, bounded queue, timeout, crash-halt breaker and window-shed logging are one state machine (worker-pool-fails-open-and-silent)"
 * @edit edit directly
 *
 * WorkerPool — owns N Bun Worker threads, exposes `dispatch(payload)` that
 * returns a Promise resolving with the worker's reply. Implements:
 *
 *   - bounded queue with backpressure (rejects with WorkerPoolQueueFullError)
 *   - per-task timeout (rejects with WorkerPoolTimeoutError; terminates+respawns slot)
 *   - auto-respawn on worker close (consumer never sees a slot disappear)
 *   - registry auto-registration for central observability
 *
 * Uses Bun's native Worker API per https://bun.com/docs/runtime/workers — sub-µs
 * `postMessage` plain-object fast path. The pool owns slot lifecycle; consumers
 * own the worker entry script (the file at `workerScript` URL) and the shape
 * of `payload` + reply `result`.
 */

	/**
	 * Terminate a worker that has hit its task budget so the OS reclaims memory
	 * the JS GC cannot (see `maxTasksPerWorker`). Returns true when the slot was
	 * retired, in which case the caller must NOT keep using it — `close` fires
	 * and respawns a fresh worker that picks the queue back up.
	 *
	 * Only ever recycles an IDLE slot, and never the last usable one: retiring a
	 * worker mid-task would reject live work, and retiring the only live slot
	 * would leave the pool momentarily unable to serve, which for a gate means
	 * failing open. Correctness first, memory second.
	 */

import {
	WorkerPoolQueueFullError,
	WorkerPoolTerminatedError,
	WorkerPoolTimeoutError,
	WorkerPoolWorkerCrashError,
} from "./errors.ts";
import { workerPoolRegistry } from "./registry.ts";
import type {
	DispatchOptions,
	WorkerPoolOptions,
	WorkerPoolStats,
	WorkerRequest,
	WorkerResponse,
} from "./types.ts";

/**
 * How long a recycling slot may wait for its `close` event before the pool
 * respawns it anyway. Short, because until it lands the slot is out of
 * dispatch and the pool is running below capacity.
 */
const RECYCLE_CLOSE_TIMEOUT_MS = 5_000;

interface Slot {
	index: number;
	worker: Worker;
	busy: boolean;
	currentId: number | null;
	/**
	 * Crash-halted slots are no longer respawned + drop out of the dispatch
	 * rotation. Set in handleWorkerClose when the per-slot crash limit is hit.
	 */
	dead: boolean;
	/** Tasks this worker has completed since it spawned. */
	tasksCompleted: number;
	/**
	 * Set when the slot is being terminated DELIBERATELY to reclaim memory, so
	 * `handleWorkerClose` respawns it without charging the crash breaker. A
	 * recycle is healthy behaviour; counting it as a crash would crash-halt a
	 * perfectly good pool.
	 */
	recycling: boolean;
}

interface PendingTask {
	id: number;
	payload: unknown;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timeoutMs: number;
	timer: ReturnType<typeof setTimeout> | null;
	slotIndex: number | null;
}

export class WorkerPool {
	readonly name: string;
	readonly workerScript: string;
	readonly size: number;
	readonly queueCap: number;
	readonly taskTimeoutMs: number;
	readonly smol: boolean;
	readonly preload: string | string[] | undefined;
	/** Crash-halt breaker thresholds (no-uncontrolled-repetition-or-cascade). */
	readonly maxRespawns: number;
	readonly crashWindowMs: number;
	readonly maxTasksPerWorker: number;

	private slots: Slot[] = [];
	private queue: PendingTask[] = [];
	private pending = new Map<number, PendingTask>();
	private nextId = 1;
	private terminated = false;

	// counters for observability
	private dispatched = 0;
	private failed = 0;
	private respawned = 0;
	private lastError: string | null = null;

	/**
	 * Crash-halt breaker: per-slot-index rolling timestamp history of worker
	 * closes (crashes). Kept by INDEX so it survives the slot object being
	 * replaced across respawns — consecutive boot-crashes of the SAME slot
	 * position accumulate toward the limit. Pruned to crashWindowMs.
	 */
	private crashHistory: number[][] = [];

	// Window-aggregated saturation reporting. Per `worker-pool-fails-open-and-silent`
	// (constitution sub-rule): the pool MUST log at most one line per
	// POOL_SHED_LOG_WINDOW_MS per pool name, no matter how many tasks
	// were shed. Per-task stderr is the spam class this prevents.
	private shedCountInWindow = 0;
	private shedWindowStartMs = 0;
	private static readonly POOL_SHED_LOG_WINDOW_MS = 5000;

	constructor(opts: WorkerPoolOptions) {
		const size =
			opts.size ?? Math.max(1, Number(navigator?.hardwareConcurrency ?? 1));
		const queueCap = opts.queueCap ?? size * 4;
		this.name = opts.name;
		this.workerScript = opts.workerScript;
		this.size = size;
		this.queueCap = queueCap;
		this.taskTimeoutMs = opts.taskTimeoutMs ?? 300_000;
		this.smol = opts.smol ?? false;
		this.preload = opts.preload;
		// 0 = unlimited, preserving the previous behaviour for every consumer
		// that does not opt in.
		this.maxTasksPerWorker = opts.maxTasksPerWorker ?? 0;
		this.maxRespawns = opts.maxRespawns ?? 5;
		this.crashWindowMs = opts.crashWindowMs ?? 30_000;

		for (let i = 0; i < size; i++) {
			this.crashHistory.push([]);
			this.slots.push(this.spawnSlot(i));
		}

		workerPoolRegistry.register(this);
	}

	private spawnSlot(index: number): Slot {
		const workerOpts: WorkerOptions & {
			smol?: boolean;
			preload?: string | string[];
		} = {};
		if (this.smol) workerOpts.smol = true;
		if (this.preload) workerOpts.preload = this.preload;

		const worker = new Worker(this.workerScript, workerOpts);
		// Warm-but-unref'd: an idle worker must not hold the parent's event
		// loop. The pool-cache reuse model (executor-dispatch) keeps pools
		// alive for the process lifetime by design — correct for daemons,
		// fatal for CLIs, which completed their work but never exited
		// because live Workers ref the loop (the 2026-06-05 fixa
		// completes-but-never-exits class). ref() is re-armed per task in
		// assignToSlot and dropped again at idle in maybeUnrefAll.
		(worker as { unref?: () => void }).unref?.();
		const slot: Slot = {
			index,
			worker,
			busy: false,
			currentId: null,
			dead: false,
			tasksCompleted: 0,
			recycling: false,
		};

		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			this.handleWorkerResponse(slot, event.data);
		};
		worker.onerror = (event: ErrorEvent) => {
			const msg = event.message ?? "worker error event";
			this.lastError = `slot ${index}: ${msg}`;
			// Don't terminate on bare error — let close handler decide.
		};
		worker.addEventListener("close", (event) => {
			const exitCode = (event as CloseEvent).code ?? 0;
			this.handleWorkerClose(slot, exitCode);
		});

		return slot;
	}

	private handleWorkerResponse(slot: Slot, msg: WorkerResponse): void {
		const task = this.pending.get(msg.id);
		if (!task) {
			// Late reply after timeout already rejected — drop.
			slot.busy = false;
			slot.currentId = null;
			this.drainQueue(slot);
			return;
		}

		this.pending.delete(msg.id);
		if (task.timer) clearTimeout(task.timer);
		slot.busy = false;
		slot.currentId = null;

		if (msg.ok) {
			task.resolve(msg.result);
		} else {
			this.failed++;
			this.lastError = msg.error ?? "worker returned ok=false";
			task.reject(new Error(msg.error ?? "worker error"));
		}

		slot.tasksCompleted++;
		if (this.maybeRecycle(slot)) {
			// Do NOT strand queued work behind the respawn. `drainQueue` only feeds
			// the slot handed to it, and a recycling slot is excluded from
			// selection, so returning here without redistributing leaves queued
			// tasks waiting on a `close` event — and if that event is slow or never
			// arrives, the pool stops serving while every process check still says
			// it is fine. That is a HANG, which for a gate is worse than a crash:
			// the daemon stays PM2-online and unreachable, so hooks fail open and
			// lanes stop unjudged (observed 2026-07-26, RSS climbing while /health
			// did not answer).
			for (const other of this.slots) {
				if (!other.busy && !other.dead && !other.recycling) this.drainQueue(other);
			}
			return;
		}

		this.drainQueue(slot);
		this.maybeUnrefAll();
	}

	private maybeRecycle(slot: Slot): boolean {
		if (this.maxTasksPerWorker <= 0) return false;
		if (slot.tasksCompleted < this.maxTasksPerWorker) return false;
		if (slot.busy || slot.recycling || slot.dead || this.terminated) return false;
		const alive = this.slots.filter((s) => !s.dead && !s.recycling).length;
		if (alive <= 1 && this.size > 1) return false;

		slot.recycling = true;
		// A slot that never receives its `close` event stays `recycling` forever
		// and is permanently excluded from dispatch — the pool silently shrinks
		// until it serves nothing. The class the file already warns about for
		// leaked slots, reintroduced by recycling unless it is bounded. If close
		// has not landed in time, respawn the slot anyway; a duplicate respawn is
		// harmless (the stale worker is already terminated) whereas a lost slot is
		// not.
		const recycleGuard = setTimeout(() => {
			if (!slot.recycling || this.terminated) return;
			if (this.slots[slot.index] !== slot) return;
			this.respawned++;
			const replacement = this.spawnSlot(slot.index);
			this.slots[slot.index] = replacement;
			this.drainQueue(replacement);
		}, RECYCLE_CLOSE_TIMEOUT_MS);
		(recycleGuard as { unref?: () => void }).unref?.();
		try {
			slot.worker.terminate();
		} catch {
			// A worker that is already gone still needs its close handler to
			// respawn the slot; nothing to do here.
		}
		return true;
	}

	private handleWorkerClose(slot: Slot, exitCode: number): void {
		// Reject in-flight task on this slot.
		const inflightId = slot.currentId;
		if (inflightId !== null) {
			const task = this.pending.get(inflightId);
			if (task) {
				this.pending.delete(inflightId);
				if (task.timer) clearTimeout(task.timer);
				this.failed++;
				const err = new WorkerPoolWorkerCrashError(
					this.name,
					slot.index,
					exitCode,
				);
				this.lastError = err.message;
				task.reject(err);
			}
		}

		if (this.terminated) return;

		// A DELIBERATE recycle is not a crash and must not be charged to the
		// breaker — otherwise a healthy pool that recycles on schedule would
		// crash-halt its own slots and degrade to fail-open, turning a memory fix
		// into an availability bug.
		if (slot.recycling) {
			this.respawned++;
			const recycled = this.spawnSlot(slot.index);
			this.slots[slot.index] = recycled;
			this.drainQueue(recycled);
			return;
		}

		// Crash-halt breaker (no-uncontrolled-repetition-or-cascade): record
		// this close in the per-index rolling history; if the slot has crashed
		// maxRespawns times within crashWindowMs, STOP respawning it. A worker
		// whose entry crashes on boot would otherwise respawn forever — an
		// in-process crash-loop the PM2/loga supervisor cannot see (it restarts
		// the DAEMON, not the daemon's worker threads). The dead slot drops out
		// of the dispatch rotation; under load the queue fills →
		// WorkerPoolQueueFullError → fail-open (worker-pool-fails-open-and-silent),
		// so the daemon survives in degraded mode instead of churning.
		const now = Date.now();
		const hist = this.crashHistory[slot.index]!;
		hist.push(now);
		const cutoff = now - this.crashWindowMs;
		while (hist.length > 0 && hist[0]! < cutoff) hist.shift();
		if (hist.length > this.maxRespawns) {
			if (!slot.dead) {
				slot.dead = true;
				this.lastError = `slot ${slot.index} crash-halted after ${hist.length} crashes in ${this.crashWindowMs}ms — worker script crash-loop; slot disabled (dispatches fail-open)`;
				process.stderr.write(
					`[pool=${this.name}] slot ${slot.index} crash-halted after ${hist.length} crashes in ${this.crashWindowMs}ms — worker script is crash-looping; slot disabled, dispatches fail-open per no-uncontrolled-repetition-or-cascade\n`,
				);
			}
			return;
		}

		// Respawn the slot. The new worker takes the next queued task.
		this.respawned++;
		const newSlot = this.spawnSlot(slot.index);
		this.slots[slot.index] = newSlot;
		this.drainQueue(newSlot);
	}

	/**
	 * Record one shed task. Emits AT MOST one aggregate log line per pool
	 * per POOL_SHED_LOG_WINDOW_MS window — no matter how many tasks were
	 * rejected. Per-task logging is the doctrine violation this method
	 * structurally prevents. Doctrine: `worker-pool-fails-open-and-silent`
	 * invariant B.
	 */
	private recordShed(): void {
		const now = Date.now();
		if (this.shedWindowStartMs === 0) {
			this.shedWindowStartMs = now;
			this.shedCountInWindow = 1;
			return;
		}
		const windowElapsed = now - this.shedWindowStartMs;
		if (windowElapsed >= WorkerPool.POOL_SHED_LOG_WINDOW_MS) {
			// Flush the previous window with its aggregate count; start a new window.
			process.stderr.write(
				`[pool=${this.name}] shed ${this.shedCountInWindow} task(s) in ${windowElapsed}ms (queueCap=${this.queueCap}, size=${this.size})\n`,
			);
			this.shedWindowStartMs = now;
			this.shedCountInWindow = 1;
			return;
		}
		// Within window — just count, no log.
		this.shedCountInWindow++;
	}

	private drainQueue(slot: Slot): void {
		if (this.terminated) return;
		if (slot.busy) return;
		const next = this.queue.shift();
		if (!next) return;
		this.assignToSlot(slot, next);
	}

	private maybeUnrefAll(): void {
		if (this.pending.size > 0) return;
		for (const slot of this.slots) {
			(slot.worker as { unref?: () => void }).unref?.();
		}
	}

	private assignToSlot(slot: Slot, task: PendingTask): void {
		(slot.worker as { ref?: () => void }).ref?.();
		slot.busy = true;
		slot.currentId = task.id;
		task.slotIndex = slot.index;

		// Arm timeout
		task.timer = setTimeout(() => {
			const pending = this.pending.get(task.id);
			if (!pending) return;
			this.pending.delete(task.id);
			this.failed++;
			const err = new WorkerPoolTimeoutError(this.name, task.timeoutMs);
			this.lastError = err.message;
			task.reject(err);
			// Terminate the wedged worker — it's still processing the task.
			// handleWorkerClose will respawn the slot.
			try {
				slot.worker.terminate();
			} catch {
				// already terminating
			}
		}, task.timeoutMs);

		const req: WorkerRequest = { id: task.id, payload: task.payload };
		slot.worker.postMessage(req);
	}

	/**
	 * Dispatch a task to the pool. Resolves with the worker's reply. Rejects
	 * with a typed pool error (queue full, timeout, worker crash, pool
	 * terminated). Consumers translate to protocol-level responses (HTTP
	 * 429 / 503 / ORPC error code) at their own boundary.
	 */
	dispatch<R = unknown>(payload: unknown, opts?: DispatchOptions): Promise<R> {
		if (this.terminated) {
			return Promise.reject(new WorkerPoolTerminatedError(this.name));
		}

		this.dispatched++;
		const id = this.nextId++;
		const timeoutMs = opts?.timeoutMs ?? this.taskTimeoutMs;

		return new Promise<R>((resolve, reject) => {
			const task: PendingTask = {
				id,
				payload,
				resolve: resolve as (value: unknown) => void,
				reject,
				timeoutMs,
				timer: null,
				slotIndex: null,
			};
			this.pending.set(id, task);

			// A RECYCLING slot is mid-terminate: it still looks idle, but any task
			// assigned to it dies on close with WorkerPoolWorkerCrashError. It must
			// drop out of selection exactly like a dead one.
			const idleSlot = this.slots.find((s) => !s.busy && !s.dead && !s.recycling);
			if (idleSlot) {
				this.assignToSlot(idleSlot, task);
				return;
			}

			if (this.queue.length >= this.queueCap) {
				this.pending.delete(id);
				this.failed++;
				const err = new WorkerPoolQueueFullError(this.name, this.queueCap);
				this.lastError = err.message;
				this.recordShed();
				reject(err);
				return;
			}

			this.queue.push(task);
		});
	}

	stats(): WorkerPoolStats {
		return {
			name: this.name,
			size: this.size,
			busy: this.slots.filter((s) => s.busy && !s.dead).length,
			idle: this.slots.filter((s) => !s.busy && !s.dead && !s.recycling).length,
			halted: this.slots.filter((s) => s.dead).length,
			queueDepth: this.queue.length,
			queueCap: this.queueCap,
			dispatched: this.dispatched,
			failed: this.failed,
			respawned: this.respawned,
			lastError: this.lastError,
		};
	}

	/**
	 * Terminate the pool. In-flight tasks reject with
	 * `WorkerPoolTerminatedError`; queued tasks reject before dispatch.
	 * Idempotent.
	 */
	terminate(): void {
		if (this.terminated) return;
		this.terminated = true;

		// Reject queued tasks first
		for (const task of this.queue) {
			this.pending.delete(task.id);
			if (task.timer) clearTimeout(task.timer);
			task.reject(new WorkerPoolTerminatedError(this.name));
		}
		this.queue = [];

		// Reject in-flight tasks; terminate workers
		for (const slot of this.slots) {
			if (slot.currentId !== null) {
				const task = this.pending.get(slot.currentId);
				if (task) {
					this.pending.delete(slot.currentId);
					if (task.timer) clearTimeout(task.timer);
					task.reject(new WorkerPoolTerminatedError(this.name));
				}
			}
			try {
				slot.worker.terminate();
			} catch {
				// already gone
			}
		}

		workerPoolRegistry.unregister(this.name);
	}
}
