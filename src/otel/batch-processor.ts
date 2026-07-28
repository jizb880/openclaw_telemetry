import type { SpanExporter } from "./exporters.js";
import type { ReadableSpan } from "./span.js";

export type BatchSpanProcessorOptions = {
  /** Flush when this many spans are queued. */
  maxExportBatchSize?: number;
  /** Hard cap on the queue; spans beyond it are dropped rather than growing memory. */
  maxQueueSize?: number;
  /** Flush this often even when the batch is not full. */
  scheduledDelayMs?: number;
  /** Called when a batch fails to export or spans are dropped. */
  onError?: (err: unknown) => void;
};

/**
 * Buffers finished spans and exports them in batches, mirroring the OTel SDK's
 * `BatchSpanProcessor` behavior that this plugin relies on.
 *
 * The flush timer is `unref`'d so a pending flush never keeps the host process
 * alive, and exports are serialized so batches cannot interleave on the wire or
 * interleave lines in the NDJSON file.
 */
export class BatchSpanProcessor {
  private queue: ReadableSpan[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  private readonly maxExportBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly scheduledDelayMs: number;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly exporter: SpanExporter,
    opts: BatchSpanProcessorOptions = {}
  ) {
    this.maxExportBatchSize = opts.maxExportBatchSize ?? 512;
    this.maxQueueSize = opts.maxQueueSize ?? 2048;
    this.scheduledDelayMs = opts.scheduledDelayMs ?? 5_000;
    this.onError = opts.onError ?? (() => {});
  }

  onEnd(span: ReadableSpan): void {
    if (this.shuttingDown) return;
    if (this.queue.length >= this.maxQueueSize) {
      this.onError(new Error("span queue full; dropping span"));
      return;
    }
    this.queue.push(span);

    if (this.queue.length >= this.maxExportBatchSize) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.scheduledDelayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Export everything queued now; resolves once the drain completes. */
  async flush(): Promise<void> {
    this.clearTimer();
    // Chain onto any in-flight export so batches stay ordered and non-overlapping.
    const drain = this.inFlight.then(async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.maxExportBatchSize);
        try {
          await this.exporter.export(batch);
        } catch (err) {
          this.onError(err);
        }
      }
    });
    this.inFlight = drain.catch(() => undefined);
    await this.inFlight;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearTimer();
    await this.flush();
    await this.exporter.shutdown().catch((err) => this.onError(err));
  }
}
