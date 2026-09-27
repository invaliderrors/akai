"use client";

import { useEffect, useRef, type CSSProperties } from "react";

/**
 * Cloudflare Turnstile, rendered EXPLICITLY — the ONE implementation both Next
 * apps use. Each app binds its own site key through a thin app-local module
 * (`apps/storefront/src/components/turnstile-widget.tsx`,
 * `apps/dashboard/src/components/auth/turnstile.tsx`); this file never reads an
 * environment variable, because `NEXT_PUBLIC_*` is inlined by each app's bundler
 * only where it appears as a static member expression in THAT app's source.
 *
 * WHY EXPLICIT, AND WHY IT IS A BUG FIX RATHER THAN A PREFERENCE. Implicit mode
 * (api.js scanning the DOM for `.cf-turnstile`) scans exactly ONCE — when the
 * script first executes. The App Router swaps pages without reloading it, so a
 * form reached by a client-side navigation (sign-in → forgot-password, contact,
 * sign-up …) mounted AFTER that scan and never got a widget. No widget, no
 * token: every submit was refused, for every visitor who did not land on the
 * form directly.
 *
 * Here each mounted widget calls `turnstile.render` on its own container and
 * `turnstile.remove` when it unmounts, so the widget's lifetime is the React
 * component's lifetime, whichever way the page was reached.
 *
 * THE FORMS' CONTRACT IS UNCHANGED. Explicit rendering still injects a hidden
 * `<input name="cf-turnstile-response">` into the container (Turnstile's
 * `response-field` defaults to true), so it still lands inside the enclosing
 * `<form>` and callers keep reading it through `FormData` /
 * `readTurnstileToken`. The callback props are optional extras.
 *
 * An EMPTY (or absent) site key means "Turnstile is not configured": the widget
 * renders nothing and loads no script, and `readTurnstileToken` returns
 * `UNCONFIGURED_TURNSTILE_TOKEN`.
 */

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Cloudflare's `theme` render option. */
export type TurnstileTheme = "light" | "dark" | "auto";

/**
 * Cloudflare's `appearance` render option. `interaction-only` keeps the widget
 * invisible unless the visitor actually has to interact with a challenge.
 */
export type TurnstileAppearance = "always" | "execute" | "interaction-only";

/** The subset of Turnstile's render options this component passes. */
interface TurnstileRenderOptions {
  readonly sitekey: string;
  readonly theme?: TurnstileTheme;
  readonly appearance?: TurnstileAppearance;
  readonly callback?: (token: string) => void;
  readonly "expired-callback"?: () => void;
  readonly "error-callback"?: (errorCode: string) => void;
}

/**
 * Cloudflare's widget object, narrowed to the calls made here.
 *
 * `render` is typed as possibly returning `undefined` because Cloudflare's own
 * typings do: it gives no id back when the render fails (e.g. a bad container).
 */
interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  remove(widgetId: string): void;
  reset(widgetId?: string): void;
}

/**
 * DECLARATION MERGING RATHER THAN A LOCAL TYPE OR A CAST: the script really does
 * ADD this property to the real window, and it is optional because it is absent
 * until api.js has executed — so every read below is genuine runtime narrowing.
 */
declare global {
  interface Window {
    /** Injected by Cloudflare's api.js; absent until that script has loaded. */
    turnstile?: TurnstileApi;
  }
}

/**
 * ONE download per page, shared by every widget. Reset to `null` on failure so
 * the next widget to mount retries instead of inheriting a rejected promise for
 * the rest of the session.
 */
let scriptPromise: Promise<TurnstileApi> | null = null;

/**
 * Ids of the widgets currently mounted, so `resetTurnstile` can reset exactly
 * the live ones — never a widget that was removed on a navigation away.
 */
const liveWidgets = new Set<string>();

function isConfigured(siteKey: string | undefined): siteKey is string {
  return siteKey !== undefined && siteKey.length > 0;
}

function loadTurnstile(): Promise<TurnstileApi> {
  const ready = window.turnstile;
  if (ready !== undefined) {
    return Promise.resolve(ready);
  }
  if (scriptPromise !== null) {
    return scriptPromise;
  }

  const promise = new Promise<TurnstileApi>((resolve, reject) => {
    // A tag may already be present — e.g. this module was re-evaluated by HMR
    // while the page kept its <head>. Listen to it rather than add a second one.
    const existing = document.getElementById(SCRIPT_ID);
    const script =
      existing instanceof HTMLScriptElement ? existing : document.createElement("script");

    const onLoad = () => {
      const api = window.turnstile;
      if (api === undefined) {
        onError();
        return;
      }
      resolve(api);
    };
    const onError = () => {
      scriptPromise = null;
      script.remove();
      reject(new Error("Cloudflare Turnstile failed to load"));
    };
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });

    if (script !== existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      // Async is right for a script injected at runtime: nothing waits on it,
      // and `render` is only ever called from the load handler above.
      script.async = true;
      document.head.appendChild(script);
    }
  });
  scriptPromise = promise;
  return promise;
}

export interface TurnstileWidgetProps {
  /**
   * The public site key. Empty or absent means "not configured": nothing is
   * rendered and no script is loaded.
   */
  readonly siteKey: string | undefined;
  /** Cloudflare's theme. Omitted: Cloudflare's default (`auto`). */
  readonly theme?: TurnstileTheme;
  /** Cloudflare's appearance. Omitted: Cloudflare's default (`always`). */
  readonly appearance?: TurnstileAppearance;
  /** Applied to the container element. */
  readonly className?: string;
  /** Applied to the container element. */
  readonly style?: CSSProperties;
  /** Called with each solved token. The hidden input is populated regardless. */
  readonly onVerify?: (token: string) => void;
  /** Called when a solved token expires (Turnstile then re-solves by itself). */
  readonly onExpire?: () => void;
  /** Called with Cloudflare's error code when the challenge fails. */
  readonly onError?: (errorCode: string) => void;
}

export function TurnstileWidget({
  siteKey,
  theme,
  appearance,
  className,
  style,
  onVerify,
  onExpire,
  onError,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // The LATEST callbacks, read at call time. Putting them in the effect's
  // dependencies instead would remove and re-render the widget — discarding a
  // solved token — every time a parent re-rendered with a new inline function.
  const callbacks = useRef({ onVerify, onExpire, onError });
  useEffect(() => {
    callbacks.current = { onVerify, onExpire, onError };
  });

  useEffect(() => {
    if (!isConfigured(siteKey)) {
      return;
    }
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    // STRICT MODE mounts, unmounts and remounts synchronously. `render` only
    // ever runs in a `.then`, i.e. after that burst, so the first mount's
    // cleanup flips `cancelled` before it could render — render and remove stay
    // balanced and exactly one widget exists.
    let cancelled = false;
    let widgetId: string | undefined;

    loadTurnstile()
      .then((api) => {
        if (cancelled) {
          return;
        }
        const options: TurnstileRenderOptions = {
          sitekey: siteKey,
          ...(theme === undefined ? {} : { theme }),
          ...(appearance === undefined ? {} : { appearance }),
          callback: (token) => callbacks.current.onVerify?.(token),
          "expired-callback": () => callbacks.current.onExpire?.(),
          // Only claimed when a consumer asked: supplying an error callback
          // tells Turnstile the page is handling the error itself.
          ...(callbacks.current.onError === undefined
            ? {}
            : {
                "error-callback": (code: string) => callbacks.current.onError?.(code),
              }),
        };
        widgetId = api.render(container, options);
        if (widgetId !== undefined) {
          liveWidgets.add(widgetId);
        }
      })
      .catch(() => {
        // The script did not load (blocked, offline). There is no widget and
        // so no token: `readTurnstileToken` returns null and the forms show
        // their "reload and try again" copy. The next mount retries the load.
      });

    return () => {
      cancelled = true;
      if (widgetId !== undefined) {
        liveWidgets.delete(widgetId);
        window.turnstile?.remove(widgetId);
      }
    };
  }, [siteKey, theme, appearance]);

  if (!isConfigured(siteKey)) {
    return null;
  }

  // Deliberately NOT `.cf-turnstile`: that class is the implicit-mode hook, and
  // this element must only ever be rendered by the explicit call above.
  return (
    <div ref={containerRef} className={className} style={style} data-testid="turnstile-widget" />
  );
}

/**
 * Sent when no site key is configured.
 *
 * Deliberately self-describing: if this string ever appears in a PRODUCTION API
 * log, the widget is misconfigured and the endpoint is unprotected. A value like
 * `""` or `"token"` would not say so — and `""` would not even arrive, because
 * the auth request schemas require `turnstileToken: z.string().min(1)`. With no
 * `TURNSTILE_SECRET_KEY` the API binds `AlwaysAllowCaptchaVerifier` and accepts
 * it; with a secret set, Cloudflare rejects it like any other forgery.
 */
export const UNCONFIGURED_TURNSTILE_TOKEN = "turnstile-not-configured";

/**
 * Discard the solved token of every live widget and solve again.
 *
 * A TURNSTILE TOKEN IS SINGLE-USE. Cloudflare answers `timeout-or-duplicate` the
 * second time one is presented, so a flow that reads the same widget twice
 * ("send another code") would post a spent token and be refused, every time.
 * Call this after each request completes, so a fresh token is ready before the
 * customer can click again.
 */
export function resetTurnstile(): void {
  if (typeof window === "undefined") {
    return;
  }
  const api = window.turnstile;
  if (api === undefined) {
    return;
  }
  for (const widgetId of liveWidgets) {
    api.reset(widgetId);
  }
}

/**
 * The widget's token, read out of a submitted form.
 *
 * - Site key not configured → `UNCONFIGURED_TURNSTILE_TOKEN`, so schemas that
 *   demand a non-empty string still accept the request in development.
 * - Configured and solved → the token.
 * - Configured but UNSOLVED → `null`. Never the placeholder: the site key is
 *   inlined at BUILD time while the API's secret is a runtime variable, so an
 *   image built before the key existed would reach this branch for EVERY
 *   visitor, and a placeholder would turn that into a silent, total outage
 *   reported as "bot verification failed". `null` lets the caller show copy the
 *   customer can act on (reload) instead of posting a doomed request.
 *
 * Narrowed through `unknown` rather than cast: `elements.namedItem` returns a
 * union that includes `RadioNodeList`, and asserting it is an input is a lie the
 * compiler accepts right up until a field is renamed.
 */
export function readTurnstileToken(
  form: HTMLFormElement,
  siteKey: string | undefined,
): string | null {
  if (!isConfigured(siteKey)) {
    return UNCONFIGURED_TURNSTILE_TOKEN;
  }

  const element: unknown = form.elements.namedItem("cf-turnstile-response");
  if (element instanceof HTMLInputElement && element.value !== "") {
    return element.value;
  }
  return null;
}
