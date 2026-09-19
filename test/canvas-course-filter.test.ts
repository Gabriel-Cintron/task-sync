import { describe, expect, it, vi } from "vitest";
import { CanvasAdapter } from "../src/adapters/canvas.js";
import { excludedCanvasCourseIds } from "../src/composition.js";
import { testConfig } from "./helpers.js";

describe("Canvas course selection", () => {
  it("fetches assignments only for included courses", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/assignments")) {
        if (!url.includes("/courses/included/")) throw new Error(`Unexpected excluded-course request: ${url}`);
        return new Response(JSON.stringify([{ id: "a1", name: "Included work", submission: { workflow_state: "unsubmitted" } }]), { status: 200 });
      }
      return new Response(JSON.stringify([
        { id: "included", name: "Biology" },
        { id: "excluded", name: "Old homeroom" },
      ]), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new CanvasAdapter("canvas", "https://canvas.example.edu", "token", fetchImpl, new Set(["excluded"]));

    await expect(adapter.listItems()).resolves.toEqual([expect.objectContaining({ title: "Included work" })]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("derives the excluded course IDs from saved setup mappings", () => {
    const config = testConfig({
      courseMappings: [
        { sourceType: "canvas", connectionId: "canvas", courseExternalId: "included", destinationKey: "inbox", enabled: true },
        { sourceType: "canvas", connectionId: "canvas", courseExternalId: "excluded", destinationKey: "inbox", enabled: false },
      ],
    });

    expect([...excludedCanvasCourseIds(config)!]).toEqual(["excluded"]);
  });

  it("drops undated assignments when the option is disabled", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/assignments")) {
        return new Response(JSON.stringify([
          { id: "dated", name: "Dated work", due_at: "2026-10-10T20:00:00Z" },
          { id: "undated", name: "Reference material", due_at: null },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: "course", name: "Biology" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new CanvasAdapter("canvas", "https://canvas.example.edu", "token", fetchImpl, undefined, false);

    const items = await adapter.listItems();
    expect(items.map((item) => item.ref.externalId)).toEqual(["dated"]);
  });
});
