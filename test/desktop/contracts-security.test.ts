import { describe, expect, it } from "vitest";
import { ApplyPlanRequestSchema, ImportRequestSchema, SetupInputSchema } from "../../src/application/contracts.js";
import { isAllowedExternalUrl, isTrustedRendererUrl } from "../../src/desktop/security.js";

describe("desktop IPC boundary", () => {
  it("rejects malformed and over-posted arguments", () => {
    expect(() => ApplyPlanRequestSchema.parse({ planId: "not-an-id", digest: "bad" })).toThrow();
    expect(() => ImportRequestSchema.parse({})).toThrow();
    expect(() => SetupInputSchema.parse({ credentials: { todoistApiToken: "x", leaked: true } })).toThrow();
  });

  it("accepts only the packaged renderer or exact development origin", () => {
    expect(isTrustedRendererUrl("task-sync://app/index.html")).toBe(true);
    expect(isTrustedRendererUrl("https://attacker.example/")).toBe(false);
    expect(isTrustedRendererUrl(undefined)).toBe(false);
    expect(isTrustedRendererUrl("http://localhost:5173/index.html", "http://localhost:5173")).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:5173.attacker.example/", "http://localhost:5173")).toBe(false);
  });

  it("allows only HTTPS external URLs", () => {
    expect(isAllowedExternalUrl("https://school.example/assignment/1")).toBe(true);
    expect(isAllowedExternalUrl("http://school.example/")).toBe(false);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
  });
});
