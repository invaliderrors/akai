import { describe, expect, it } from "vitest";
import { compareDueOrder } from "./outbox.repository";

function row(id: string, availableAt: string, createdAt: string) {
  return { id, availableAt: new Date(availableAt), createdAt: new Date(createdAt) };
}

describe("compareDueOrder", () => {
  it("puts the earliest-due message first, whatever order the database returned", () => {
    const delivered = row("b", "2026-09-25T10:00:05Z", "2026-09-25T10:00:05Z");
    const shipped = row("a", "2026-09-25T10:00:00Z", "2026-09-25T10:00:00Z");

    expect([delivered, shipped].sort(compareDueOrder).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("breaks an availableAt tie by creation time", () => {
    const later = row("x", "2026-09-25T10:00:00Z", "2026-09-25T09:00:02Z");
    const earlier = row("y", "2026-09-25T10:00:00Z", "2026-09-25T09:00:01Z");

    expect([later, earlier].sort(compareDueOrder).map((r) => r.id)).toEqual(["y", "x"]);
  });

  it("is total, so equal timestamps still sort deterministically", () => {
    const one = row("2", "2026-09-25T10:00:00Z", "2026-09-25T10:00:00Z");
    const two = row("1", "2026-09-25T10:00:00Z", "2026-09-25T10:00:00Z");

    expect([one, two].sort(compareDueOrder).map((r) => r.id)).toEqual(["1", "2"]);
  });
});
