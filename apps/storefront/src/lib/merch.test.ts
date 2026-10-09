import { describe, expect, it } from "vitest";

import { formatCountdown, nextWeekly } from "./merch";

const DROP = "2026-09-27T12:00:00+09:00";
const DROP_MS = Date.parse(DROP);
const WEEK = 7 * 24 * 60 * 60 * 1000;

describe("nextWeekly", () => {
  it("returns the target while it is still ahead", () => {
    expect(nextWeekly(DROP, DROP_MS - 1000)).toBe(DROP_MS);
  });

  it("rolls forward a week once the target passes", () => {
    expect(nextWeekly(DROP, DROP_MS)).toBe(DROP_MS + WEEK);
    expect(nextWeekly(DROP, DROP_MS + 1000)).toBe(DROP_MS + WEEK);
  });

  it("skips as many whole weeks as have gone by", () => {
    expect(nextWeekly(DROP, DROP_MS + 3 * WEEK + 5)).toBe(DROP_MS + 4 * WEEK);
  });
});

describe("formatCountdown", () => {
  const ms = ((6 * 24 + 4) * 60 + 12) * 60_000 + 9000;

  it("formats days and hours", () => {
    expect(formatCountdown(ms, "short")).toBe("06D 04H");
  });

  it("adds minutes, then seconds", () => {
    expect(formatCountdown(ms, "minutes")).toBe("06D 04H 12M");
    expect(formatCountdown(ms, "seconds")).toBe("06D 04H 12M 09S");
  });

  it("never goes negative", () => {
    expect(formatCountdown(-5000, "seconds")).toBe("00D 00H 00M 00S");
  });
});
