import { describe, expect, it, vi } from "vitest";
import { TodoistAdapter } from "../src/adapters/todoist.js";

describe("Todoist task lookup", () => {
  it("downloads the task catalog once when checking multiple stable markers", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { id: "1", content: "First", description: "marker-one", labels: [] },
        { id: "2", content: "Second", description: "marker-two", labels: [] },
      ],
      next_cursor: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const adapter = new TodoistAdapter("token", fetchImpl);

    await expect(adapter.findByStableMarker("marker-one")).resolves.toHaveLength(1);
    await expect(adapter.findByStableMarker("marker-two")).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
