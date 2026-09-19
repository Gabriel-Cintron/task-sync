import { ProviderError } from "./errors.js";

export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 20_000;

function durationLabel(timeoutMs: number): string {
  if (timeoutMs < 1_000) return `${timeoutMs} milliseconds`;
  return `${timeoutMs / 1_000} seconds`;
}

export async function fetchWithTimeout(
  provider: string,
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;

  try {
    return await fetchImpl(input, { ...init, signal });
  } catch (error) {
    if (timedOut) {
      throw new ProviderError(
        "provider_outage",
        `${provider} request timed out after ${durationLabel(timeoutMs)}. Check your connection and try again.`,
      );
    }
    if (init.signal?.aborted) throw init.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
