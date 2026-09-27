import {
  categoryListResponseSchema,
  paginatedSchema,
  publicProductSchema,
  type CategoryListItem,
  type Locale,
  type ProductSortMode,
  type PublicProduct,
} from "@akai/contracts";

import { serverEnv } from "./env";
import { ApiError, apiRequest } from "./http";

/** Server-only catalog reads. Islands never fetch the catalog themselves. */

const productPageSchema = paginatedSchema(publicProductSchema);

export interface ProductListOptions {
  readonly locale: Locale;
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
      locale: options.locale,
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

export async function listCategories(locale: Locale): Promise<readonly CategoryListItem[]> {
  const { data } = await apiRequest({
    baseUrl: serverEnv().API_INTERNAL_URL,
    path: "/categories",
    schema: categoryListResponseSchema,
    query: { locale },
  });
  return data.items;
}
