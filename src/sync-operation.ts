import { performance } from "node:perf_hooks";

export type FailureCode = "network" | "http" | "invalid" | "timeout" | "cancelled" | "state" | "license";
export class SyncFailure extends Error {
  constructor(readonly code: FailureCode, readonly httpStatus?: number) {
    super(`Skill synchronization failed: ${code}`);
    this.name = "SyncFailure";
  }
}

export function failureCode(error: unknown, signal?: AbortSignal): FailureCode {
  if (signal?.aborted) return signal.reason instanceof SyncFailure ? signal.reason.code : "cancelled";
  return error instanceof SyncFailure ? error.code : "invalid";
}

/** One budget covers lock waits, transport, validation and publication. */
export function operationBudget(milliseconds = 5000, parent?: AbortSignal) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 300_000) {
    throw new RangeError("Update budget must be between 1 and 300000 milliseconds");
  }
  const controller = new AbortController();
  const end = performance.now() + milliseconds;
  const cancel = () => controller.abort(parent?.reason instanceof SyncFailure ? parent.reason : new SyncFailure("cancelled"));
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new SyncFailure("timeout")), milliseconds);
  return {
    signal: controller.signal,
    check() {
      // Check wall time too: synchronous parsing may delay the timer callback.
      if (performance.now() >= end && !controller.signal.aborted) controller.abort(new SyncFailure("timeout"));
      controller.signal.throwIfAborted();
    },
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort", cancel); },
  };
}

/** Bound a transport wait even if an injected transport ignores cancellation. */
export function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
