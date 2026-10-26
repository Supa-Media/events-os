/**
 * Documents attached to a contractor agreement's ADDITIONAL TERMS.
 *
 * Founder, 2026-10-26: "I need to be able to attach a document on the
 * 'additional terms' section rather than just type it in." A rider, an SOW, a
 * licensing PDF — the same thing `additionalTerms` is, just as a file. So it
 * carries the same promises as that field (see `schema/finances.ts`):
 *
 *  - SHOWN TO THE CONTRACTOR. Their tokened /contract page lists each file with
 *    a download link, inside the terms card they sign.
 *  - AN AGREED TERM. Adding, removing or replacing a document after they
 *    accepted voids the acceptance exactly as editing the text does —
 *    `updateTerms` reads `changed` from `resolveTermsDocuments` into the same
 *    `termsChanged` bucket.
 *  - NEVER PUBLISHED on the ledger. Nothing here reaches `publicLedger`.
 *
 * The client uploads with the authed `storage.generateUploadUrl` and passes the
 * full list it wants on file; this module validates each NEW file against the
 * `_storage` system row (its real type and size, not the browser's claim — the
 * posture `attachInvoice` takes) and deletes any file the list dropped. A
 * document belongs to exactly one agreement, so a dropped file has no other
 * dependents.
 */
import { ConvexError, v, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/** What a client sends: the file it uploaded and the name it had. */
export const termsDocumentInput = v.object({
  storageId: v.id("_storage"),
  fileName: v.optional(v.string()),
});
export type TermsDocumentInput = Infer<typeof termsDocumentInput>;

type StoredTermsDocument = NonNullable<
  Doc<"contractorPayments">["termsDocuments"]
>[number];

export const TERMS_DOCUMENTS_MAX = 10;
const TERMS_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
/** PDFs, photos of paper, and Word files — terms are usually written in Word. */
const TERMS_DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

/**
 * Turn the list a client asked for into the list to store.
 *
 * Kept files keep their original `uploadedAt`; new files are validated. Returns
 * `changed` (the SET of files moved — reordering is not a change to what was
 * agreed) and the storage ids to delete once the patch lands.
 */
export async function resolveTermsDocuments(
  ctx: MutationCtx,
  existing: StoredTermsDocument[] | undefined,
  requested: TermsDocumentInput[],
): Promise<{
  docs: StoredTermsDocument[];
  changed: boolean;
  removed: Id<"_storage">[];
}> {
  const before = existing ?? [];
  const seen = new Set<string>();
  const unique = requested.filter((d) => {
    if (seen.has(d.storageId)) return false;
    seen.add(d.storageId);
    return true;
  });
  if (unique.length > TERMS_DOCUMENTS_MAX) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `Attach at most ${TERMS_DOCUMENTS_MAX} documents to the terms.`,
    });
  }

  const now = Date.now();
  const docs: StoredTermsDocument[] = [];
  for (const d of unique) {
    const kept = before.find((b) => b.storageId === d.storageId);
    if (kept) {
      docs.push(kept);
      continue;
    }
    await assertTermsDocumentFile(ctx, d.storageId);
    const fileName = d.fileName?.trim().slice(0, 200);
    docs.push({
      storageId: d.storageId,
      ...(fileName ? { fileName } : {}),
      uploadedAt: now,
    });
  }

  const removed = before
    .filter((b) => !seen.has(b.storageId))
    .map((b) => b.storageId);
  const changed =
    removed.length > 0 || docs.some((d) => !before.includes(d));
  return { docs, changed, removed };
}

async function assertTermsDocumentFile(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<void> {
  const meta = await ctx.db.system.get(storageId);
  if (!meta) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "A document upload didn't finish — please attach it again.",
    });
  }
  if (
    meta.contentType &&
    !TERMS_DOCUMENT_CONTENT_TYPES.includes(meta.contentType)
  ) {
    await ctx.storage.delete(storageId);
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Attach terms as a PDF, a Word document, or a photo.",
    });
  }
  if (meta.size > TERMS_DOCUMENT_MAX_BYTES) {
    await ctx.storage.delete(storageId);
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That document is too large — keep it under 20MB.",
    });
  }
}

/** Delete files a terms edit dropped. Best-effort: a file already gone is the
 *  outcome we wanted. */
export async function deleteTermsDocuments(
  ctx: MutationCtx,
  storageIds: Id<"_storage">[],
): Promise<void> {
  for (const id of storageIds) {
    try {
      await ctx.storage.delete(id);
    } catch {
      // Already gone.
    }
  }
}

/** The documents with a URL to open each — for the finance team's detail view
 *  and the contractor's own tokened page, both of which may read the terms. */
export async function termsDocumentsWithUrls(
  ctx: QueryCtx,
  docs: StoredTermsDocument[] | undefined,
): Promise<
  Array<{
    storageId: Id<"_storage">;
    fileName: string | null;
    uploadedAt: number;
    url: string | null;
  }>
> {
  return await Promise.all(
    (docs ?? []).map(async (d) => ({
      storageId: d.storageId,
      fileName: d.fileName ?? null,
      uploadedAt: d.uploadedAt,
      url: await ctx.storage.getUrl(d.storageId),
    })),
  );
}
