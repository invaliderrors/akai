import { describe, expect, it } from "vitest";
import { jobStateSchema } from "@akai/contracts";

import { STATUS_TONE } from "@/lib/status";
import { canRetryJob, topicNeedsAttention } from "./job-display";

/**
 * The signals an operator scans on the jobs page.
 *
 * The important one is UNROUTED: a topic with no handler dead-letters every
 * message it ever receives, while the producer that enqueued them looks like it
 * worked. It must raise attention even when the counters are all zero, because
 * "zero dead so far" is exactly what it looks like just before the first one.
 */

describe("topicNeedsAttention", () => {
  it("flags an unrouted topic even with nothing queued yet", () => {
    expect(topicNeedsAttention({ dead: 0, retrying: 0, unrouted: true })).toBe(true);
  });

  it("flags a dead-letter backlog", () => {
    expect(topicNeedsAttention({ dead: 1, retrying: 0, unrouted: false })).toBe(true);
  });

  it("flags jobs still retrying", () => {
    expect(topicNeedsAttention({ dead: 0, retrying: 3, unrouted: false })).toBe(true);
  });

  it("stays quiet for a healthy topic", () => {
    expect(topicNeedsAttention({ dead: 0, retrying: 0, unrouted: false })).toBe(false);
  });
});

describe("canRetryJob", () => {
  it("offers a retry for DEAD and RETRYING", () => {
    expect(canRetryJob("DEAD")).toBe(true);
    expect(canRetryJob("RETRYING")).toBe(true);
  });

  it("does NOT offer a retry for a job that already succeeded", () => {
    // Re-running a handled message re-sends the email or re-mirrors the product.
    // The API refuses it too; offering a button the server rejects teaches an
    // operator to distrust the UI.
    expect(canRetryJob("PROCESSED")).toBe(false);
  });

  it("does not offer a retry for a job that has not been tried yet", () => {
    expect(canRetryJob("PENDING")).toBe(false);
  });
});

describe("the job tone table", () => {
  /*
   * `JOB_STATE_TONE` moved to `lib/status` under the `job` domain. The
   * assertions are kept rather than deleted: they are the reason `canRetryJob`
   * above splits DEAD and RETRYING the way it does, and reading the two rules
   * beside each other is what makes either of them checkable.
   */
  it("covers every state, so a new one cannot render unstyled", () => {
    for (const state of jobStateSchema.options) {
      expect(STATUS_TONE.job[state]).toBeTypeOf("string");
    }
  });

  it("distinguishes DEAD from RETRYING", () => {
    // They need different reactions: a retrying job may still succeed on its
    // own; a dead one never will without an operator.
    expect(STATUS_TONE.job.DEAD).toBe("danger");
    expect(STATUS_TONE.job.RETRYING).toBe("warning");
  });
});
