import { describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../src/core/fetch-with-timeout.js";

describe("provider request timeout", () => {
  it("aborts a stalled provider request with a useful error", async () => {
    const stalledFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;

    await expect(fetchWithTimeout("Canvas", stalledFetch, "https://canvas.example.edu/api", {}, 5))
      .rejects.toThrow("Canvas request timed out after 5 milliseconds");
    expect(stalledFetch).toHaveBeenCalledOnce();
  });

  it("returns a provider response before the deadline", async () => {
    const response = new Response("ok");
    const responsiveFetch = vi.fn(async () => response) as unknown as typeof fetch;

    await expect(fetchWithTimeout("Todoist", responsiveFetch, "https://api.todoist.com/api/v1/projects", {}, 50))
      .resolves.toBe(response);
  });
});
