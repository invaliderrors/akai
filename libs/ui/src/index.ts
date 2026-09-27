/**
 * @akai/ui
 *
 * Shared React components. Referenced by each Next app's globals.css via an explicit @source.
 *
 * Components here never read an app's environment: anything app-specific (a
 * site key, a locale) is an input, bound by a thin module in the consuming app.
 */
export const LIB_NAME = "@akai/ui" as const;

export {
  TurnstileWidget,
  readTurnstileToken,
  resetTurnstile,
  UNCONFIGURED_TURNSTILE_TOKEN,
  type TurnstileAppearance,
  type TurnstileTheme,
  type TurnstileWidgetProps,
} from "./turnstile/turnstile-widget";
