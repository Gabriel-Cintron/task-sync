export class OperationMutex {
  private active: { name: string; controller: AbortController; cancellable: boolean } | undefined;

  public get busy(): boolean {
    return this.active !== undefined;
  }

  public get operation(): string | undefined {
    return this.active?.name;
  }

  public async run<T>(
    name: string,
    operation: (signal: AbortSignal) => T | Promise<T>,
    options: { cancellable?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.active) throw new Error(`Another operation is already running: ${this.active.name}`);
    const controller = new AbortController();
    this.active = { name, controller, cancellable: options.cancellable ?? false };
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      controller.abort(new Error(`${name} timed out. Try again, or disable OpenAI enrichment for a faster preview.`));
    }, options.timeoutMs);
    try {
      return await Promise.resolve(operation(controller.signal));
    } finally {
      if (timeout) clearTimeout(timeout);
      this.active = undefined;
    }
  }

  public cancel(): { accepted: boolean; operation?: string } {
    if (!this.active) return { accepted: false };
    const operation = this.active.name;
    if (!this.active.cancellable) return { accepted: false, operation };
    this.active.controller.abort(new Error(`${operation} cancelled`));
    return { accepted: true, operation };
  }
}
