"use server";

import { revalidatePath } from "next/cache";
import type { Address, Customer } from "@akai/contracts";
import type { ApiResult } from "@/lib/api/errors";
import { createServerApiClient } from "@/lib/api/client";
import {
  createAccountApi,
  type ChangePasswordRequest,
  type CreateAddressRequest,
  type UpdateAddressRequest,
  type UpdateProfileRequest,
} from "@/lib/account";

/**
 * Server Actions for the customer account area.
 *
 * WHY ACTIONS RATHER THAN BROWSER FETCHES: the API is reached with a bearer
 * token that lives inside the sealed, httpOnly session cookie. Calling the API
 * from the browser would mean handing that token to client JavaScript, which is
 * exactly what the BFF design exists to prevent. An action runs on the server,
 * so the token never leaves it — and Next's built-in Origin check gives CSRF
 * protection without a hand-rolled double-submit token on this path.
 *
 * Every action returns `ApiResult` unchanged. Nothing here throws on a failed
 * request, so the form components can render a typed error instead of tripping
 * an error boundary that loses everything the customer just typed.
 */

async function api() {
  return createAccountApi(await createServerApiClient());
}

export async function updateProfileAction(
  input: UpdateProfileRequest,
): Promise<ApiResult<Customer>> {
  const account = await api();
  const result = await account.updateProfile(input);

  if (result.ok) {
    // The shell renders the customer's name and email, so a stale cache here
    // shows the OLD name in the header beside the new one in the form.
    revalidatePath("/", "layout");
  }

  return result;
}

export async function createAddressAction(
  input: CreateAddressRequest,
): Promise<ApiResult<Address>> {
  const account = await api();
  const result = await account.createAddress(input);

  if (result.ok) {
    revalidatePath("/addresses");
    // Setting a new default changes what the overview shows.
    revalidatePath("/");
  }

  return result;
}

export async function updateAddressAction(
  addressId: string,
  input: UpdateAddressRequest,
): Promise<ApiResult<Address>> {
  const account = await api();
  const result = await account.updateAddress(addressId, input);

  if (result.ok) {
    revalidatePath("/addresses");
    revalidatePath("/");
  }

  return result;
}

export async function deleteAddressAction(
  addressId: string,
): Promise<ApiResult<undefined>> {
  const account = await api();
  const result = await account.deleteAddress(addressId);

  if (result.ok) {
    revalidatePath("/addresses");
    revalidatePath("/");
  }

  return result;
}

export async function changePasswordAction(
  input: ChangePasswordRequest,
): Promise<ApiResult<undefined>> {
  const account = await api();
  // Deliberately no revalidate: a password change alters no rendered data, and
  // the API keeps THIS session alive while revoking the others.
  return account.changePassword(input);
}
