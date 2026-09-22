// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { createWorkerPool } from "./create-worker-pool.ts";

const CRASH_WORKER = new URL("./crash-on-boot.worker.ts", import.meta.url).href;

/** Poll until cond or timeout — the crash-loop + halt is async. */
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

test("crash-halt breaker stops respawning a crash-looping slot", async () => {
	const pool = createWorkerPool({
		name: "test:crash-halt",
		workerScript: CRASH_WORKER,
		size: 1,
		queueCap: 1,
		maxRespawns: 3,
		crashWindowMs: 60_000,
		taskTimeoutMs: 500,
	});
	try {
		const halted = await waitFor(() => pool.stats().halted >= 1, 6_000);
		expect(halted).toBe(true);
		const s = pool.stats();
		// 3 respawns permitted, then halt on the 4th crash.
		expect(s.respawned).toBe(3);
		expect(s.halted).toBe(1);
		// The dead slot is out of the rotation: zero live idle slots.
		expect(s.idle).toBe(0);
		expect(s.lastError).toContain("crash-halted");
	} finally {
		pool.terminate();
	}
}, 12_000);

test("a healthy pool never trips the breaker", async () => {
	// A worker that stays up does not accumulate crash history, so the breaker
	// never fires — confirms the default (maxRespawns=5) doesn't false-halt.
	const pool = createWorkerPool({
		name: "test:crash-halt-healthy",
		workerScript: new URL("./echo.worker.ts", import.meta.url).href,
		size: 1,
	});
	// The echo worker stays up (no crashes), so no history accumulates + the
	// breaker stays inert — confirms the default doesn't false-halt.
	await new Promise((r) => setTimeout(r, 150));
	expect(pool.stats().halted).toBe(0);
	pool.terminate();
}, 5_000);

test("maxTasksPerWorker recycles a worker once it hits its task budget", async () => {
	// The point of the option: a long-lived worker holding native arena pages the
	// JS GC cannot see is only reclaimed by the worker EXITING.
	const pool = createWorkerPool({
		name: "test:recycle",
		workerScript: new URL("./echo.worker.ts", import.meta.url).href,
		size: 2,
		maxTasksPerWorker: 2,
	});
	for (let i = 0; i < 8; i++) {
		expect(await pool.dispatch({ echo: i })).toBeNull();
	}
	// terminate() is async: the respawn is counted on the worker's `close`
	// event, so settle before asserting.
	await new Promise((r) => setTimeout(r, 200));
	// Respawns prove workers were retired and replaced, not merely reused.
	expect(pool.stats().respawned).toBeGreaterThan(0);
	pool.terminate();
}, 10_000);

test("recycling does NOT crash-halt the pool", async () => {
	// A recycle charged to the crash breaker would disable slots and send
	// dispatches fail-open — a memory fix turned into an availability bug.
	const pool = createWorkerPool({
		name: "test:recycle-not-crash",
		workerScript: new URL("./echo.worker.ts", import.meta.url).href,
		size: 2,
		maxTasksPerWorker: 1,
		maxRespawns: 2,
		crashWindowMs: 60_000,
	});
	for (let i = 0; i < 10; i++) {
		expect(await pool.dispatch({ echo: i })).toBeNull();
	}
	expect(pool.stats().halted).toBe(0);
	// Still serving after far more recycles than maxRespawns.
	expect(await pool.dispatch({ echo: "final" })).toBeNull();
	pool.terminate();
}, 10_000);

test("maxTasksPerWorker unset means unlimited — existing consumers unaffected", async () => {
	const pool = createWorkerPool({
		name: "test:no-recycle",
		workerScript: new URL("./echo.worker.ts", import.meta.url).href,
		size: 1,
	});
	for (let i = 0; i < 5; i++) await pool.dispatch({ echo: i });
	expect(pool.stats().respawned).toBe(0);
	pool.terminate();
}, 10_000);

test("a recycling slot never strands queued work (the hang class)", async () => {
	// The failure this pins: on recycle the handler returns early, and a
	// recycling slot is excluded from dispatch selection. Without redistributing,
	// queued tasks wait on a `close` event — and if that is slow the pool stops
	// serving while every process check still says it is fine. For a gate that
	// hang is worse than a crash, because hooks fail open and lanes stop
	// unjudged. Every dispatch here must settle.
	const pool = createWorkerPool({
		name: "test:recycle-no-strand",
		workerScript: new URL("./echo.worker.ts", import.meta.url).href,
		size: 2,
		maxTasksPerWorker: 1,
		// Above the default 4x cap so this exercises RECYCLING rather than
		// backpressure — queue-full shedding is a separate, already-tested path.
		queueCap: 64,
	});
	const results = await Promise.all(
		Array.from({ length: 24 }, (_, i) => pool.dispatch({ echo: i })),
	);
	expect(results.length).toBe(24);
	// Pool still serves after all that recycling — no slot left stranded.
	expect(await pool.dispatch({ echo: "after" })).toBeNull();
	expect(pool.stats().halted).toBe(0);
	pool.terminate();
}, 20_000);
