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

  it("derives the included course IDs from saved setup mappings", () => {
    const config = testConfig({
      courseMappings: [
        { sourceType: "canvas", connectionId: "canvas", courseExternalId: "included", destinationKey: "inbox", enabled: true },
        { sourceType: "canvas", connectionId: "canvas", courseExternalId: "excluded", destinationKey: "inbox", enabled: false },
      ],
    });

    expect([...excludedCanvasCourseIds(config)!]).toEqual(["excluded"]);
  });
});
