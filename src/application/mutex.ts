export class OperationMutex {
  private activeOperation: string | undefined;

  public get busy(): boolean {
    return this.activeOperation !== undefined;
  }

  public get operation(): string | undefined {
    return this.activeOperation;
  }

  public async run<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.activeOperation) throw new Error(`Another operation is already running: ${this.activeOperation}`);
    this.activeOperation = name;
    try {
      return await Promise.resolve(operation());
    } finally {
      this.activeOperation = undefined;
    }
  }
}
