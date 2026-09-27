import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

/**
 * ARCHITECTURE GATE (spec §12), not a feature test.
 *
 * The workspace runs Vitest everywhere rather than Jest for the API. The one
 * real cost of that choice is decorator metadata: `emitDecoratorMetadata` is a
 * tsc feature, and Vitest transforms with esbuild, which drops it. The fix is
 * unplugin-swc in apps/api/vite config with legacyDecorator + decoratorMetadata.
 *
 * This test proves constructor-parameter injection — which depends entirely on
 * `design:paramtypes` metadata surviving the transform — actually resolves.
 * If this fails, Vitest is silently unable to test any Nest provider, and the
 * spec's stated fallback (Jest for apps/api only) is the correct response.
 * Do not delete it and do not "fix" it by injecting via @Inject() tokens,
 * which would sidestep exactly the mechanism under test.
 */

@Injectable()
class DependencyService {
  value(): string {
    return "injected";
  }
}

@Injectable()
class ConsumerService {
  // No @Inject() token: resolution here relies on emitted design:paramtypes.
  constructor(private readonly dependency: DependencyService) {}

  read(): string {
    return this.dependency.value();
  }
}

@Module({ providers: [DependencyService, ConsumerService] })
class ProbeModule {}

describe("Nest DI under Vitest", () => {
  it("resolves constructor injection from emitted decorator metadata", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    const consumer = moduleRef.get(ConsumerService);

    expect(consumer.read()).toBe("injected");
    await moduleRef.close();
  });
});
