/**
 * @system worker-pool
 * @status handwritten
 * @edit edit directly
 *
 * Healthy worker fixture for pool.test.ts — stays alive + echoes every
 * request as a successful response. Confirms the crash-halt breaker does NOT
 * false-halt a pool whose workers stay up (no crash history accumulates).
 * Test fixture only; never imported by runtime code.
 */
self.onmessage = (event: MessageEvent) => {
	const req = event.data as { id: number } | null;
	if (req && typeof req.id === "number") {
		(self as unknown as { postMessage: (m: unknown) => void }).postMessage({
			id: req.id,
			ok: true,
			result: null,
		});
	}
};
