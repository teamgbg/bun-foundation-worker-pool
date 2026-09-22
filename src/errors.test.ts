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
	isPoolError,
	POOL_ERROR_NAMES,
	WorkerPoolQueueFullError,
	WorkerPoolTerminatedError,
	WorkerPoolTimeoutError,
	WorkerPoolWorkerCrashError,
} from "./errors.ts";

test("WorkerPoolQueueFullError has no stack trace", () => {
	const err = new WorkerPoolQueueFullError("test-pool", 64);
	expect(err.stack).toBe("");
	expect(err.message).toContain("queue full");
	expect(err.name).toBe("WorkerPoolQueueFullError");
});

test("WorkerPoolTimeoutError has no stack trace", () => {
	const err = new WorkerPoolTimeoutError("test-pool", 5000);
	expect(err.stack).toBe("");
});

test("WorkerPoolTerminatedError has no stack trace", () => {
	const err = new WorkerPoolTerminatedError("test-pool");
	expect(err.stack).toBe("");
});

test("WorkerPoolWorkerCrashError has no stack trace", () => {
	const err = new WorkerPoolWorkerCrashError("test-pool", 0, 137);
	expect(err.stack).toBe("");
});

test("100 saturation errors produce 100 empty stacks (no spam)", () => {
	// Doctrine `worker-pool-fails-open-and-silent` invariant B: the entire
	// CLASS of saturation errors must produce zero stack traces, period.
	// This is the mechanical guard against the 2026-05-28 incident where
	// 30 concurrent errors × 188-line stack traces produced the storm.
	const errors: WorkerPoolQueueFullError[] = [];
	for (let i = 0; i < 100; i++) {
		errors.push(new WorkerPoolQueueFullError("test-pool", 64));
	}
	const totalStackBytes = errors.reduce(
		(sum, e) => sum + (e.stack ?? "").length,
		0,
	);
	expect(totalStackBytes).toBe(0);
});

test("POOL_ERROR_NAMES covers every exported error class", () => {
	// If a new error class is added without registering its name here,
	// isPoolError() misses it and consumer wrappers won't fail-open.
	const classes = [
		new WorkerPoolQueueFullError("x", 1).name,
		new WorkerPoolTimeoutError("x", 1).name,
		new WorkerPoolTerminatedError("x").name,
		new WorkerPoolWorkerCrashError("x", 0, 0).name,
	];
	for (const name of classes) {
		expect(POOL_ERROR_NAMES.has(name)).toBe(true);
	}
});

test("isPoolError() matches every typed pool error", () => {
	expect(isPoolError(new WorkerPoolQueueFullError("x", 1))).toBe(true);
	expect(isPoolError(new WorkerPoolTimeoutError("x", 1))).toBe(true);
	expect(isPoolError(new WorkerPoolTerminatedError("x"))).toBe(true);
	expect(isPoolError(new WorkerPoolWorkerCrashError("x", 0, 0))).toBe(true);
});

test("isPoolError() rejects unrelated errors", () => {
	expect(isPoolError(new Error("something else"))).toBe(false);
	expect(isPoolError(new TypeError("wrong type"))).toBe(false);
	expect(isPoolError("not an error")).toBe(false);
	expect(isPoolError(null)).toBe(false);
});
