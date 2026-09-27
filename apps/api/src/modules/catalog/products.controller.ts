import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Inject,
  Param,
  Query,
  Redirect,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import {
  slugSchema,
  type Paginated,
  type PublicPackComponent,
  type PublicProduct,
} from "@akai/contracts";
import { Public } from "../../common/decorators/public.decorator";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { ProductsService } from "./products.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  publicAddOnListQuerySchema,
  publicProductListQuerySchema,
  type PublicAddOnListQuery,
  type PublicProductListQuery,
} from "./dto/catalog.dto";
import { COA_FILE_READER, type CoaFileReader } from "./coa-file.reader";

/** The slice of Express's response the file route writes: headers only. */
interface HeaderWriter {
  setHeader(name: string, value: string): void;
}

/**
 * How long a browser may keep the certificate bytes. PRIVATE — a shared cache
 * must not hold a document whose visibility the admin can switch off — and
 * short, so switching it off takes effect for a returning visitor within
 * minutes.
 */
const COA_FILE_CACHE_CONTROL = "private, max-age=300";

/**
 * The public catalog. Read-only, unauthenticated.
 *
 * There is no write verb on this controller at all. Admin writes live on a
 * SEPARATE controller behind a role guard rather than as guarded methods mixed
 * in here — so "is this endpoint public?" is answered by which file it is in,
 * not by scanning each method for a decorator that might be missing.
 *
 * It serves `PublicProduct`, NOT `Product`. The difference is the inventory
 * record: the wide shape publishes `onHand`, `reserved` and `lowStockThreshold`,
 * and this controller served it to anyone who asked until the narrowing landed.
 * The narrowing is enforced by the return type, so a handler that reaches for
 * `listAdmin` here does not compile.
 */
@Controller("products")
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    @Inject(COA_FILE_READER) private readonly coaFiles: CoaFileReader,
  ) {}

  /**
   * The query is parsed by a `.strict()` schema with NO `status` and NO
   * `includeDeleted` member. A caller appending `?status=DRAFT` gets a 400, not
   * a draft product: the privileged filters are unreachable because they are
   * absent from the schema, not because a runtime check remembers to reject them.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get()
  async list(
    @Query(new ZodValidationPipe(publicProductListQuerySchema))
    query: PublicProductListQuery,
  ): Promise<Paginated<PublicProduct>> {
    return this.products.listPublic(query, query.locale);
  }

  /**
   * The add-on products: sellable, but deliberately absent from the grid above.
   *
   * DECLARED BEFORE `@Get(":slug")`, AND THAT ORDER IS LOAD-BEARING. Nest
   * matches routes in declaration order and `:slug` accepts any well-formed
   * slug — "add-ons" included. Move this method below the detail handler and
   * every request for the add-on list is answered by `detail("add-ons")`, which
   * 404s because no product has that slug. The symptom reads as missing data,
   * not as a routing mistake, which is why the order is stated rather than left
   * to be noticed. (The corollary: a product whose slug really is `add-ons` is
   * unreachable at its own URL. That is the standard cost of a literal segment
   * on a slug route, and it is worth paying once here rather than inventing a
   * reserved-word check the admin surface would have to enforce forever.)
   *
   * A SEPARATE ROUTE RATHER THAN A FLAG ON THE LIST ABOVE. See
   * `ProductsService.listPublicAddOns`: the visibility axis must not be
   * something a customer can set, and a query parameter is exactly that.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get("add-ons")
  async listAddOns(
    @Query(new ZodValidationPipe(publicAddOnListQuerySchema))
    query: PublicAddOnListQuery,
  ): Promise<Paginated<PublicProduct>> {
    return this.products.listPublicAddOns(query, query.locale);
  }

  /**
   * The add-ons THIS product's page offers.
   *
   * ALSO DECLARED BEFORE `@Get(":slug")`. This pattern carries a second segment
   * so it is unambiguous against the bare slug route, but keeping it above the
   * detail handler keeps the rule stated above true by inspection rather than by
   * luck — the next route added here will be read in this order.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get(":slug/add-ons")
  async addOnsFor(
    @Param("slug", new ZodValidationPipe(slugSchema)) slug: string,
  ): Promise<Paginated<PublicProduct>> {
    return this.products.listAddOnsFor(slug);
  }

  /**
   * The products THIS pack is made of. ALSO DECLARED BEFORE `@Get(":slug")`,
   * for the identical routing reason `:slug/add-ons` above states — a literal
   * segment ahead of the wildcard slug route. Empty for every non-PACK
   * product, so `ProductsService.listPackComponentsFor` is the only place
   * that pays for it.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get(":slug/pack-components")
  async packComponentsFor(
    @Param("slug", new ZodValidationPipe(slugSchema)) slug: string,
  ): Promise<Paginated<PublicPackComponent>> {
    return this.products.listPackComponentsFor(slug);
  }

  /**
   * The PRODUCT's certificate of analysis, as a 302 to a signed URL minted at
   * click time.
   *
   * THE STABLE LINK THE PRODUCT PAGE EMBEDS. The page is ISR-cached; a signed
   * URL baked into it went dead when its signature expired. This URL never
   * expires, and what it redirects to is always fresh. `no-store`, because
   * the redirect TARGET does expire and no cache may replay it.
   *
   * NO QUERY PARAMETERS, AND NONE PARSED. The previous build linked per
   * variant (`?variantId=`); a page cached from before the switch still
   * carries that link, and it must land on the product's certificate rather
   * than on a 400. Ignoring the query costs nothing: it selects nothing.
   *
   * ALSO DECLARED BEFORE `@Get(":slug")`, for the same routing reason
   * `:slug/add-ons` states. 404 when the product or its certificate is
   * missing, AND when the admin has not switched it on — the storefront only
   * renders the link when `hasCoa` is true, so a 404 here means the page was
   * stale, not that the link was wrong.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get(":slug/coa")
  @Header("Cache-Control", "no-store")
  @Redirect(undefined, HttpStatus.FOUND)
  async coa(
    @Param("slug", new ZodValidationPipe(slugSchema)) slug: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.products.coaUrlFor(slug);
    return { url, statusCode: HttpStatus.FOUND };
  }

  /**
   * The PRODUCT's certificate of analysis, AS BYTES — what the storefront's
   * in-page viewer (PDF.js) fetches. The 302 above stays for "open in a new
   * tab / download"; this route exists because a browser `fetch` of the
   * presigned bucket URL would be a cross-origin read from an origin whose
   * CORS policy is not ours, whereas this API already answers the storefront.
   *
   * THE SAME VISIBILITY RULE AS THE REDIRECT, from the same method
   * (`coaObjectKeyFor`): 404 for an unknown product, no file, a hidden file,
   * and — here only — a row whose object is gone from the bucket.
   *
   * `inline` so a browser that navigates here directly shows rather than
   * saves it; the filename is the slug, which `slugSchema` has already
   * limited to `[a-z0-9-]`, so it cannot break out of the header's quotes.
   * The Cache-Control is written on SUCCESS only (not via `@Header`), so a 404
   * is never remembered for five minutes after the admin switches the
   * certificate on.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get(":slug/coa/file")
  async coaFile(
    @Param("slug", new ZodValidationPipe(slugSchema)) slug: string,
    @Res({ passthrough: true }) response: HeaderWriter,
  ): Promise<StreamableFile> {
    const objectKey = await this.products.coaObjectKeyFor(slug);
    const pdf = await this.coaFiles.read(objectKey);
    response.setHeader("Cache-Control", COA_FILE_CACHE_CONTROL);
    return new StreamableFile(pdf, {
      type: "application/pdf",
      disposition: `inline; filename="certificado-${slug}.pdf"`,
      length: pdf.byteLength,
    });
  }

  /**
   * Resolves current slugs and historic ones alike, so a renamed product does
   * not 404 every inbound link that predates the rename.
   *
   * SERVES ADD-ONS TOO, on purpose. `listed` is not consulted here: an unlisted
   * product is one that is not merchandised on the grid, not one that is
   * secret, and a customer who follows a link to it from a product page must
   * land on a real page.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get(":slug")
  async detail(
    @Param("slug", new ZodValidationPipe(slugSchema)) slug: string,
  ): Promise<PublicProduct> {
    return this.products.getBySlugPublic(slug);
  }
}
