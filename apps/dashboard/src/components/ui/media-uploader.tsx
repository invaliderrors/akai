"use client";

import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

import { ImageDropzone } from "@/components/admin/image-dropzone";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/admin/actions";
import { uploadProductImage, type UploadDeps, type UploadFailure } from "@/lib/admin/upload-product-image";

import { Button, IconButton } from "./button";
import { TextField } from "./field";
import { Icon } from "./icon";
import { Notice } from "./notice";
import { TOAST_DWELL_MS, useToast } from "./toast";

/**
 * ONE product-image uploader, before and after the product exists.
 *
 * IT REPLACES TWO COMPONENTS THAT DIFFERED IN EXACTLY ONE THING. `staged-image-picker`
 * held files in the browser because the presign endpoint is scoped to a
 * `productId` and no object key can be issued before the product row does;
 * `product-media-manager` uploaded straight away because by then there was an id.
 * Everything else about them — the grid, the primary marker, the alt
 * text, the remove affordance — was the same idea written twice, and the two
 * copies had already drifted (one showed a hint, one showed an empty state, only
 * one measured dimensions). `mode` now carries the single real difference.
 *
 * THE FILE STILL NEVER PASSES THROUGH THIS APP OR THE API. Live mode calls
 * `uploadProductImage`, which presigns, PUTs the bytes straight to storage, and
 * only THEN records the object against the product. That order is the property
 * worth protecting: recording first produces a product row pointing at a URL
 * that 404s until the PUT lands, if it ever does. This component adds no second
 * copy of that dance — it calls the one in `lib/admin/upload-product-image.ts`.
 *
 * WHY EVERY STRING IS A PROP. The copy this needs is split across two message
 * namespaces that do not both exist: `admin.productMedia`, which is live, and
 * the `ui` namespace of shared a11y labels (reorder, remove, undo), which is a
 * planned single-owner catalogue change that has not landed. Reading one and
 * taking the other as props would put one component's copy in two places, so it
 * takes all of it as props — the same call `ui/pagination.tsx` made one file
 * over, for the same reason. `ImageDropzone` is the one exception and keeps its
 * own `useTranslations`, because its wording is frozen by the item that restyled
 * it and one of its strings is what a shipped test finds the file input by.
 *
 * MOUNT IT INSIDE A `<ToastProvider>`. `useToast` throws otherwise, deliberately
 * — a removal that offers an undo nobody can see is worse than a loud crash in
 * development.
 */

// ---------------------------------------------------------------------------
// Value shapes
// ---------------------------------------------------------------------------

/**
 * An image chosen BEFORE the product exists, held in the browser.
 *
 * Structurally identical to `admin/staged-image-picker`'s own `StagedImage`, so
 * the create form can move onto this component without touching its state.
 */
export interface StagedImage {
  readonly file: File;
  readonly previewUrl: string;
  readonly alt: string;
}

/** An image already stored against a product. */
export interface ProductMediaItem {
  readonly id: string;
  readonly url: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly sortOrder: number;
}

/**
 * Everything that can go wrong, as a closed set.
 *
 * `UploadFailure` comes from the upload lib, so a new failure mode there becomes
 * a missing key here — a compile error — rather than a blank alert.
 */
export type MediaUploaderError = UploadFailure | "removeFailed" | "reorderFailed" | "generic";

export interface MediaUploaderLabels {
  /** No images at all. "Este producto no tiene imágenes todavía." */
  readonly empty: string;
  /** Staged mode only: what will happen to these files. */
  readonly stagedHint: string;
  /** The marker on the first tile. "Principal" */
  readonly primary: string;
  /** Accessible name of a tile's remove button, given its file name. */
  readonly remove: (name: string) => string;
  /**
   * The undo toast's body.
   *
   * Do NOT phrase it as a countdown. The deletion is deferred by
   * `TOAST_DWELL_MS` and is CANCELLED if the operator navigates away inside the
   * window, so "se borra en 8 s" would be a promise this component sometimes
   * keeps and sometimes does not. The safe half is the one that happens: the
   * image survives.
   */
  readonly removed: string;
  /** The toast's action. "Deshacer" */
  readonly undo: string;
  /** Accessible name of the grip, which is also a keyboard control. */
  readonly reorder: (position: { name: string; index: number; total: number }) => string;
  /** Accessible name of the tile itself, which selects it for alt editing. */
  readonly select: (name: string) => string;
  /** The PUT is in flight. "Subiendo…" */
  readonly uploading: string;
  /** The bytes landed and the record is being written. "Guardando…" */
  readonly saving: string;
  /** Live mode: commits the selected draft. "Subir" */
  readonly upload: string;
  /** Heading of the alt-text group. "Texto alternativo" */
  readonly altHeading: string;
  /** The alt-text field's label. */
  readonly alt: string;
  /** Shown while the alt text is blank. */
  readonly altRequired: string;
  readonly errors: Readonly<Record<MediaUploaderError, string>>;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MediaUploaderCommonProps {
  readonly labels: MediaUploaderLabels;
  readonly disabled?: boolean;
  readonly className?: string;
}

export interface StagedMediaUploaderProps extends MediaUploaderCommonProps {
  readonly mode: "staged";
  readonly images: readonly StagedImage[];
  readonly onChange: (images: readonly StagedImage[]) => void;

  // Present-and-undefined so a caller cannot pass a live prop into staged mode.
  // TypeScript's excess-property check accepts a key that appears in ANY member
  // of a union, so without these `mode="staged" onRemove={…}` would compile and
  // the handler would be silently dropped.
  readonly productId?: undefined;
  readonly items?: undefined;
  readonly onRequestUpload?: undefined;
  readonly onAttach?: undefined;
  readonly onRemove?: undefined;
  readonly onReorder?: undefined;
}

export interface LiveMediaUploaderProps extends MediaUploaderCommonProps {
  readonly mode: "live";
  readonly productId: string;
  readonly items: readonly ProductMediaItem[];
  /** Typed off `UploadDeps` so this pair can never drift from the lib that uses it. */
  readonly onRequestUpload: UploadDeps["requestUpload"];
  readonly onAttach: UploadDeps["attach"];
  readonly onRemove: (productId: string, mediaId: string) => Promise<ActionResult<unknown>>;
  /**
   * Persists a new order. OPTIONAL, and its absence hides the grips.
   *
   * The API exposes exactly three media routes — presign, attach, delete — and
   * none of them reorders. A grip that moves a tile the server will re-sort on
   * the next render is a lie about saved state, so when there is nothing to
   * persist to, there is no handle. Staged mode always has handles, because
   * there the order IS the value.
   */
  readonly onReorder?: (productId: string, mediaIds: readonly string[]) => Promise<ActionResult<unknown>>;

  readonly images?: undefined;
  readonly onChange?: undefined;
}

export type MediaUploaderProps = StagedMediaUploaderProps | LiveMediaUploaderProps;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * How far along a not-yet-stored image is.
 *
 * `draft` is a file the operator has chosen and not committed; the other two are
 * the two halves of the upload that can be observed from outside the lib.
 */
type UploadPhase = "draft" | "uploading" | "saving";

interface DraftUpload {
  readonly key: string;
  readonly file: File;
  readonly previewUrl: string;
  readonly alt: string;
  readonly phase: UploadPhase;
}

/** The one shape the grid renders, whichever mode produced it. */
interface Tile {
  readonly key: string;
  readonly previewUrl: string;
  readonly name: string;
  readonly alt: string;
  /** `null` once the image is stored. */
  readonly phase: UploadPhase | null;
  /** The server's id, when there is one. */
  readonly mediaId: string | null;
}

/**
 * The bar is DETERMINATE BY PHASE, not by bytes.
 *
 * `fetch` reports no upload progress, and the PUT lives inside
 * `uploadProductImage` precisely so its presign → PUT → attach ordering has one
 * implementation. Rewriting that around `XMLHttpRequest` to win a percentage
 * would move the ordering out of the file that guarantees it. So the bar
 * advances monotonically through the two observable phases and `aria-valuetext`
 * announces the PHASE rather than a number — a screen reader saying "sixty-five
 * percent" about a step boundary is the part that would actually be false.
 */
const PHASE_FRACTION: Readonly<Record<UploadPhase, number>> = {
  draft: 0,
  uploading: 0.65,
  saving: 0.9,
};

function moved<T>(list: readonly T[], from: number, to: number): readonly T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  // `splice` is typed as returning T[], which under noUncheckedIndexedAccess
  // still yields `T | undefined` on destructure. The guard above makes this
  // unreachable; narrowing it beats asserting it.
  if (item === undefined) return list;
  next.splice(to, 0, item);
  return next;
}

/**
 * The file name for a stored image, which the API does not return.
 *
 * It is display-only — the operator recognises "camiseta-front.jpg" and does not
 * recognise a UUID — so a URL that cannot be parsed falls back to the id rather
 * than throwing on a page whose only job is showing pictures.
 */
function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const segments = new URL(url).pathname.split("/");
    const last = segments[segments.length - 1];
    return last === undefined || last === "" ? fallback : decodeURIComponent(last);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MediaUploader(props: MediaUploaderProps) {
  const { labels, disabled = false, className } = props;
  const router = useRouter();
  const toast = useToast();
  const groupId = useId();

  const [drafts, setDrafts] = useState<readonly DraftUpload[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<MediaUploaderError | null>(null);
  const [resetKey, setResetKey] = useState(0);
  /** Removed on screen, not yet removed on the server. See `removeStored`. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** Optimistic media order, applied while it still describes the same set. */
  const [order, setOrder] = useState<readonly string[] | null>(null);
  /** The tile whose grip is currently held down — see the grip's `onMouseDown`. */
  const [armed, setArmed] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const draftSeq = useRef(0);
  const objectUrls = useRef(new Set<string>());
  const deletions = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /**
   * Object URLs are a document-lifetime leak until revoked, and this component
   * unmounts on navigation right after a create.
   *
   * Every URL it has ever minted is revoked here — not just the ones present at
   * mount — because a removal is undoable for eight seconds, so a preview has to
   * outlive the removal that took it off screen, and previews created after
   * mount are the common case rather than the exception. The scheduled deletions
   * are cleared for the opposite reason: firing a server write out of a cleanup
   * is how an operator who navigated away loses an image they never confirmed.
   */
  useEffect(() => {
    const urls = objectUrls.current;
    const timers = deletions.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
    // Deliberately on unmount only: revoking on every change would kill the
    // preview of an image the operator is still looking at. The picker this
    // replaces needed an exhaustive-deps disable here because it closed over
    // `images`; reading the two refs instead makes the empty dep array honest,
    // so the directive is gone rather than carried over stale.
  }, []);

  const createPreview = useCallback((file: File): string => {
    const url = URL.createObjectURL(file);
    objectUrls.current.add(url);
    return url;
  }, []);

  // -------------------------------------------------------------------------
  // The one list the grid renders
  // -------------------------------------------------------------------------

  const stagedImages = props.mode === "staged" ? props.images : [];

  const storedTiles: readonly Tile[] =
    props.mode === "live"
      ? applyOrder(props.items, order)
          .filter((item) => !hidden.has(item.id))
          .map((item) => ({
            key: `media:${item.id}`,
            previewUrl: item.url,
            name: fileNameFromUrl(item.url, item.id),
            alt: item.alt,
            phase: null,
            mediaId: item.id,
          }))
      : [];

  const stagedTiles: readonly Tile[] = stagedImages.map((image) => ({
    // Keyed by the object URL, which is unique per file and stable across a
    // reorder — an index key would remount the tile being dragged and drop the
    // grip's focus mid-move.
    key: image.previewUrl,
    previewUrl: image.previewUrl,
    name: image.file.name,
    alt: image.alt,
    phase: "draft",
    mediaId: null,
  }));

  const draftTiles: readonly Tile[] = drafts.map((draft) => ({
    key: draft.key,
    previewUrl: draft.previewUrl,
    name: draft.file.name,
    alt: draft.alt,
    phase: draft.phase,
    mediaId: null,
  }));

  const tiles: readonly Tile[] = props.mode === "staged" ? stagedTiles : [...storedTiles, ...draftTiles];

  const selected = tiles.find((tile) => tile.key === selectedKey) ?? tiles[0];

  /**
   * How many leading tiles participate in a reorder.
   *
   * Drafts are always appended, so the reorderable tiles are a contiguous prefix
   * and one count describes them. Zero means no grips at all.
   */
  const reorderableCount =
    props.mode === "staged" ? tiles.length : props.onReorder === undefined ? 0 : storedTiles.length;

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  // A ref rather than the closure, so a toast raised eight seconds ago restores
  // into the list as it stands now.
  const latestImages = useRef<readonly StagedImage[]>(stagedImages);
  latestImages.current = stagedImages;


  function addFiles(files: FileList | null): void {
    if (files === null || files.length === 0) return;
    const chosen = [...files].map((file) => ({ file, previewUrl: createPreview(file) }));

    // Re-key the input so picking the SAME file again still fires a change.
    setResetKey((key) => key + 1);

    if (props.mode === "staged") {
      const added = chosen.map(({ file, previewUrl }) => ({ file, previewUrl, alt: "" }));
      props.onChange([...props.images, ...added]);
      setSelectedKey(added[0]?.previewUrl ?? null);
      return;
    }

    const added = chosen.map(({ file, previewUrl }) => {
      draftSeq.current += 1;
      return {
        key: `draft:${String(draftSeq.current)}`,
        file,
        previewUrl,
        alt: "",
        phase: "draft" as const,
      };
    });
    setDrafts((current) => [...current, ...added]);
    setSelectedKey(added[0]?.key ?? null);
  }

  function patchAlt(tile: Tile, patch: { readonly alt: string }): void {
    if (props.mode === "staged") {
      props.onChange(
        props.images.map((image) => (image.previewUrl === tile.key ? { ...image, ...patch } : image)),
      );
      return;
    }
    setDrafts((current) => current.map((draft) => (draft.key === tile.key ? { ...draft, ...patch } : draft)));
  }

  function moveTile(from: number, to: number): void {
    if (to < 0 || to >= reorderableCount) return;

    if (props.mode === "staged") {
      props.onChange(moved(props.images, from, to));
      return;
    }

    const { onReorder, productId } = props;
    if (onReorder === undefined) return;
    const ids = moved(
      storedTiles.map((tile) => tile.mediaId).filter((id): id is string => id !== null),
      from,
      to,
    );
    setOrder(ids);
    void (async () => {
      const result = await onReorder(productId, ids);
      if (!result.ok) {
        // Drop the optimistic order rather than leaving the operator looking at
        // an arrangement the server rejected.
        setOrder(null);
        setErrorKey("reorderFailed");
        return;
      }
      router.refresh();
    })();
  }

  function removeStaged(tile: Tile): void {
    if (props.mode !== "staged") return;
    const index = props.images.findIndex((image) => image.previewUrl === tile.key);
    const target = props.images[index];
    if (target === undefined) return;

    props.onChange(props.images.filter((_, position) => position !== index));
    toast.show({
      tone: "success",
      message: labels.removed,
      action: {
        label: labels.undo,
        // The CURRENT list, read at press time. The array captured when the
        // toast was raised is stale the moment anything else is added, and
        // restoring over it would silently drop that addition.
        onAction: () => {
          const current = latestImages.current;
          const restored = [...current];
          restored.splice(Math.min(index, restored.length), 0, target);
          props.onChange(restored);
        },
      },
    });
    // The preview is NOT revoked: undo has to be able to show it again. The
    // unmount effect is what releases it.
  }

  function removeStored(tile: Tile): void {
    if (props.mode !== "live") return;
    const mediaId = tile.mediaId;
    if (mediaId === null) {
      setDrafts((current) => current.filter((draft) => draft.key !== tile.key));
      return;
    }

    const { onRemove, productId } = props;

    /**
     * The deletion is DEFERRED, not undone.
     *
     * The API can delete a media row and cannot resurrect one: an undo after the
     * fact would have to re-attach, and the object key that would need is not in
     * anything this component holds. So the tile leaves the screen immediately,
     * the write waits out the undo window, and pressing Deshacer simply cancels
     * a request that never went.
     */
    setHidden((current) => new Set(current).add(mediaId));

    const timer = setTimeout(() => {
      deletions.current.delete(mediaId);
      void (async () => {
        try {
          const result = await onRemove(productId, mediaId);
          if (!result.ok) {
            setErrorKey("removeFailed");
            setHidden((current) => without(current, mediaId));
            return;
          }
          router.refresh();
        } catch {
          setErrorKey("generic");
          setHidden((current) => without(current, mediaId));
        }
      })();
    }, TOAST_DWELL_MS);
    deletions.current.set(mediaId, timer);

    toast.show({
      tone: "success",
      message: labels.removed,
      action: {
        label: labels.undo,
        onAction: () => {
          const pending = deletions.current.get(mediaId);
          if (pending !== undefined) clearTimeout(pending);
          deletions.current.delete(mediaId);
          setHidden((current) => without(current, mediaId));
        },
      },
    });
  }

  async function uploadDraft(draft: DraftUpload): Promise<void> {
    if (props.mode !== "live") return;
    const { onRequestUpload, onAttach, productId } = props;

    setErrorKey(null);
    setPhase(draft.key, "uploading");

    try {
      const outcome = await uploadProductImage(
        {
          requestUpload: onRequestUpload,
          // Wrapping `attach` is the only way to see the second phase from out
          // here without a second copy of the ordering inside this component.
          attach: (id, input) => {
            setPhase(draft.key, "saving");
            return onAttach(id, input);
          },
        },
        {
          productId,
          file: draft.file,
          alt: draft.alt.trim(),
          // Appended. The storefront shows the LOWEST sortOrder, so a new upload
          // must not silently become the product's main image.
          sortOrder: storedTiles.length,
        },
      );

      if (!outcome.ok) {
        setErrorKey(outcome.reason);
        setPhase(draft.key, "draft");
        return;
      }

      setDrafts((current) => current.filter((entry) => entry.key !== draft.key));
      // The page is server-rendered; without this the new image would not show.
      router.refresh();
    } catch {
      setErrorKey("generic");
      setPhase(draft.key, "draft");
    }
  }

  function setPhase(key: string, phase: UploadPhase): void {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, phase } : draft)));
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const selectedDraft = selected === undefined ? undefined : drafts.find((draft) => draft.key === selected.key);
  const altEditable = selected !== undefined && (props.mode === "staged" || selectedDraft !== undefined);
  const altMissing = selected !== undefined && selected.alt.trim() === "";
  const busy = drafts.some((draft) => draft.phase !== "draft");

  return (
    <div className={`grid gap-3${className === undefined ? "" : ` ${className}`}`}>
      {errorKey !== null && <Notice tone="danger">{labels.errors[errorKey]}</Notice>}

      {props.mode === "staged" && (
        <p className="text-[11px] text-[var(--label-secondary)]">{labels.stagedHint}</p>
      )}

      {tiles.length === 0 && <p className="text-[13px] text-[var(--label-secondary)]">{labels.empty}</p>}

      <ul
        className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-[10px]"
        // Kept from `product-media-manager`, where a shipped test reads it. It is
        // the one id in this file; everything else is reachable by role or name.
        {...(props.mode === "live" ? { "data-testid": "product-media-list" } : {})}
      >
        {tiles.map((tile, index) => {
          const isSelected = selected !== undefined && selected.key === tile.key;
          const canReorder = index < reorderableCount && !disabled;
          const fraction = tile.phase === null ? 0 : PHASE_FRACTION[tile.phase];
          const phaseLabel = tile.phase === "saving" ? labels.saving : labels.uploading;

          return (
            <li
              key={tile.key}
              draggable={armed === tile.key}
              onDragStart={(event: DragEvent<HTMLLIElement>) => {
                setDragging(index);
                // React types this as always present; a synthetic drag event
                // fired by a test carries no DataTransfer, and Firefox refuses
                // to start a drag unless something was set on it.
                const payload: DataTransfer | null = event.dataTransfer;
                if (payload !== null) {
                  payload.effectAllowed = "move";
                  payload.setData("text/plain", tile.key);
                }
              }}
              onDragOver={(event: DragEvent<HTMLLIElement>) => {
                // Without preventDefault the drop never fires and the browser
                // treats the gesture as a navigation.
                if (dragging !== null && canReorder) event.preventDefault();
              }}
              onDrop={(event: DragEvent<HTMLLIElement>) => {
                event.preventDefault();
                if (dragging !== null && canReorder) moveTile(dragging, index);
                setDragging(null);
                setArmed(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setArmed(null);
              }}
              className={`relative overflow-hidden rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] ${
                isSelected ? "shadow-[0_0_0_2px_var(--accent)]" : "shadow-[var(--e-0)]"
              }`}
            >
              <button
                type="button"
                onClick={() => setSelectedKey(tile.key)}
                aria-pressed={isSelected}
                aria-label={labels.select(tile.name)}
                disabled={disabled}
                className="block aspect-square w-full cursor-pointer focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_4px_var(--focus-ring)]"
              >
                {/* A plain <img>, deliberately. These are admin thumbnails —
                    half of them local object URLs for a file picked a second
                    ago — so there is nothing for next/image to optimise, and
                    using it would mean listing every storage host in this app's
                    remotePatterns so an operator can see their own upload. */}
                {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
                <img
                  src={tile.previewUrl}
                  alt=""
                  className={`h-full w-full object-cover${tile.phase === "draft" || tile.phase === null ? "" : " opacity-50"}`}
                />
              </button>

              {index === 0 && (
                <span className="pointer-events-none absolute left-[6px] top-[6px] inline-flex h-[18px] items-center gap-[3px] rounded-[var(--r-pill)] bg-[var(--accent)] px-[6px] text-[10px] font-semibold text-[var(--label-on-accent)]">
                  <Icon name="star" size={10} />
                  {labels.primary}
                </span>
              )}

              {canReorder && (
                <button
                  type="button"
                  aria-label={labels.reorder({ name: tile.name, index: index + 1, total: reorderableCount })}
                  // Arming on mousedown is what makes this a HANDLE rather than a
                  // draggable tile: the <li> is only draggable while the grip is
                  // held, so a drag started anywhere else does nothing.
                  onMouseDown={() => setArmed(tile.key)}
                  onMouseUp={() => setArmed(null)}
                  onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                    // The keyboard equivalent of the drag. Without it the whole
                    // reorder affordance is pointer-only, which is the usual way
                    // a drag-and-drop list becomes unusable.
                    const delta =
                      event.key === "ArrowLeft" || event.key === "ArrowUp"
                        ? -1
                        : event.key === "ArrowRight" || event.key === "ArrowDown"
                          ? 1
                          : 0;
                    if (delta === 0) return;
                    event.preventDefault();
                    moveTile(index, index + delta);
                  }}
                  className="absolute right-[6px] top-[6px] inline-flex h-5 w-5 cursor-grab items-center justify-center rounded-[var(--r-check)] bg-[var(--glass-fill-strong)] text-[var(--label-secondary)] active:cursor-grabbing focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--focus-ring)]"
                >
                  <Icon name="grip-vertical" size={12} />
                </button>
              )}

              {tile.phase !== null && tile.phase !== "draft" && (
                <div className="pointer-events-none absolute inset-x-2 top-1/2 grid -translate-y-1/2 gap-[6px]">
                  <span className="text-center text-[11px] text-[var(--neutral-text)]">{phaseLabel}</span>
                  <span
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(fraction * 100)}
                    aria-valuetext={phaseLabel}
                    className="block h-1 overflow-hidden rounded-[var(--r-check)] bg-[var(--fill-tertiary)]"
                  >
                    {/* A runtime width cannot be a Tailwind class: the compiler
                        finds utilities by scanning source text, so `w-[65%]`
                        built at render time is a class that is never generated. */}
                    <span
                      className="block h-full rounded-[var(--r-check)] bg-[var(--accent)]"
                      style={{ width: `${String(Math.round(fraction * 100))}%` }}
                    />
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between gap-1 px-[7px] py-[5px]">
                <span className="truncate font-mono text-[10.5px] text-[var(--label-secondary)]">
                  {tile.name}
                </span>
                <IconButton
                  label={labels.remove(tile.name)}
                  icon="x"
                  size="mini"
                  disabled={disabled || tile.phase === "uploading" || tile.phase === "saving"}
                  onClick={() => (props.mode === "staged" ? removeStaged(tile) : removeStored(tile))}
                />
              </div>
            </li>
          );
        })}

        {/* The add tile. `ImageDropzone` owns its own paint and its padding is
            frozen by the item that restyled it, so the two child rules here are
            the minimum needed to seat a wide banner in a square cell — and
            `.wrapper > label` outranks the label's own utilities on specificity
            rather than on stylesheet order, so the override is deterministic. */}
        <li className="[&>label]:h-full [&>label]:px-3 [&>label]:py-4">
          <ImageDropzone
            onFiles={addFiles}
            disabled={disabled}
            multiple
            resetKey={resetKey}
            busyLabel={busy ? labels.uploading : undefined}
          />
        </li>
      </ul>

      {selected !== undefined && (
        <div
          role="group"
          aria-labelledby={groupId}
          className="grid gap-2 border-t border-[var(--separator-weak)] pt-3"
        >
          <p id={groupId} className="text-[12px] font-semibold text-[var(--label)]">
            {labels.altHeading}{" "}
            <span className="font-mono text-[11px] font-normal text-[var(--label-secondary)]">
              {selected.name}
            </span>
          </p>

          <TextField
            label={labels.alt}
            name="alt"
            value={selected.alt}
            onChange={(value) => patchAlt(selected, { alt: value })}
            maxLength={300}
            disabled={disabled}
            readOnly={!altEditable}
            {...(altEditable && altMissing ? { error: labels.altRequired } : {})}
          />

          {selectedDraft !== undefined && (
            <div className="justify-self-start">
              <Button
                variant="prominent"
                onClick={() => void uploadDraft(selectedDraft)}
                // Alt text before the only write that can carry it. There is no
                // route that updates alt text after the fact, so an image
                // attached without it stays without it.
                disabled={disabled || altMissing}
                pending={selectedDraft.phase !== "draft"}
                pendingLabel={selectedDraft.phase === "saving" ? labels.saving : labels.uploading}
              >
                {labels.upload}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function without(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(current);
  next.delete(value);
  return next;
}

/**
 * The server's order, or the optimistic one while it still describes the same set.
 *
 * Comparing the SET rather than the sequence is what makes this safe with no
 * effect and no staleness: once the refresh lands, the incoming items already
 * carry the new order and the override yields the identical arrangement, so it
 * can simply stay. An item added or removed elsewhere changes the set, and the
 * server's own `sortOrder` takes over again.
 */
function applyOrder(
  items: readonly ProductMediaItem[],
  order: readonly string[] | null,
): readonly ProductMediaItem[] {
  const byOrder = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  if (order === null || order.length !== items.length) return byOrder;

  const lookup = new Map(items.map((item) => [item.id, item]));
  const arranged: ProductMediaItem[] = [];
  for (const id of order) {
    const item = lookup.get(id);
    if (item === undefined) return byOrder;
    arranged.push(item);
  }
  return arranged;
}
