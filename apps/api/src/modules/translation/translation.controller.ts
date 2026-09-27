import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  translateRequestSchema,
  type TranslateRequest,
  type TranslateResponse,
} from "@akai/contracts";

import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AdminGuard } from "../admin/admin.guard";
import { AdminRoles } from "../admin/admin.decorators";
import { TranslationService } from "./translation.service";

/**
 * `POST /v1/admin/translations` — machine-translate product copy between the
 * store's two locales.
 *
 * THE GUARD AND THE ROLES ARE DECLARED AT CLASS LEVEL, ONCE, for the same
 * reason CatalogModule's admin controller does it: a method added later
 * inherits the restriction, so forgetting a decorator fails as a 403 in
 * development rather than shipping an open route that spends money.
 *
 * STAFF AS WELL AS ADMIN. This endpoint exists to serve the product form, and
 * STAFF is exactly the role that writes product copy — restricting it to ADMIN
 * would leave the people doing the work translating by hand. It creates
 * nothing, reads nothing of ours, and the batch it can send is capped by the
 * contract, so the worst a compromised staff session can do here is spend
 * characters.
 *
 * NO `@RequireFreshTwoFactor()`, deliberately. Step-up is reserved for
 * operations that can read out or rewrite the catalogue; this one neither reads
 * nor writes a single row of our data, and prompting for a second factor on
 * every use of a form button is how operators learn to keep a 2FA prompt
 * permanently satisfied.
 */
@ApiTags("admin")
@Controller("admin/translations")
@UseGuards(AdminGuard)
@AdminRoles("ADMIN", "STAFF")
export class TranslationController {
  constructor(private readonly translation: TranslationService) {}

  /**
   * 200, not 201. Nothing is created and nothing is stored — the request is a
   * pure function of its body, and a `Location`-less 201 would tell a client
   * there is now a resource to go and fetch.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Translate product copy between the store's locales" })
  translate(
    @Body(new ZodValidationPipe(translateRequestSchema)) body: TranslateRequest,
  ): Promise<TranslateResponse> {
    return this.translation.translate(body);
  }
}
