export type CompileQueueStats = {
  active: number;
  queued: number;
  concurrency: number;
  accepting: boolean;
};

type PendingJob<T> = {
  task: () => Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

export class CompileQueue {
  private active = 0;
  private accepting = true;
  private readonly pending: PendingJob<unknown>[] = [];

  constructor(readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Compile concurrency must be a positive integer");
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error("Compile queue is shutting down"));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ task, resolve, reject } as PendingJob<unknown>);
      this.drain();
    });
  }

  close(): void {
    this.accepting = false;
    const error = new Error("Compile queue is shutting down");
    for (const job of this.pending.splice(0)) job.reject(error);
  }

  stats(): CompileQueueStats {
    return { active: this.active, queued: this.pending.length, concurrency: this.concurrency, accepting: this.accepting };
  }

  private drain(): void {
    while (this.accepting && this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      this.active++;
      void job.task().then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}
