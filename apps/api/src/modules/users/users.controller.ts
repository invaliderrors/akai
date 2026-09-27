import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Customer } from "@akai/contracts";
import { CurrentUser, type Principal } from "../auth/security/principal";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  erasureRequestSchema,
  updateProfileSchema,
  type ErasureRequestInput,
  type ErasureResult,
  type PersonalDataExport,
  type UpdateProfileInput,
} from "./dto/users.dto";
import { UsersService } from "./users.service";

/**
 * Customer self-service.
 *
 * NOTE THE ROUTES: `/me`, never `/users/:id`. There is no path parameter to
 * tamper with, so the most common IDOR — swapping the id in the URL — has
 * nowhere to happen. The identity always comes from `@CurrentUser()`, which is
 * populated by the auth layer from the session row and throws when absent.
 */
@ApiTags("users")
@Controller("me")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: "Read the authenticated customer's own profile" })
  async profile(@CurrentUser() principal: Principal): Promise<Customer> {
    return this.users.getProfile(principal.customerId);
  }

  @Patch()
  @ApiOperation({ summary: "Update the authenticated customer's own profile" })
  async updateProfile(
    @CurrentUser() principal: Principal,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileInput,
  ): Promise<Customer> {
    return this.users.updateProfile(principal.customerId, body);
  }

  @Get("export")
  @ApiOperation({
    summary: "GDPR Art. 20 portability export of the caller's own personal data",
  })
  async exportData(@CurrentUser() principal: Principal): Promise<PersonalDataExport> {
    return this.users.exportPersonalData(principal.customerId);
  }

  /**
   * POST, not DELETE.
   *
   * The request carries a confirmation body, and DELETE-with-a-body is
   * inconsistently handled by proxies and HTTP clients — a stripped body here
   * would mean the confirmation check silently stops running.
   */
  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "GDPR Art. 17 erasure — anonymise the caller's own account in place",
  })
  async requestErasure(
    @CurrentUser() principal: Principal,
    @Body(new ZodValidationPipe(erasureRequestSchema)) body: ErasureRequestInput,
  ): Promise<ErasureResult> {
    return this.users.requestErasure(principal.customerId, body);
  }
}
