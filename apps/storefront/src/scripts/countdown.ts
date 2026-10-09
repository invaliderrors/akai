import { formatCountdown, nextWeekly, type CountdownFormat } from "@/lib/merch";

/**
 * Ticks every `[data-countdown]` on the page. The server renders the first
 * value; this keeps it live. Reduced motion drops the seconds and ticks slowly.
 */
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isFormat = (value: string): value is CountdownFormat =>
  value === "short" || value === "minutes" || value === "seconds";

function tick(): void {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>("[data-countdown]")) {
    const target = el.dataset.countdown;
    const format = el.dataset.format ?? "short";
    if (target === undefined || !isFormat(format)) continue;
    el.textContent = formatCountdown(
      nextWeekly(target, now) - now,
      reduce && format === "seconds" ? "minutes" : format,
    );
  }
}

tick();
setInterval(tick, reduce ? 30_000 : 1000);
