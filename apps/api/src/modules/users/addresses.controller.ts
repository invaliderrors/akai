import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Address } from "@akai/contracts";
import { AddressesService } from "./addresses.service";
import {
  createAddressRequestSchema,
  updateAddressRequestSchema,
  type CreateAddressInput,
  type UpdateAddressInput,
} from "./dto/users.dto";
import { CurrentUser, type Principal } from "../auth/security/principal";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

/**
 * The customer's own address book.
 *
 * `:addressId` IS a path parameter here — unavoidable, since addresses are a
 * collection. It is therefore never trusted on its own: it is passed to the
 * service alongside `principal.customerId`, and every repository lookup resolves
 * by (id AND customerId). A well-formed id belonging to another customer
 * resolves to zero rows and surfaces as 404.
 *
 * `ParseUUIDPipe` rejects a malformed id before it reaches a query, which keeps
 * a garbage parameter from becoming a database error whose message describes the
 * column type.
 */
@ApiTags("users")
@Controller("me/addresses")
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  @ApiOperation({ summary: "List the caller's own addresses" })
  async list(@CurrentUser() principal: Principal): Promise<readonly Address[]> {
    return this.addresses.list(principal.customerId);
  }

  @Get(":addressId")
  @ApiOperation({ summary: "Read one of the caller's own addresses" })
  async get(
    @CurrentUser() principal: Principal,
    @Param("addressId", ParseUUIDPipe) addressId: string,
  ): Promise<Address> {
    return this.addresses.get(principal.customerId, addressId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Add an address to the caller's own address book" })
  async create(
    @CurrentUser() principal: Principal,
    @Body(new ZodValidationPipe(createAddressRequestSchema)) body: CreateAddressInput,
  ): Promise<Address> {
    return this.addresses.create(principal.customerId, body);
  }

  @Patch(":addressId")
  @ApiOperation({ summary: "Update one of the caller's own addresses" })
  async update(
    @CurrentUser() principal: Principal,
    @Param("addressId", ParseUUIDPipe) addressId: string,
    @Body(new ZodValidationPipe(updateAddressRequestSchema)) body: UpdateAddressInput,
  ): Promise<Address> {
    return this.addresses.update(principal.customerId, addressId, body);
  }

  @Delete(":addressId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove one of the caller's own addresses" })
  async remove(
    @CurrentUser() principal: Principal,
    @Param("addressId", ParseUUIDPipe) addressId: string,
  ): Promise<void> {
    await this.addresses.remove(principal.customerId, addressId);
  }
}
