/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * HTTP server wrappers that enforce the fail-open contract for pool
 * consumers AT THE PROTOCOL BOUNDARY, before any consumer catch block runs.
 *
 * DOCTRINE: `worker-pool-fails-open-and-silent` invariant A. The 2026-05-28
 * incident saw consumer code (scala-guard runner.ts) catch a pool error
 * and convert it to `pass: false`, which became `decision: block` at the
 * hook boundary. The architectural fix: HTTP handlers wrap themselves in
 * this primitive so saturation NEVER reaches the consumer's catch block.
 * Consumer catch blocks become irrelevant for the typed-pool-error class.
 *
 * Pairs with AST guard `daemon-uses-respond-allow-wrapper` — daemons that
 * mount a worker pool but skip this wrapper are doctrine drift and fail
 * pre-commit.
 *
 * Usage:
 *
 *   import { respondAllowOnPoolError } from "./server-wrappers";
 *
 *   const server = Bun.serve({
 *     async fetch(req) {
 *       return respondAllowOnPoolError(() => handleRequest(req));
 *     },
 *   });
 *
 * The wrapper intercepts every typed pool error thrown anywhere in the
 * handler chain and returns the `allowResponse` (default `{}`). Any
 * non-pool error rethrows so genuine bugs still surface.
 */

import { isPoolError } from "./errors.ts";

export interface RespondAllowOptions {
	/**
	 * Body to return when a pool error is intercepted. Default `{}`
	 * matches the Claude Code PreToolUse hook's "no-op / allow" shape.
	 * Override for protocols with different allow semantics (e.g.
	 * ORPC may need `{ ok: true, skipped: "pool_saturated" }`).
	 */
	allowResponse?: unknown;
	/**
	 * Per-pool-error window throttled report. Returns truthy iff the
	 * caller should log this saturation event (most won't, per the
	 * non-spamming invariant). Default: drop silently — the pool itself
	 * emits the window-aggregated stderr line.
	 */
	onPoolError?: (err: Error) => void;
}

/**
 * Wraps a handler so that any typed pool error (saturation, timeout,
 * pool terminated, worker crash) returns the allow response instead of
 * propagating. Non-pool errors rethrow unchanged.
 *
 * Generic over the handler's return type — usable from any HTTP server
 * (Bun.serve, Hono, Elysia, raw Node), not just Bun.
 */
export async function respondAllowOnPoolError<T>(
	handler: () => Promise<T> | T,
	opts?: RespondAllowOptions,
): Promise<T | Response> {
	try {
		return await handler();
	} catch (err) {
		if (isPoolError(err) && err instanceof Error) {
			opts?.onPoolError?.(err);
			// Construct an allow response. Caller-provided `allowResponse`
			// wins; default empty-object body matches PreToolUse "no-op".
			const body = opts?.allowResponse ?? {};
			return Response.json(body) as T | Response;
		}
		throw err;
	}
}
