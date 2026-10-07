import {
  categoryListResponseSchema,
  paginatedSchema,
  publicProductSchema,
  type CategoryListItem,
  type ProductSortMode,
  type PublicProduct,
} from "@akai/contracts";

import { serverEnv } from "./env";
import { ApiError, apiRequest } from "./http";

/** Server-only catalog reads. Islands never fetch the catalog themselves. */

const productPageSchema = paginatedSchema(publicProductSchema);

export interface ProductListOptions {
  readonly category?: string | undefined;
  readonly sort?: ProductSortMode;
  readonly limit?: number;
  readonly cursor?: string | undefined;
}

export async function listProducts(options: ProductListOptions) {
  const { data } = await apiRequest({
    baseUrl: serverEnv().API_INTERNAL_URL,
    path: "/products",
    schema: productPageSchema,
    query: {
      category: options.category,
      sort: options.sort,
      limit: options.limit,
      cursor: options.cursor,
    },
  });
  return data;
}

/** `null` for an unknown slug, so the page can answer 404 instead of 500. */
export async function getProduct(slug: string): Promise<PublicProduct | null> {
  try {
    const { data } = await apiRequest({
      baseUrl: serverEnv().API_INTERNAL_URL,
      path: `/products/${encodeURIComponent(slug)}`,
      schema: publicProductSchema,
    });
    return data;
  } catch (error: unknown) {
    if (error instanceof ApiError && error.isNotFound) return null;
    throw error;
  }
}

export async function listCategories(): Promise<readonly CategoryListItem[]> {
  const { data } = await apiRequest({
    baseUrl: serverEnv().API_INTERNAL_URL,
    path: "/categories",
    schema: categoryListResponseSchema,
  });
  return data.items;
}
