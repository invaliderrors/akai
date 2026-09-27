import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UNCONFIGURED_TURNSTILE_TOKEN, readTurnstileToken } from "./turnstile-widget";

/**
 * A stand-in for Cloudflare's `window.turnstile`, recording every call.
 *
 * `render` returns a fresh widget id per call and, like the real api.js, injects
 * the hidden `cf-turnstile-response` input into the container — that input is
 * what every consuming form reads through `FormData` / `readTurnstileToken`.
 */
interface RenderCall {
  readonly container: HTMLElement;
  readonly options: {
    readonly sitekey: string;
    readonly theme?: string;
    readonly appearance?: string;
    readonly callback?: (token: string) => void;
    readonly "expired-callback"?: () => void;
    readonly "error-callback"?: (code: string) => void;
  };
  readonly id: string;
}

function installFakeTurnstile() {
  const renders: RenderCall[] = [];
  const removed: string[] = [];
  const resets: (string | undefined)[] = [];
  const api = {
    render: vi.fn((container: HTMLElement, options: RenderCall["options"]) => {
      const id = `widget-${renders.length + 1}`;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "cf-turnstile-response";
      input.value = "";
      container.appendChild(input);
      renders.push({ container, options, id });
      return id;
    }),
    remove: vi.fn((id: string) => {
      removed.push(id);
    }),
    reset: vi.fn((id?: string) => {
      resets.push(id);
    }),
  };
  Object.defineProperty(window, "turnstile", {
    value: api,
    configurable: true,
    writable: true,
  });
  return { api, renders, removed, resets };
}

function uninstallFakeTurnstile() {
  Reflect.deleteProperty(window, "turnstile");
}

function turnstileScripts(): HTMLScriptElement[] {
  return Array.from(
    document.querySelectorAll<HTMLScriptElement>(
      'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]',
    ),
  );
}

/** Simulates the browser finishing the download of Cloudflare's api.js. */
function finishScriptLoad(): ReturnType<typeof installFakeTurnstile> {
  const fake = installFakeTurnstile();
  const [script] = turnstileScripts();
  if (script === undefined) {
    throw new Error("no turnstile script was injected");
  }
  script.dispatchEvent(new Event("load"));
  return fake;
}

/**
 * The loader keeps a module-level promise (one script per page), so every test
 * gets a FRESH copy of the module rather than one another test already loaded.
 */
async function freshModule() {
  vi.resetModules();
  return import("./turnstile-widget");
}

const SITE = "0x-site";

describe("TurnstileWidget", () => {
  beforeEach(() => {
    uninstallFakeTurnstile();
    for (const script of turnstileScripts()) {
      script.remove();
    }
  });
  afterEach(() => {
    cleanup();
    uninstallFakeTurnstile();
  });

  it.each([[""], [undefined]])(
    "renders nothing and loads no script when the site key is %j",
    async (siteKey) => {
      const { TurnstileWidget } = await freshModule();
      const { container } = render(<TurnstileWidget siteKey={siteKey} />);
      expect(container.querySelector('[data-testid="turnstile-widget"]')).toBeNull();
      expect(turnstileScripts()).toHaveLength(0);
    },
  );

  it("loads the EXPLICIT-render script, not the implicit one", async () => {
    const { TurnstileWidget } = await freshModule();
    render(<TurnstileWidget siteKey={SITE} />);
    const scripts = turnstileScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    );
  });

  it("renders the widget once into its own container, with the site key", async () => {
    const { TurnstileWidget } = await freshModule();
    const { container } = render(<TurnstileWidget siteKey={SITE} />);
    const fake = finishScriptLoad();

    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));
    const target = container.querySelector('[data-testid="turnstile-widget"]');
    expect(fake.renders[0]?.container).toBe(target);
    expect(fake.renders[0]?.options.sitekey).toBe("0x-site");
    // Explicit rendering still injects the hidden input the forms read.
    expect(container.querySelector('input[name="cf-turnstile-response"]')).not.toBeNull();
  });

  it("removes the widget on unmount", async () => {
    const { TurnstileWidget } = await freshModule();
    const { unmount } = render(<TurnstileWidget siteKey={SITE} />);
    const fake = finishScriptLoad();
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));

    unmount();
    expect(fake.removed).toEqual(["widget-1"]);
  });

  it("renders AGAIN after a remount, as on a client-side navigation", async () => {
    // THE BUG THIS FILE EXISTS FOR. Implicit rendering scanned for
    // `.cf-turnstile` once, when api.js first loaded; a form reached by a soft
    // navigation mounted after that scan and never got a widget or a token.
    const { TurnstileWidget } = await freshModule();
    const first = render(<TurnstileWidget siteKey={SITE} />);
    const fake = finishScriptLoad();
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = render(<TurnstileWidget siteKey={SITE} />);
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(2));
    expect(fake.renders[1]?.container).toBe(
      second.container.querySelector('[data-testid="turnstile-widget"]'),
    );
    expect(turnstileScripts()).toHaveLength(1);
  });

  it("loads the script only once for two widgets on one page", async () => {
    const { TurnstileWidget } = await freshModule();
    render(
      <>
        <TurnstileWidget siteKey={SITE} />
        <TurnstileWidget siteKey={SITE} />
      </>,
    );
    expect(turnstileScripts()).toHaveLength(1);
    const fake = finishScriptLoad();
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(2));
    expect(fake.renders[0]?.container).not.toBe(fake.renders[1]?.container);
  });

  it("renders straight away when api.js is already on the page", async () => {
    const fake = installFakeTurnstile();
    const { TurnstileWidget } = await freshModule();
    render(<TurnstileWidget siteKey={SITE} />);
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));
    expect(turnstileScripts()).toHaveLength(0);
  });

  it("keeps render and remove balanced under StrictMode's double mount", async () => {
    const fake = installFakeTurnstile();
    const { TurnstileWidget } = await freshModule();
    const { unmount } = render(
      <StrictMode>
        <TurnstileWidget siteKey={SITE} />
      </StrictMode>,
    );
    await waitFor(() => expect(fake.api.render).toHaveBeenCalled());
    // Settle any stray microtasks, then check exactly ONE widget is live.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.api.render.mock.calls.length - fake.removed.length).toBe(1);

    unmount();
    expect(fake.api.render.mock.calls.length).toBe(fake.removed.length);
  });

  it("hands the solved token to the consumer's callback", async () => {
    const fake = installFakeTurnstile();
    const { TurnstileWidget } = await freshModule();
    const onVerify = vi.fn();
    render(<TurnstileWidget siteKey={SITE} onVerify={onVerify} />);
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));

    fake.renders[0]?.options.callback?.("tok-1");
    expect(onVerify).toHaveBeenCalledWith("tok-1");
  });

  it("reports expiry to the consumer", async () => {
    const fake = installFakeTurnstile();
    const { TurnstileWidget } = await freshModule();
    const onExpire = vi.fn();
    render(<TurnstileWidget siteKey={SITE} onExpire={onExpire} />);
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));

    fake.renders[0]?.options["expired-callback"]?.();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("uses the LATEST callback without re-rendering the widget", async () => {
    const fake = installFakeTurnstile();
    const { TurnstileWidget } = await freshModule();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<TurnstileWidget siteKey={SITE} onVerify={first} />);
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));

    rerender(<TurnstileWidget siteKey={SITE} onVerify={second} />);
    fake.renders[0]?.options.callback?.("tok-2");
    expect(second).toHaveBeenCalledWith("tok-2");
    expect(first).not.toHaveBeenCalled();
    expect(fake.api.render).toHaveBeenCalledTimes(1);
  });

  it("resetTurnstile resets the live widget by id, and nothing after unmount", async () => {
    const fake = installFakeTurnstile();
    const { TurnstileWidget, resetTurnstile } = await freshModule();
    const { unmount } = render(<TurnstileWidget siteKey={SITE} />);
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));

    resetTurnstile();
    expect(fake.resets).toEqual(["widget-1"]);

    unmount();
    resetTurnstile();
    expect(fake.resets).toEqual(["widget-1"]);
  });

  it("passes only the options it was given, so Cloudflare's defaults stand", async () => {
    const fake = installFakeTurnstile();
    const { TurnstileWidget } = await freshModule();
    render(<TurnstileWidget siteKey={SITE} />);
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));
    expect(fake.renders[0]?.options).not.toHaveProperty("theme");
    expect(fake.renders[0]?.options).not.toHaveProperty("appearance");
    expect(fake.renders[0]?.options).not.toHaveProperty("error-callback");
  });

  it("forwards theme and appearance to the render call", async () => {
    const fake = installFakeTurnstile();
    const { TurnstileWidget } = await freshModule();
    render(<TurnstileWidget siteKey={SITE} theme="light" appearance="interaction-only" />);
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));
    expect(fake.renders[0]?.options.theme).toBe("light");
    expect(fake.renders[0]?.options.appearance).toBe("interaction-only");
  });

  it("hands Cloudflare's error code to onError when one is supplied", async () => {
    const fake = installFakeTurnstile();
    const { TurnstileWidget } = await freshModule();
    const onError = vi.fn();
    render(<TurnstileWidget siteKey={SITE} onError={onError} />);
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));

    fake.renders[0]?.options["error-callback"]?.("110200");
    expect(onError).toHaveBeenCalledWith("110200");
  });

  it("applies className and style to the container", async () => {
    const { TurnstileWidget } = await freshModule();
    const { container } = render(
      <TurnstileWidget siteKey={SITE} className="spaced" style={{ marginBottom: 16 }} />,
    );
    const target = container.querySelector<HTMLElement>('[data-testid="turnstile-widget"]');
    expect(target?.className).toBe("spaced");
    expect(target?.style.marginBottom).toBe("16px");
    // Never the implicit-mode hook: api.js must not also claim this element.
    expect(target?.classList.contains("cf-turnstile")).toBe(false);
  });

  it("retries the script on the next mount if the first download failed", async () => {
    const { TurnstileWidget } = await freshModule();
    const first = render(<TurnstileWidget siteKey={SITE} />);
    turnstileScripts()[0]?.dispatchEvent(new Event("error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(turnstileScripts()).toHaveLength(0);
    first.unmount();

    render(<TurnstileWidget siteKey={SITE} />);
    expect(turnstileScripts()).toHaveLength(1);
    const fake = finishScriptLoad();
    await waitFor(() => expect(fake.api.render).toHaveBeenCalledTimes(1));
  });
});

/**
 * The unconfigured-key path is the environment every test and every local
 * `pnpm dev` actually runs in: the site key is BLANK in the checked-in env.
 * The auth schemas require a NON-EMPTY `turnstileToken`, so sending `""` would
 * 400 at the API with an error that looks like a form bug and is a
 * configuration one; the placeholder keeps them working, and the API's
 * `AlwaysAllowCaptchaVerifier` (bound whenever TURNSTILE_SECRET_KEY is unset)
 * accepts it.
 */
describe("readTurnstileToken", () => {
  const CONFIGURED = "0x4AAAAAAA_test_site_key";

  function formWithToken(value: string): HTMLFormElement {
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.name = "cf-turnstile-response";
    input.value = value;
    form.appendChild(input);
    document.body.appendChild(form);
    return form;
  }

  it.each([[""], [undefined]])(
    "returns the self-describing placeholder when the site key is %j",
    (siteKey) => {
      expect(readTurnstileToken(formWithToken("a-real-token"), siteKey)).toBe(
        UNCONFIGURED_TURNSTILE_TOKEN,
      );
    },
  );

  it("never returns an empty string, which the API's schema rejects", () => {
    expect(readTurnstileToken(document.createElement("form"), CONFIGURED)).toBeNull();
  });

  it("returns the solved token once the widget has injected one", () => {
    expect(readTurnstileToken(formWithToken("solved-abc"), CONFIGURED)).toBe("solved-abc");
  });

  it("REFUSES LOCALLY when the site key is configured but nothing was solved", () => {
    // NEXT_PUBLIC_TURNSTILE_SITE_KEY is inlined at BUILD time while the API's
    // secret is a runtime variable, so an image built before the key existed
    // takes this branch for EVERY visitor. A placeholder would turn that
    // deployment-ordering mistake into a silent, total sign-up outage in which
    // the API's "bot verification failed" blames the customer's form.
    expect(readTurnstileToken(formWithToken(""), CONFIGURED)).toBeNull();
  });
});
