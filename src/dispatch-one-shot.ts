/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * One-shot worker dispatch. Spawns a Bun Worker per call, the worker
 * processes the task then terminates automatically per Bun's documented
 * pattern ("A Worker instance terminates automatically once its event loop
 * has no work left to do"). Avoids keeping heavy transitive deps (ts-morph,
 * jsdom, Prisma client, full transform engines) in memory between requests.
 *
 * Worker startup on a warm JIT cache is ~5-15ms — negligible compared to
 * typical guard or codegen runs taking 5-60s.
 *
 * Use instead of createWorkerPool when:
 *   - Requests are infrequent (seconds to minutes apart)
 *   - The worker loads heavy dependencies (TypeScript compiler, DOM, DB driver)
 *   - Keeping a persistent pool's memory is wasteful for the request rate
 *
 * Use createWorkerPool when:
 *   - Requests arrive at high frequency (multiple per second)
 *   - The worker is lightweight (no heavy imports per invocation)
 *   - Sub-millisecond dispatch latency matters
 *
 * Per `one-shot-worker-default` in doctrine: guard daemons and codegen
 * daemons MUST use dispatchOneShot. Services with high-throughput workers
 * MAY use createWorkerPool.
 */

import { WorkerPoolTimeoutError } from "./errors.ts";
import type { WorkerRequest, WorkerResponse } from "./types.ts";

export interface OneShotOptions {
	/** Per-task wall-clock budget in ms. Default 300_000 (5 min). */
	timeoutMs?: number;
	/** Memory-conscious mode per Bun docs. Default true. */
	smol?: boolean;
}

/**
 * Dispatch a single task to a one-shot worker. The worker loads the script,
 * processes the payload, posts back the result, then terminates — freeing
 * all memory. Worker startup cost is ~5-15ms on a warm JIT cache.
 */
export function dispatchOneShot<R = unknown>(
	workerScript: string,
	payload: unknown,
	opts?: OneShotOptions,
): Promise<R> {
	const timeoutMs = opts?.timeoutMs ?? 300_000;
	const smol = opts?.smol ?? true;

	const worker = new Worker(workerScript, { smol });

	return new Promise<R>((resolve, reject) => {
		// The promise settles exactly once. A `close` arriving BEFORE any
		// result/error MUST reject — otherwise a worker that terminates without
		// posting (a hard crash, or Bun auto-terminating an event loop it deems
		// idle mid-task) leaves this promise pending forever, and the caller's
		// `await dispatchOneShot` resolves `undefined` → an empty/statusless
		// result downstream. Settling on close turns that silent failure into a
		// diagnosable rejection.
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const finishResolve = (r: R) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(r);
		};
		const finishReject = (e: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(e);
		};

		timer = setTimeout(() => {
			worker.terminate();
			finishReject(new WorkerPoolTimeoutError("one-shot", timeoutMs));
		}, timeoutMs);

		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const data = event.data;
			// Explicitly terminate now — the close event listener keeps the
			// event loop alive and prevents Bun's auto-termination.
			worker.terminate();
			if (data.ok) {
				finishResolve(data.result as R);
			} else {
				finishReject(new Error(data.error ?? "worker error"));
			}
		};

		// unref the worker so it doesn't keep the parent process alive.
		(worker as { unref?: () => void }).unref?.();

		worker.onerror = (event) => {
			finishReject(new Error(event.message ?? "worker error event"));
		};

		worker.addEventListener("close", () => {
			finishReject(
				new Error(
					"one-shot worker closed without posting a result (crashed or terminated before completing its task)",
				),
			);
		});

		const req: WorkerRequest = { id: 1, payload };
		worker.postMessage(req);
	});
}