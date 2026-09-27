import { Module } from "@nestjs/common";

import { CLOCK, systemClock } from "../auth/ports/clock.port";
import { AdminMediaController } from "./admin-media.controller";
import { MediaService } from "./media.service";

/**
 * MediaModule — direct-to-S3 signed uploads. Binaries never stream through this
 * API.
 *
 * That sentence was the placeholder's docblock for as long as the module was
 * empty, and the gap it left was visible on every page of the storefront: with
 * no route able to produce a hosted object, `POST /v1/admin/products/:id/media`
 * (which takes an already-hosted asset) could never be called, every seeded
 * product carried `media: []`, and every product card fell back to a text
 * placeholder.
 *
 * WHAT IT OWNS: minting a short-lived signed PUT URL, and deriving the object
 * key. Nothing else. Recording the uploaded asset against a product stays in
 * CatalogModule, next to the product write it must be consistent with — the
 * alternative is two modules that both believe they own `media_asset`.
 *
 * The clock is injected for the same reason it is in auth: a presigned URL's
 * signature is a function of the signing time, and a test that cannot fix the
 * clock cannot assert the signature at all.
 */
@Module({
  controllers: [AdminMediaController],
  providers: [MediaService, { provide: CLOCK, useValue: systemClock }],
  exports: [MediaService],
})
export class MediaModule {}
