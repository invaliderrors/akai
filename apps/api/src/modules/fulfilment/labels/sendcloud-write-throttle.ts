/**
 * Keeps OUR Sendcloud writes under the account's budget (spec §1 S3: writes
 * 100/min with a 15/s burst → 429).
 *
 * A sliding window: at most `maxPerWindow` writes in any `windowMs`, and at
 * least `minGapMs` between two writes (the burst cap). Defaults 90/min and
 * 70 ms (≈14/s) — under both limits with headroom for a human's single cancel
 * landing in the middle of a bulk run.
 *
 * ONE instance per process, shared by every write path (the label job and
 * the admin cancel), which is the point: two callers each throttling
 * themselves to 90 would together spend 180. It is per PROCESS, not per
 * account — the API runs as one replica today; a second replica would need
 * the budget split (or a shared counter) and the client's 429 backoff is the
 * backstop either way.
 *
 * `acquire` SLEEPS rather than failing. The outbox runner processes a batch
 * sequentially, so waiting here delays the rest of that tick (a 100-label bulk
 * run holds the tick for roughly a minute) — preferable to throwing, which
 * would burn one of each message's eight attempts per window.
 */
export interface SendcloudWriteThrottleOptions {
  readonly maxPerWindow?: number;
  readonly windowMs?: number;
  readonly minGapMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class SendcloudWriteThrottle {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly minGapMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Start times of the writes inside the current window, oldest first. */
  private readonly recent: number[] = [];
  /** Serialises `acquire` so two concurrent callers cannot both see a free slot. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: SendcloudWriteThrottleOptions = {}) {
    this.maxPerWindow = options.maxPerWindow ?? 90;
    this.windowMs = options.windowMs ?? 60_000;
    this.minGapMs = options.minGapMs ?? 70;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /** Resolves when one more write may be sent now. */
  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot());
    // A rejected sleep must not wedge every later caller.
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.recent.length > 0 && (this.recent[0] ?? now) <= now - this.windowMs) {
        this.recent.shift();
      }

      const last = this.recent[this.recent.length - 1];
      const gapWait = last === undefined ? 0 : last + this.minGapMs - now;
      const oldest = this.recent[0];
      const windowWait =
        this.recent.length >= this.maxPerWindow && oldest !== undefined
          ? oldest + this.windowMs - now
          : 0;
      const wait = Math.max(gapWait, windowWait);

      if (wait <= 0) {
        this.recent.push(now);
        return;
      }
      await this.sleep(wait);
    }
  }
}
