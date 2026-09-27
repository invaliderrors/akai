"use client";

import { useId, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import {
  blogCategorySchema,
  createBlogPostSchema,
  slugSchema,
  updateBlogPostSchema,
  type AdminBlogPost,
  type BlogCategory,
  type BlogPostTranslationInput,
  type CreateBlogPost,
  type Locale,
  type UpdateBlogPost,
} from "@akai/contracts";

import { Button, buttonClassName } from "@/components/ui/button";
import { PopupButton, TextArea, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Checkbox } from "@/components/ui/toggle";
import { Link, useRouter } from "@/i18n/navigation";
import {
  createBlogPostAction,
  deleteBlogPostAction,
  translateBlogCopyAction,
  updateBlogPostAction,
} from "@/lib/admin/actions";
import {
  BLOG_COPY_FIELDS,
  EMPTY_BLOG_COPY,
  toBlogCopy,
  type BlogCopy,
} from "@/lib/admin/blog-copy";
import { translateCopyReasonOf } from "@/lib/admin/translate-copy";

import { actionErrorKey } from "./affiliate-editor";
import { BlogCoverField } from "./blog-cover-field";
import { RichTextPreview } from "./rich-text-preview";
import { ConfirmActionError, TypeToConfirmButton } from "./type-to-confirm-button";

/**
 * The blog post editor — create and edit (spec 2026-09-24 §8).
 *
 * Spanish is always present (the default-locale page is the canonical one);
 * English is opt-in, because decision D8c allows a Spanish-only post, and an
 * English section left half-written must not silently publish. The body is the
 * same raw-HTML textarea + live `RichTextPreview` the product description
 * uses, sanitised by the same allow-list the API applies on save.
 *
 * The DeepL helper PREFILLS the other locale and never saves — the operator
 * reads, edits and saves deliberately, and the section is flagged as machine
 * translated until they do.
 *
 * The cover can only be set once the post exists: its storage key is scoped to
 * the post's id (`blog/{postId}/…`).
 */
export interface BlogPostEditorProps {
  readonly post?: AdminBlogPost;
}

export type BlogFormError = "REQUIRED" | "TOO_LONG" | "INVALID_SLUG" | "INVALID";

export type BlogFieldErrors = Readonly<Record<string, BlogFormError>>;

export interface BlogFormValues {
  readonly slug: string;
  readonly category: BlogCategory;
  /** English is opt-in (D8c). */
  readonly includeEnglish: boolean;
  readonly copy: Readonly<Record<Locale, BlogCopy>>;
}

export type BlogBuildResult =
  | { readonly ok: true; readonly mode: "create"; readonly value: CreateBlogPost }
  | { readonly ok: true; readonly mode: "edit"; readonly value: UpdateBlogPost }
  | { readonly ok: false; readonly errors: BlogFieldErrors };

const FIELD_ERROR_KEYS: Readonly<Record<BlogFormError, string>> = {
  REQUIRED: "fieldErrors.REQUIRED",
  TOO_LONG: "fieldErrors.TOO_LONG",
  INVALID_SLUG: "fieldErrors.INVALID_SLUG",
  INVALID: "fieldErrors.INVALID",
};

const TRANSLATE_ERROR_KEYS = {
  NOT_CONFIGURED: "translateErrors.NOT_CONFIGURED",
  INVALID_KEY: "translateErrors.INVALID_KEY",
  QUOTA_EXCEEDED: "translateErrors.QUOTA_EXCEEDED",
  RATE_LIMITED: "translateErrors.RATE_LIMITED",
  UNSUPPORTED_LANGUAGE: "translateErrors.UNSUPPORTED_LANGUAGE",
  VENDOR_UNAVAILABLE: "translateErrors.VENDOR_UNAVAILABLE",
  VENDOR_TIMEOUT: "translateErrors.VENDOR_TIMEOUT",
  MALFORMED_RESPONSE: "translateErrors.MALFORMED_RESPONSE",
  EMPTY_SOURCE: "translateErrors.EMPTY_SOURCE",
} as const;

const LOCALES: readonly Locale[] = ["es", "en"];

const LEGEND_CLASS =
  "mb-2 p-0 text-[11px] font-semibold tracking-[0.06em] text-[var(--label-secondary)] uppercase";

export function BlogPostEditor({ post }: BlogPostEditorProps) {
  const t = useTranslations("admin.blog");
  const router = useRouter();
  const formId = useId();
  const mode = post === undefined ? "create" : "edit";

  const [values, setValues] = useState<BlogFormValues>(() => toBlogFormValues(post));
  const [errors, setErrors] = useState<BlogFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [translating, setTranslating] = useState<Locale | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [machineTranslated, setMachineTranslated] = useState<ReadonlySet<Locale>>(new Set());

  function patchCopy(locale: Locale, next: Partial<BlogCopy>): void {
    setValues((current) => ({
      ...current,
      copy: { ...current.copy, [locale]: { ...current.copy[locale], ...next } },
    }));
    // Any human edit counts as a review of that locale's machine translation.
    setMachineTranslated((current) => {
      if (!current.has(locale)) return current;
      const copy = new Set(current);
      copy.delete(locale);
      return copy;
    });
  }

  function errorProp(field: string): { readonly error?: string } {
    const code = errors[field];
    return code === undefined ? {} : { error: t(FIELD_ERROR_KEYS[code]) };
  }

  async function translateInto(target: Locale): Promise<void> {
    const source: Locale = target === "es" ? "en" : "es";
    setTranslateError(null);
    setTranslating(target);
    try {
      const result = await translateBlogCopyAction({
        from: source,
        to: target,
        copy: values.copy[source],
      });
      if (!result.ok) {
        const reason = translateCopyReasonOf(result.reason);
        setTranslateError(t(reason === null ? "translateFailed" : TRANSLATE_ERROR_KEYS[reason]));
        return;
      }
      setValues((current) => ({
        ...current,
        copy: { ...current.copy, [target]: result.data },
      }));
      setMachineTranslated((current) => new Set(current).add(target));
    } catch {
      setTranslateError(t("translateFailed"));
    } finally {
      setTranslating(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const built = buildBlogPostPayload(values, mode);
    if (!built.ok) {
      setErrors(built.errors);
      setFormError(t("form.fixErrors"));
      return;
    }

    setErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      if (built.mode === "create") {
        const created = await createBlogPostAction(built.value);
        if (!created.ok) {
          setFormError(t(actionErrorKey(created.code)));
          return;
        }
        router.push(`/admin/blog/${created.data.id}`);
        return;
      }
      if (post === undefined) return;
      const updated = await updateBlogPostAction(post.id, built.value);
      if (!updated.ok) {
        setFormError(t(actionErrorKey(updated.code)));
        return;
      }
      router.refresh();
    } catch {
      setFormError(t("errors.UNKNOWN"));
    } finally {
      setSubmitting(false);
    }
  }

  const categoryOptions = blogCategorySchema.options.map((category) => ({
    value: category,
    label: t(`categories.${category}`),
  }));

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-describedby={`${formId}-error`}
      className="grid gap-[var(--card-p)]"
    >
      <fieldset className="m-0 min-w-0 border-0 p-0" disabled={submitting}>
        <legend className={LEGEND_CLASS}>{t("form.sectionPost")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t("form.slugLabel")}
            name="slug"
            id={`${formId}-slug`}
            value={values.slug}
            onChange={(next) => setValues((current) => ({ ...current, slug: next }))}
            maxLength={160}
            required
            mono
            hint={t("form.slugHint")}
            {...errorProp("slug")}
          />
          <PopupButton<BlogCategory>
            label={t("form.categoryLabel")}
            name="category"
            id={`${formId}-category`}
            value={values.category}
            options={categoryOptions}
            onChange={(next) => setValues((current) => ({ ...current, category: next }))}
          />
        </div>
      </fieldset>

      {post === undefined ? (
        <Notice tone="progress" placement="inline">
          {t("form.coverAfterCreate")}
        </Notice>
      ) : (
        <BlogCoverField post={post} />
      )}

      <Checkbox
        label={t("form.includeEnglish")}
        name="includeEnglish"
        checked={values.includeEnglish}
        onChange={(checked) => setValues((current) => ({ ...current, includeEnglish: checked }))}
        disabled={submitting}
      />

      {translateError === null ? null : (
        <Notice tone="danger" placement="inline">
          {translateError}
        </Notice>
      )}

      {LOCALES.filter((locale) => locale === "es" || values.includeEnglish).map((locale) => {
        const copy = values.copy[locale];
        const other: Locale = locale === "es" ? "en" : "es";
        const canTranslate = locale === "es" ? values.includeEnglish : true;
        return (
          <fieldset
            key={locale}
            className="m-0 grid min-w-0 gap-3 border-0 p-0"
            disabled={submitting}
            data-testid={`blog-locale-${locale}`}
          >
            <legend className={LEGEND_CLASS}>{t(`form.locales.${locale}`)}</legend>

            {canTranslate ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="standard"
                  size="compact"
                  pending={translating === locale}
                  pendingLabel={t("translating")}
                  disabled={translating !== null}
                  onClick={() => {
                    void translateInto(locale);
                  }}
                >
                  {t("translate", { language: t(`form.languageNames.${other}`) })}
                </Button>
              </div>
            ) : null}

            {machineTranslated.has(locale) ? (
              <Notice tone="warning" placement="inline">
                {t("machineTranslated")}
              </Notice>
            ) : null}

            <TextField
              label={t("form.titleLabel")}
              name={`${locale}-title`}
              value={copy.title}
              onChange={(next) => patchCopy(locale, { title: next })}
              maxLength={200}
              required
              {...errorProp(`${locale}.title`)}
            />
            <TextArea
              label={t("form.excerptLabel")}
              name={`${locale}-excerpt`}
              value={copy.excerpt}
              onChange={(next) => patchCopy(locale, { excerpt: next })}
              rows={3}
              maxLength={500}
              required
              hint={t("form.excerptHint")}
              {...errorProp(`${locale}.excerpt`)}
            />
            <TextArea
              label={t("form.bodyLabel")}
              name={`${locale}-body`}
              value={copy.bodyHtml}
              onChange={(next) => patchCopy(locale, { bodyHtml: next })}
              rows={14}
              required
              hint={t("form.bodyHint")}
              {...errorProp(`${locale}.bodyHtml`)}
            />
            <RichTextPreview
              html={copy.bodyHtml}
              label={t("form.previewLabel")}
              emptyLabel={t("form.previewEmpty")}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={t("form.metaTitleLabel")}
                name={`${locale}-metaTitle`}
                value={copy.metaTitle}
                onChange={(next) => patchCopy(locale, { metaTitle: next })}
                maxLength={200}
                hint={t("form.metaTitleHint")}
                {...errorProp(`${locale}.metaTitle`)}
              />
              <TextField
                label={t("form.coverAltLabel")}
                name={`${locale}-coverAlt`}
                value={copy.coverAlt}
                onChange={(next) => patchCopy(locale, { coverAlt: next })}
                maxLength={300}
                hint={t("form.coverAltHint")}
                {...errorProp(`${locale}.coverAlt`)}
              />
            </div>
            <TextArea
              label={t("form.metaDescriptionLabel")}
              name={`${locale}-metaDescription`}
              value={copy.metaDescription}
              onChange={(next) => patchCopy(locale, { metaDescription: next })}
              rows={2}
              maxLength={320}
              hint={t("form.metaDescriptionHint")}
              {...errorProp(`${locale}.metaDescription`)}
            />
          </fieldset>
        );
      })}

      <div id={`${formId}-error`}>
        {formError === null ? null : (
          <Notice tone="danger" placement="inline">
            {formError}
          </Notice>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--separator-weak)] pt-[var(--card-p)]">
        {post === undefined ? null : (
          <TypeToConfirmButton
            phrase={post.slug}
            triggerLabel={t("delete.trigger")}
            title={t("delete.title")}
            body={t("delete.body")}
            prompt={t.rich("delete.prompt", {
              phrase: post.slug,
              mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
            })}
            confirmLabel={t("delete.confirm")}
            busyLabel={t("delete.busy")}
            cancelLabel={t("delete.cancel")}
            fallbackError={t("delete.fallback")}
            onConfirm={async () => {
              const deleted = await deleteBlogPostAction(post.id);
              if (!deleted.ok) {
                throw new ConfirmActionError(t(actionErrorKey(deleted.code)));
              }
              router.push("/admin/blog");
              router.refresh();
            }}
          />
        )}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Link href="/admin/blog" className={buttonClassName({ variant: "standard" })}>
            {t("form.cancel")}
          </Link>
          <Button
            type="submit"
            variant="prominent"
            pending={submitting}
            pendingLabel={t("form.submitting")}
          >
            {mode === "create" ? t("form.submitCreate") : t("form.submitSave")}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for direct testing.
// ---------------------------------------------------------------------------

export function toBlogFormValues(post: AdminBlogPost | undefined): BlogFormValues {
  if (post === undefined) {
    return {
      slug: "",
      category: "PEPTIDES",
      includeEnglish: false,
      copy: { es: EMPTY_BLOG_COPY, en: EMPTY_BLOG_COPY },
    };
  }
  const es = post.translations.find((entry) => entry.locale === "es");
  const en = post.translations.find((entry) => entry.locale === "en");
  return {
    slug: post.slug,
    category: post.category,
    includeEnglish: en !== undefined,
    copy: { es: toBlogCopy(es), en: toBlogCopy(en) },
  };
}

const LIMITS = {
  title: 200,
  excerpt: 500,
  bodyHtml: 100_000,
  metaTitle: 200,
  metaDescription: 320,
  coverAlt: 300,
} as const satisfies Readonly<Record<keyof BlogCopy, number>>;

const REQUIRED_FIELDS = ["title", "excerpt", "bodyHtml"] as const;

/**
 * Validate the form and build the request.
 *
 * Checked field by field first so each message lands under its own input, then
 * parsed through the SAME contract schema the API applies, so the request the
 * action forwards is the request the API would accept.
 */
export function buildBlogPostPayload(
  values: BlogFormValues,
  mode: "create" | "edit",
): BlogBuildResult {
  const errors: Record<string, BlogFormError> = {};

  const slug = values.slug.trim();
  if (slug.length === 0) {
    errors["slug"] = "REQUIRED";
  } else if (!slugSchema.safeParse(slug).success) {
    errors["slug"] = "INVALID_SLUG";
  }

  const locales: readonly Locale[] = values.includeEnglish ? ["es", "en"] : ["es"];
  const translations: BlogPostTranslationInput[] = [];

  for (const locale of locales) {
    const copy = values.copy[locale];
    for (const field of REQUIRED_FIELDS) {
      if (copy[field].trim().length === 0) errors[`${locale}.${field}`] = "REQUIRED";
    }
    for (const field of BLOG_COPY_FIELDS) {
      if (copy[field].trim().length > LIMITS[field]) errors[`${locale}.${field}`] = "TOO_LONG";
    }
    translations.push({
      locale,
      title: copy.title.trim(),
      excerpt: copy.excerpt.trim(),
      bodyHtml: copy.bodyHtml.trim(),
      metaTitle: blankToNull(copy.metaTitle),
      metaDescription: blankToNull(copy.metaDescription),
      coverAlt: copy.coverAlt.trim(),
    });
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const shared = { slug, category: values.category, translations };

  if (mode === "create") {
    const parsed = createBlogPostSchema.safeParse(shared);
    return parsed.success
      ? { ok: true, mode: "create", value: parsed.data }
      : { ok: false, errors: collectIssues(parsed.error.issues) };
  }
  const parsed = updateBlogPostSchema.safeParse(shared);
  return parsed.success
    ? { ok: true, mode: "edit", value: parsed.data }
    : { ok: false, errors: collectIssues(parsed.error.issues) };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function collectIssues(issues: readonly z.ZodIssue[]): BlogFieldErrors {
  const errors: Record<string, BlogFormError> = {};
  for (const issue of issues) {
    const [head] = issue.path;
    errors[typeof head === "string" ? head : "form"] ??= "INVALID";
  }
  return errors;
}
