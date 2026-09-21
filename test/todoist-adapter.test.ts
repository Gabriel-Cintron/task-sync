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

  it("moves an existing task back to Inbox with a separate idempotency key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [url, init = {}] = args;
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: requestUrl, init });
      if (requestUrl.endsWith("/tasks/task-1") && init.method === "GET") {
        return new Response(JSON.stringify({ id: "task-1", content: "Old", description: "", project_id: "project-1", labels: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (requestUrl.includes("/projects?") && init.method === "GET") {
        return new Response(JSON.stringify({ results: [{ id: "inbox", name: "Inbox", inbox_project: true }], next_cursor: null }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "task-1", content: "Updated", description: "", labels: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const adapter = new TodoistAdapter("token", fetchMock);

    await adapter.updateTask("task-1", { content: "Updated", description: "", labels: [] }, "11111111-1111-4111-a111-111111111111");

    const writes = calls.filter((call) => call.init.method === "POST");
    expect(writes.map((call) => call.url)).toEqual([
      "https://api.todoist.com/api/v1/tasks/task-1",
      "https://api.todoist.com/api/v1/tasks/task-1/move",
    ]);
    const moveBody = writes[1]?.init.body;
    if (typeof moveBody !== "string") throw new Error("Expected move request JSON");
    expect(JSON.parse(moveBody)).toEqual({ project_id: "inbox" });
    const firstId = (writes[0]?.init.headers as Record<string, string>)["X-Request-Id"];
    const moveId = (writes[1]?.init.headers as Record<string, string>)["X-Request-Id"];
    expect(moveId).not.toBe(firstId);
  });

  it("normalizes Todoist's concrete Inbox project ID to the configured Inbox destination", async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [url] = args;
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.includes("/projects?")) {
        return new Response(JSON.stringify({ results: [{ id: "inbox", name: "Inbox", inbox_project: true }], next_cursor: null }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "task-1", content: "Already in Inbox", description: "", project_id: "inbox", labels: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const adapter = new TodoistAdapter("token", fetchMock);

    await expect(adapter.getTask("task-1")).resolves.toEqual({ id: "task-1", content: "Already in Inbox", description: "", labels: [] });
  });
});
