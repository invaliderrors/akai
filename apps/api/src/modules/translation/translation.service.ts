import { Inject, Injectable } from "@nestjs/common";
import type { TranslateRequest, TranslateResponse, TranslationPort } from "@akai/contracts";

import { TRANSLATION_GATEWAY } from "./translation.port";
import { TranslationError } from "./translation.errors";

/**
 * The one place a translation outcome becomes an HTTP result.
 *
 * Thin on purpose. The gateway owns the vendor, the errors file owns the
 * mapping, and this owns the seam between "the port answered" and "the caller
 * gets a typed refusal" — so swapping vendors touches one file and swapping the
 * error vocabulary touches another.
 */
@Injectable()
export class TranslationService {
  constructor(
    @Inject(TRANSLATION_GATEWAY) private readonly gateway: TranslationPort,
  ) {}

  async translate(request: TranslateRequest): Promise<TranslateResponse> {
    const outcome = await this.gateway.translate(request);

    if (!outcome.ok) {
      throw TranslationError.from(outcome.reason);
    }

    // Copied out of the port's readonly view rather than handed through: the
    // response type is the wire contract's mutable array, and a caller that
    // sorted it in place would otherwise be reordering a gateway's internals.
    return { translations: [...outcome.translations] };
  }
}
