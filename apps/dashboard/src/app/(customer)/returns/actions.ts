"use server";

import { createReturnRequestSchema } from "@akai/contracts";
import { revalidatePath } from "next/cache";
import { createServerApiClient } from "@/lib/api/client";
import { createAccountApi } from "@/lib/account";

/**
 * Raising a return, from the returns page's form.
 *
 * A SERVER ACTION rather than a client fetch, for the same reason the rest of
 * the account area uses one: the bearer token stays server-side. The result is a
 * translation KEY, never a server message — the API's prose is written for a log.
 */
export type RequestReturnResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorKey: string };

/** API error codes mapped to a key under `account.returns.errors`. */
const ERROR_KEY: Readonly<Record<string, string>> = {
  NOT_FOUND: "notFound",
  VALIDATION_FAILED: "notDelivered",
  CONFLICT: "alreadyOpen",
  RATE_LIMITED: "rateLimited",
};

export async function requestReturnAction(formData: FormData): Promise<RequestReturnResult> {
  const parsed = createReturnRequestSchema.safeParse({
    orderNumber: formData.get("orderNumber"),
    reason: formData.get("reason"),
  });

  if (!parsed.success) {
    return { ok: false, errorKey: "invalid" };
  }

  const account = createAccountApi(await createServerApiClient());
  const result = await account.requestReturn(parsed.data);

  if (!result.ok) {
    const code = result.error.code;
    return { ok: false, errorKey: (code !== null && ERROR_KEY[code]) || "generic" };
  }

  // The list on this same page is server-rendered, so without this the new
  // request would not appear until a manual reload.
  revalidatePath("/returns");
  return { ok: true };
}
