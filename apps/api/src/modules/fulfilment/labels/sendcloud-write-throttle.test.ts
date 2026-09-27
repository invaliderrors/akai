import { describe, expect, it } from "vitest";

import { SendcloudWriteThrottle } from "./sendcloud-write-throttle";

/** A fake clock whose `sleep` advances time instead of waiting. */
function fakeTime() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("SendcloudWriteThrottle", () => {
  it("lets writes through immediately while under budget, spaced by the burst gap", async () => {
    const time = fakeTime();
    const throttle = new SendcloudWriteThrottle({ ...time, minGapMs: 70 });

    await throttle.acquire();
    await throttle.acquire();

    // First write free; the second waits only the burst gap.
    expect(time.sleeps).toEqual([70]);
  });

  it("never admits more than maxPerWindow writes inside one window", async () => {
    const time = fakeTime();
    const throttle = new SendcloudWriteThrottle({
      ...time,
      maxPerWindow: 3,
      windowMs: 60_000,
      minGapMs: 0,
    });

    const admittedAt: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await throttle.acquire();
      admittedAt.push(time.now());
    }

    expect(admittedAt).toEqual([0, 0, 0, 60_000, 60_000]);
    // Every window of 60 s holds at most 3 admissions.
    for (const start of admittedAt) {
      const inWindow = admittedAt.filter((at) => at >= start && at < start + 60_000);
      expect(inWindow.length).toBeLessThanOrEqual(3);
    }
  });

  it("defaults to 90 per minute — under Sendcloud's 100", async () => {
    const time = fakeTime();
    const throttle = new SendcloudWriteThrottle({ ...time, minGapMs: 0 });

    for (let index = 0; index < 90; index += 1) {
      await throttle.acquire();
    }
    expect(time.now()).toBe(0);

    await throttle.acquire();
    expect(time.now()).toBe(60_000);
  });

  it("serialises concurrent callers", async () => {
    const time = fakeTime();
    const throttle = new SendcloudWriteThrottle({ ...time, maxPerWindow: 1, minGapMs: 0 });

    await Promise.all([throttle.acquire(), throttle.acquire()]);

    expect(time.now()).toBe(60_000);
  });
});
