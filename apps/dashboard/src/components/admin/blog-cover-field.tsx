"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AdminBlogPost } from "@akai/contracts";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useRouter } from "next/navigation";
import { createBlogCoverUploadUrlAction, updateBlogPostAction } from "@/lib/admin/actions";
import { uploadBlogCover } from "@/lib/admin/upload-blog-cover";
import type { UploadFailure } from "@/lib/admin/upload-product-image";

import { ImageDropzone } from "./image-dropzone";

/**
 * A post's cover image (decision D8a: the ONLY image a v1 post has).
 *
 * The existing `ImageDropzone` for the drop target and `uploadBlogCover` for
 * the sign → PUT → record sequence. Saved immediately rather than with the
 * form: the bytes are already in storage by the time the key is recorded, and
 * holding a recorded-nowhere upload until the operator remembers to press Save
 * is how orphaned objects accumulate.
 */
export interface BlogCoverFieldProps {
  readonly post: AdminBlogPost;
}

const FAILURE_KEYS: Readonly<Record<UploadFailure, string>> = {
  tooLarge: "cover.errors.tooLarge",
  notAnImage: "cover.errors.notAnImage",
  signFailed: "cover.errors.signFailed",
  uploadFailed: "cover.errors.uploadFailed",
  attachFailed: "cover.errors.attachFailed",
};

export function BlogCoverField({ post }: BlogCoverFieldProps) {
  const t = useTranslations("admin.blog");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  async function handleFiles(files: FileList | null): Promise<void> {
    const file = files?.item(0) ?? null;
    if (file === null) return;
    setError(null);
    setBusy(true);
    try {
      const outcome = await uploadBlogCover(
        {
          requestUpload: createBlogCoverUploadUrlAction,
          attach: (postId, coverObjectKey) => updateBlogPostAction(postId, { coverObjectKey }),
        },
        { postId: post.id, file },
      );
      if (!outcome.ok) {
        setError(t(FAILURE_KEYS[outcome.reason]));
        return;
      }
      router.refresh();
    } catch {
      setError(t("cover.errors.uploadFailed"));
    } finally {
      setBusy(false);
      setResetKey((key) => key + 1);
    }
  }

  async function removeCover(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await updateBlogPostAction(post.id, { coverObjectKey: null });
      if (!result.ok) {
        setError(t("cover.errors.attachFailed"));
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-2" aria-label={t("cover.title")}>
      <p className="m-0 text-[11px] font-semibold tracking-[0.06em] text-[var(--label-secondary)] uppercase">
        {t("cover.title")}
      </p>
      {post.coverUrl === null ? null : (
        <div className="flex flex-wrap items-end gap-3">
          {/* A plain <img>: an operator preview of our own bucket, not a
              storefront render that would need next/image's optimiser. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={post.coverUrl}
            alt={t("cover.currentAlt")}
            className="h-[120px] w-auto rounded-[var(--r-control)] border border-[var(--separator-weak)] object-cover"
          />
          <Button
            type="button"
            variant="standard"
            size="compact"
            disabled={busy}
            onClick={() => {
              void removeCover();
            }}
          >
            {t("cover.remove")}
          </Button>
        </div>
      )}
      <ImageDropzone
        onFiles={(files) => {
          void handleFiles(files);
        }}
        disabled={busy}
        resetKey={resetKey}
        busyLabel={busy ? t("cover.uploading") : undefined}
      />
      {error === null ? null : (
        <Notice tone="danger" placement="inline">
          {error}
        </Notice>
      )}
    </section>
  );
}
