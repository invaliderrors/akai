import { describe, expect, it } from "vitest";
import { parseDurationMs } from "./duration";

describe("parseDurationMs", () => {
  it("converts each supported unit", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("15m")).toBe(900_000);
    expect(parseDurationMs("24h")).toBe(86_400_000);
    expect(parseDurationMs("30d")).toBe(2_592_000_000);
  });

  it("throws rather than defaulting on a malformed value", () => {
    // A silently-defaulted token TTL is a security control that looks
    // configured and is not.
    for (const bad of ["", "15", "m", "15x", "-15m", "1.5h", "15 m", "fifteen"]) {
      expect(() => parseDurationMs(bad)).toThrow();
    }
  });

  it("rejects a zero duration", () => {
    // A zero-length access token TTL would mint tokens that are already expired.
    expect(() => parseDurationMs("0m")).toThrow();
  });
});
