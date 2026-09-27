import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TurnstileWidget, UNCONFIGURED_TURNSTILE_TOKEN, readTurnstileToken } from "./turnstile";

/**
 * The dashboard's BINDING of `@akai/ui`'s Turnstile widget: that it reads
 * `publicEnv.turnstileSiteKey`, renders explicitly with the dashboard's
 * interaction-only appearance and spacing, and keeps its string-only token
 * contract. The widget's own behaviour is tested once, in libs/ui.
 */

const env = vi.hoisted(() => ({ turnstileSiteKey: "" }));
vi.mock("@/lib/env", () => ({ publicEnv: env }));

interface RenderOptions {
  readonly sitekey: string;
  readonly theme?: string;
  readonly appearance?: string;
}

function installFakeTurnstile() {
  const renderSpy = vi.fn<(container: HTMLElement, options: RenderOptions) => string>(
    () => "widget-1",
  );
  Object.defineProperty(window, "turnstile", {
    value: { render: renderSpy, remove: vi.fn(), reset: vi.fn() },
    configurable: true,
    writable: true,
  });
  return renderSpy;
}

function formWithToken(value: string): HTMLFormElement {
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.name = "cf-turnstile-response";
  input.value = value;
  form.appendChild(input);
  return form;
}

describe("dashboard Turnstile binding", () => {
  beforeEach(() => {
    env.turnstileSiteKey = "";
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "turnstile");
  });

  it("renders nothing when no site key is configured", () => {
    const { container } = render(<TurnstileWidget />);
    expect(container.querySelector('[data-testid="turnstile-widget"]')).toBeNull();
  });

  it("renders EXPLICITLY, interaction-only, with the configured site key", async () => {
    env.turnstileSiteKey = "0x-dash";
    const renderSpy = installFakeTurnstile();
    const { container } = render(<TurnstileWidget />);

    await waitFor(() => expect(renderSpy).toHaveBeenCalledTimes(1));
    const target = container.querySelector<HTMLElement>('[data-testid="turnstile-widget"]');
    expect(renderSpy.mock.calls[0]?.[0]).toBe(target);
    expect(renderSpy.mock.calls[0]?.[1]).toMatchObject({
      sitekey: "0x-dash",
      appearance: "interaction-only",
    });
    expect(target?.style.marginBottom).toBe("16px");
    // The implicit-mode hook is gone: nothing may be rendered by a DOM scan.
    expect(container.querySelector(".cf-turnstile")).toBeNull();
  });

  it("renders again after a remount, as on sign-in → forgot-password", async () => {
    env.turnstileSiteKey = "0x-dash";
    const renderSpy = installFakeTurnstile();
    const first = render(<TurnstileWidget />);
    await waitFor(() => expect(renderSpy).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<TurnstileWidget />);
    await waitFor(() => expect(renderSpy).toHaveBeenCalledTimes(2));
  });

  it("readTurnstileToken returns the placeholder when unconfigured", () => {
    expect(readTurnstileToken(formWithToken("solved"))).toBe(UNCONFIGURED_TURNSTILE_TOKEN);
  });

  it("readTurnstileToken returns the solved token when configured", () => {
    env.turnstileSiteKey = "0x-dash";
    expect(readTurnstileToken(formWithToken("solved"))).toBe("solved");
  });

  it("readTurnstileToken never returns empty: unsolved sends the placeholder", () => {
    env.turnstileSiteKey = "0x-dash";
    expect(readTurnstileToken(formWithToken(""))).toBe(UNCONFIGURED_TURNSTILE_TOKEN);
  });
});
