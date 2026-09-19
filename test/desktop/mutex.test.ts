import { describe, expect, it } from "vitest";
import { OperationMutex } from "../../src/application/mutex.js";

describe("operation cancellation", () => {
  it("cancels a cancellable operation and releases the mutex", async () => {
    const mutex = new OperationMutex();
    const operation = mutex.run("create sync plan", async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled")), { once: true });
      });
    }, { cancellable: true });

    expect(mutex.cancel()).toEqual({ accepted: true, operation: "create sync plan" });
    await expect(operation).rejects.toThrow("create sync plan cancelled");
    expect(mutex.busy).toBe(false);
    await expect(mutex.run("next operation", () => "done")).resolves.toBe("done");
  });

  it("refuses to cancel a protected operation", async () => {
    const mutex = new OperationMutex();
    let finish!: () => void;
    const operation = mutex.run("apply sync plan", () => new Promise<void>((resolve) => { finish = resolve; }));

    expect(mutex.cancel()).toEqual({ accepted: false, operation: "apply sync plan" });
    finish();
    await operation;
  });
});
