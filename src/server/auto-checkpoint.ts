export interface AutoCheckpointOptions {
  checkpoint: () => Promise<unknown>;
  onError: (error: unknown) => void;
  idleMs?: number;
  maxWaitMs?: number;
  retryMs?: number;
}

export interface AutoCheckpoint {
  changed(): void;
  close(): void;
}

export function createAutoCheckpoint(options: AutoCheckpointOptions): AutoCheckpoint {
  const idleMs = options.idleMs ?? 30_000;
  const maxWaitMs = options.maxWaitMs ?? 300_000;
  const retryMs = options.retryMs ?? 5_000;
  let firstChange: number | undefined;
  let lastChange = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let closed = false;

  function arm(delay?: number): void {
    if (closed || running || firstChange === undefined) return;
    if (timer) clearTimeout(timer);
    const due = Math.min(lastChange + idleMs, firstChange + maxWaitMs);
    timer = setTimeout(() => { void checkpoint(); }, delay ?? Math.max(0, due - Date.now()));
    timer.unref();
  }

  async function checkpoint(): Promise<void> {
    timer = undefined;
    if (closed) return;
    running = true;
    firstChange = undefined;
    let failed = false;
    try { await options.checkpoint(); }
    catch (error) {
      failed = true;
      options.onError(error);
      firstChange ??= Date.now();
      lastChange = Date.now();
    } finally {
      running = false;
      // Edits made during a commit must receive their own checkpoint.
      arm(failed ? retryMs : undefined);
    }
  }

  return {
    changed(): void {
      if (closed) return;
      firstChange ??= Date.now();
      lastChange = Date.now();
      arm();
    },
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
