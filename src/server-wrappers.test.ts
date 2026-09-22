// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import {
	WorkerPoolQueueFullError,
	WorkerPoolTerminatedError,
	WorkerPoolTimeoutError,
	WorkerPoolWorkerCrashError,
} from "./errors.ts";
import { respondAllowOnPoolError } from "./server-wrappers.ts";

test("queue-full error becomes empty-object allow response", async () => {
	const resp = (await respondAllowOnPoolError(() => {
		throw new WorkerPoolQueueFullError("test-pool", 64);
	})) as Response;
	expect(resp).toBeInstanceOf(Response);
	const body = await resp.json();
	expect(body).toEqual({});
});

test("timeout error becomes allow response", async () => {
	const resp = (await respondAllowOnPoolError(() => {
		throw new WorkerPoolTimeoutError("test-pool", 5000);
	})) as Response;
	const body = await resp.json();
	expect(body).toEqual({});
});

test("terminated error becomes allow response", async () => {
	const resp = (await respondAllowOnPoolError(() => {
		throw new WorkerPoolTerminatedError("test-pool");
	})) as Response;
	const body = await resp.json();
	expect(body).toEqual({});
});

test("worker-crash error becomes allow response", async () => {
	const resp = (await respondAllowOnPoolError(() => {
		throw new WorkerPoolWorkerCrashError("test-pool", 0, 137);
	})) as Response;
	const body = await resp.json();
	expect(body).toEqual({});
});

test("100 concurrent queue-full errors all become allow (saturation never blocks)", async () => {
	// THE 2026-05-28 INCIDENT FIXTURE: prior to the fix, this scenario
	// produced 100× decision:block with 100× stack-trace concatenated
	// into the hook's permissionDecisionReason — the 188-line spam.
	// After the fix, every one returns {} with no error body.
	const results = await Promise.all(
		Array.from({ length: 100 }, () =>
			respondAllowOnPoolError(() => {
				throw new WorkerPoolQueueFullError("test-pool", 64);
			}),
		),
	);
	expect(results.length).toBe(100);
	for (const r of results) {
		expect(r).toBeInstanceOf(Response);
		const body = await (r as Response).json();
		expect(body).toEqual({});
	}
});

test("non-pool errors rethrow unchanged (genuine bugs still surface)", async () => {
	const realBug = new Error("a real bug, not saturation");
	let caught: unknown = null;
	try {
		await respondAllowOnPoolError(() => {
			throw realBug;
		});
	} catch (err) {
		caught = err;
	}
	expect(caught).toBe(realBug);
});

test("TypeError rethrows unchanged", async () => {
	let caught: unknown = null;
	try {
		await respondAllowOnPoolError(() => {
			throw new TypeError("really bad");
		});
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(TypeError);
});

test("custom allowResponse honored when provided", async () => {
	const resp = (await respondAllowOnPoolError(
		() => {
			throw new WorkerPoolQueueFullError("test-pool", 64);
		},
		{ allowResponse: { ok: true, skipped: "pool_saturated" } },
	)) as Response;
	const body = await resp.json();
	expect(body).toEqual({ ok: true, skipped: "pool_saturated" });
});

test("onPoolError callback fires for typed errors only", async () => {
	let calls = 0;
	await respondAllowOnPoolError(
		() => {
			throw new WorkerPoolQueueFullError("test-pool", 64);
		},
		{ onPoolError: () => calls++ },
	);
	expect(calls).toBe(1);

	try {
		await respondAllowOnPoolError(
			() => {
				throw new Error("not a pool error");
			},
			{ onPoolError: () => calls++ },
		);
	} catch {}
	expect(calls).toBe(1); // unchanged — callback not invoked for non-pool errors
});

test("successful handler returns its value unchanged", async () => {
	const result = await respondAllowOnPoolError(() =>
		Promise.resolve(Response.json({ ok: true })),
	);
	expect(result).toBeInstanceOf(Response);
	const body = await (result as Response).json();
	expect(body).toEqual({ ok: true });
});
