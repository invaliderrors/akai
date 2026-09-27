import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { createLogger } from "@akai/observability";

import { ADMIN_ROLES_KEY } from "../admin/admin.decorators";
import { AdminGuard } from "../admin/admin.guard";
import { DeeplTranslationGateway } from "./deepl.gateway";
import { UnconfiguredTranslationGateway } from "./unconfigured-translation.gateway";
import { TranslationController } from "./translation.controller";
import { createTranslationGateway } from "./translation.module";

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "test" });

describe("createTranslationGateway", () => {
  it("degrades to absent — not broken — when no key is configured", async () => {
    const gateway = createTranslationGateway({}, logger);

    expect(gateway).toBeInstanceOf(UnconfiguredTranslationGateway);
    await expect(
      gateway.translate({ source: "es", target: "en", texts: [{ key: "name", text: "Hola" }] }),
    ).resolves.toEqual({ ok: false, reason: "NOT_CONFIGURED" });
  });

  it("treats an empty or whitespace key as unset", () => {
    // `.env.example` ships `DEEPL_API_KEY=`, which parses as "" — authenticating
    // with that would produce a 403 that reads like a revoked credential.
    expect(createTranslationGateway({ DEEPL_API_KEY: "" }, logger)).toBeInstanceOf(
      UnconfiguredTranslationGateway,
    );
    expect(createTranslationGateway({ DEEPL_API_KEY: "   " }, logger)).toBeInstanceOf(
      UnconfiguredTranslationGateway,
    );
  });

  it("binds the real gateway once a key is present", () => {
    expect(createTranslationGateway({ DEEPL_API_KEY: "abc:fx" }, logger)).toBeInstanceOf(
      DeeplTranslationGateway,
    );
  });
});

describe("TranslationController authorisation", () => {
  it("is guarded at class level, so a handler added later inherits it", () => {
    const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, TranslationController);

    expect(Array.isArray(guards) && guards.includes(AdminGuard)).toBe(true);
  });

  it("admits the roles that write product copy, and no others", () => {
    const roles: unknown = Reflect.getMetadata(ADMIN_ROLES_KEY, TranslationController);

    expect(roles).toEqual(["ADMIN", "STAFF"]);
  });
});
