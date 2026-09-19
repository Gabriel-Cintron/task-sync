import { describe, expect, it, vi } from "vitest";
import { TodoistAdapter } from "../src/adapters/todoist.js";

describe("Todoist task lookup", () => {
  it("downloads the task catalog once when checking multiple stable markers", async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return new Response(JSON.stringify({
        results: [
          { id: "1", content: "First", description: "marker-one", labels: [] },
          { id: "2", content: "Second", description: "marker-two", labels: [] },
        ],
        next_cursor: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const adapter = new TodoistAdapter("token", fetchMock);

    await expect(adapter.findByStableMarker("marker-one")).resolves.toHaveLength(1);
    await expect(adapter.findByStableMarker("marker-two")).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps an assignment deadline to Todoist's due datetime", async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return new Response(JSON.stringify({
        id: "created",
        content: "Lab",
        description: "Details",
        labels: [],
        due: { date: "2026-10-03", datetime: "2026-10-03T20:00:00-04:00" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const adapter = new TodoistAdapter("token", fetchMock);

    await adapter.createTask({
      content: "Lab",
      description: "Details",
      labels: [],
      deadlineAt: "2026-10-03T20:00:00-04:00",
      deadlinePrecision: "datetime",
      dateKind: "due",
    }, "request-id");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload).toMatchObject({ due_datetime: "2026-10-04T00:00:00.000Z" });
    expect(payload).toMatchObject({ deadline_date: null });
  });
});
