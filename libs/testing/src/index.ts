/**
 * @akai/testing — fakes and builders shared by every suite.
 *
 * Tagged `type:testing`: importable only from test files and e2e projects, so
 * a fake can never be wired into a production composition root by accident.
 *
 * The guiding rule for anything added here: a fake must be able to FAIL, not
 * just succeed. A fake that only ever returns success means the retry, DLQ and
 * error-envelope paths are untested — and those are the paths that matter at
 * 3am.
 */

export * from "./builders";
export * from "./fake-email";
export * from "./http-server";
export * from "./wompi-webhook";
