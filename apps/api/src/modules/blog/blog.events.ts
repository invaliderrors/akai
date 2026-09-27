/**
 * Why a blog write purged the storefront — the `reason` on its
 * `storefront.revalidate` outbox row.
 *
 * REASONS, NOT TOPICS, exactly like the catalog's: nothing subscribes to these.
 * The purge row's topic is always `REVALIDATION_TOPIC` and its tag is always
 * `REVALIDATE_TAG_BLOG`; this string is what an operator reads at /admin/jobs
 * when asking why a blog page was invalidated.
 */
export const BLOG_REVALIDATION_REASONS = {
  postUpdated: "blog.post.updated",
  postPublished: "blog.post.published",
  postUnpublished: "blog.post.unpublished",
  postDeleted: "blog.post.deleted",
} as const;

export type BlogRevalidationReason =
  (typeof BLOG_REVALIDATION_REASONS)[keyof typeof BLOG_REVALIDATION_REASONS];
