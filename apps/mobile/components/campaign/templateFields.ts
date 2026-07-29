/**
 * TEMPLATE FIELDS — the pure logic behind the Templates home
 * (`CampaignTemplatesView.tsx`): how a stored row's document is summarised,
 * what an edit actually sends to `campaignTemplates.updateTemplate`, what a
 * NEW one sends to `campaignTemplates.createTemplate`, and the exact words the
 * archive confirmation uses.
 *
 * Split out for the same two reasons `audienceFilterFields.ts` is: the view
 * stays about layout, and this half is unit-testable under the repo's
 * node-environment Jest config (nothing here imports React or react-native —
 * `@tiptap/core` is a type-only import, fully erased at runtime).
 *
 * The interesting piece is `templateDetailsPatch`. `updateTemplate` takes
 * `description: v.optional(v.union(v.string(), v.null()))` — the
 * `previewText` null-sentinel convention from `campaigns.ts`, where
 * `undefined` means "leave it alone" and `null` means "clear it". A form that
 * always sent `description: text` would silently write `""`-as-cleared even
 * when the author never touched the field, so the patch has to distinguish
 * untouched from emptied. It also refuses a whitespace-only NAME up front
 * rather than round-tripping the server's `EMPTY` error.
 *
 * `templateBlockCount`/`templateBlockSummary` are FORMAT-AWARE
 * (`emailDocFormat.ts`'s contract): a `"blocks"`-format row's `doc.blocks`
 * array is exactly what it always was, but a `"tiptap"`-format row has no
 * `.blocks` — reading it as if it did used to report every tiptap template
 * (built-in "Monthly newsletter" among them, as of migration 0056) as
 * `"Empty template"`, which is simply false. For `"tiptap"`, the doc's
 * top-level `content` nodes are its "blocks" for counting/labeling purposes,
 * genuine emptiness is `isTiptapDocEmpty` (the SAME definition the maily
 * editor and `CampaignStatusCard.tsx#hasEmailContent` use — reused, not
 * re-derived), never re-imprinted here.
 */
import type { JSONContent } from "@tiptap/core";
import { emailDocFormatOf } from "@events-os/shared";
import { isTiptapDocEmpty } from "./designer/mailyDoc";

/** What a stored template row looks like to this module — the fields it
 *  reads, so a test doesn't have to fabricate a whole Convex document. */
export type TemplateDetails = {
  name: string;
  description?: string | undefined;
};

export type TemplateDetailsPatch =
  | { ok: false; error: string }
  /** `changed: false` = nothing to send; the view closes the editor without
   *  a pointless mutation (and without a "saved!" toast for a no-op). */
  | { ok: true; changed: false }
  | { ok: true; changed: true; name?: string; description?: string | null };

/** Build the `updateTemplate` args for an edited name/description, or the
 *  reason the edit can't be saved. See the file doc on the null sentinel. */
export function templateDetailsPatch(
  draft: { name: string; description: string },
  current: TemplateDetails,
): TemplateDetailsPatch {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Name the template first." };

  const description = draft.description.trim();
  const currentDescription = (current.description ?? "").trim();

  const patch: { name?: string; description?: string | null } = {};
  if (name !== current.name.trim()) patch.name = name;
  if (description !== currentDescription) {
    // Emptied a description that existed → the explicit CLEAR sentinel.
    patch.description = description === "" ? null : description;
  }

  if (patch.name === undefined && patch.description === undefined) {
    return { ok: true, changed: false };
  }
  return { ok: true, changed: true, ...patch };
}

// ── Creating one from scratch ───────────────────────────────────────────────

export type NewTemplateArgs =
  | { ok: false; error: string }
  | { ok: true; name: string; description?: string };

/**
 * Build the `campaignTemplates.createTemplate` args for the "New template"
 * form, or the reason it can't be created yet.
 *
 * Two rules, both checked HERE rather than round-tripping the server:
 *  - a whitespace-only name is the server's `EMPTY`, refused up front the same
 *    way `templateDetailsPatch` refuses it on a rename;
 *  - a name that's already in the library is refused as a KINDNESS, not a
 *    constraint — nothing in the schema enforces uniqueness, but two rows
 *    called "Monthly newsletter" in a list whose whole job is "pick the one
 *    you want" is a library nobody can use. Case- and whitespace-insensitive,
 *    since "monthly newsletter " is the same answer to a human.
 *
 * `description` is omitted entirely when blank — `createTemplate` treats an
 * empty string as "no description", and sending `""` would only make the row
 * carry a field it doesn't mean.
 */
export function newTemplateArgs(
  draft: { name: string; description: string },
  existing: readonly TemplateDetails[],
): NewTemplateArgs {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Name the template first." };

  const taken = existing.some(
    (t) => t.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    return { ok: false, error: `There's already a template called “${name}”.` };
  }

  const description = draft.description.trim();
  return description ? { ok: true, name, description } : { ok: true, name };
}

// ── Document summary ────────────────────────────────────────────────────────

/** Plain names for the block kinds in `@events-os/shared`'s `EmailBlock`
 *  union — the same words the designer's palette uses, so a `"blocks"`-format
 *  template's contents line reads like the thing you'd build. */
const BLOCK_LABELS: Record<string, string> = {
  heading: "Heading",
  text: "Text",
  image: "Image",
  bleed_image: "Full-width image",
  button: "Button",
  hairline: "Hairline",
  footer: "Footer",
  divider: "Divider",
  spacer: "Spacer",
  eyebrow: "Eyebrow",
  card: "Card",
  columns: "Columns",
  quote: "Quote",
  poll: "Poll",
};

/** Plain names for the maily/tiptap top-level node types this app's editor
 *  and `packages/email-render` renderer produce. An unlisted type (a future
 *  node kind) falls back to its raw type string rather than disappearing
 *  from the summary. */
const TIPTAP_NODE_LABELS: Record<string, string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  section: "Section",
  columns: "Columns",
  column: "Column",
  image: "Image",
  inlineImage: "Image",
  pwBleedImage: "Full-width image",
  button: "Button",
  blockquote: "Quote",
  horizontalRule: "Divider",
  htmlCodeBlock: "HTML block",
  logo: "Logo",
  spacer: "Spacer",
  pwPoll: "Poll",
  bulletList: "Bulleted list",
  orderedList: "Numbered list",
};

/** A tiptap doc's top-level `content` nodes — its "blocks" for
 *  counting/labeling purposes (this module's doc). Defensive for the same
 *  reason `templateBlockCount` is: `doc` is `v.any()` on the row, not
 *  Convex-validated. */
function tiptapTopLevelNodes(doc: unknown): JSONContent[] {
  const content = (doc as { content?: unknown } | null | undefined)?.content;
  return Array.isArray(content) ? (content as JSONContent[]) : [];
}

/** How many blocks a stored `doc` has, format-aware
 * (`emailDocFormat.ts`'s contract — `docFormat` absent/`"blocks"` reads
 * `doc.blocks`, `"tiptap"` counts top-level `content` nodes). `doc` is
 * `v.any()` on the row (the shape is enforced by `validateEmailDocument`/
 * `validateTiptapEmailDoc` at the write gate, not by Convex), so this reads
 * defensively either way — a row written before a rule existed must still
 * list, not crash the screen. */
export function templateBlockCount(doc: unknown, docFormat?: string | null): number {
  if (emailDocFormatOf({ docFormat }) === "tiptap") {
    return tiptapTopLevelNodes(doc).length;
  }
  const blocks = (doc as { blocks?: unknown } | null | undefined)?.blocks;
  return Array.isArray(blocks) ? blocks.length : 0;
}

/**
 * "12 blocks · Heading, Text, Image and 2 more" — the one-line contents
 * summary under a template's name. Distinct kinds in first-appearance order,
 * capped so a long newsletter doesn't spill the card.
 *
 * Format-aware: a `"tiptap"`-format doc has no `.blocks` array at all —
 * reading it as if it did is the exact bug that mislabeled every tiptap
 * template "Empty template", including the built-in "Monthly newsletter"
 * template migration 0056 flips to tiptap on every deployment. Genuine
 * emptiness for a tiptap doc is `isTiptapDocEmpty` (reused, not
 * re-derived) — NOT "zero top-level nodes": the starter doc
 * (`designer/mailyDoc.ts#newTiptapDocSeed`) has two top-level nodes and is
 * real, if minimal, content, so it must never read as empty here either.
 */
export function templateBlockSummary(
  doc: unknown,
  docFormat?: string | null,
  maxKinds = 3,
): string {
  if (emailDocFormatOf({ docFormat }) === "tiptap") {
    return tiptapBlockSummary(doc, maxKinds);
  }
  const count = templateBlockCount(doc);
  if (count === 0) return "Empty template";
  const blocks = (doc as { blocks: { kind?: unknown }[] }).blocks;
  const kinds: string[] = [];
  for (const b of blocks) {
    const kind = typeof b?.kind === "string" ? b.kind : null;
    if (!kind) continue;
    const label = BLOCK_LABELS[kind] ?? kind;
    if (!kinds.includes(label)) kinds.push(label);
  }
  const head = `${count} block${count === 1 ? "" : "s"}`;
  if (kinds.length === 0) return head;
  const shown = kinds.slice(0, maxKinds).join(", ");
  const rest = kinds.length - maxKinds;
  return rest > 0 ? `${head} · ${shown} and ${rest} more` : `${head} · ${shown}`;
}

function tiptapBlockSummary(doc: unknown, maxKinds: number): string {
  if (isTiptapDocEmpty(doc as JSONContent | null | undefined)) return "Empty template";
  const nodes = tiptapTopLevelNodes(doc);
  const count = nodes.length;
  const kinds: string[] = [];
  for (const node of nodes) {
    const type = typeof node?.type === "string" ? node.type : null;
    if (!type) continue;
    const label = TIPTAP_NODE_LABELS[type] ?? type;
    if (!kinds.includes(label)) kinds.push(label);
  }
  const head = `${count} block${count === 1 ? "" : "s"}`;
  if (kinds.length === 0) return head;
  const shown = kinds.slice(0, maxKinds).join(", ");
  const rest = kinds.length - maxKinds;
  return rest > 0 ? `${head} · ${shown} and ${rest} more` : `${head} · ${shown}`;
}

// ── Archive confirmation ────────────────────────────────────────────────────

/**
 * The archive prompt's exact words.
 *
 * A BUILT-IN row archives like any other — `ensureBuiltInTemplates`
 * deliberately does not resurrect an archived built-in (see that mutation's
 * doc), which is the whole reason an org can get rid of the newsletter
 * template at all. That same deliberate choice makes it effectively
 * permanent, and the prompt says so plainly instead of letting someone
 * discover it after the next deploy doesn't bring it back.
 */
export function templateArchiveCopy(
  name: string,
  isBuiltIn: boolean,
): { title: string; message: string; confirmLabel: string } {
  const shared =
    "Emails already created from it are unaffected — an email copies the template, it never links back to it.";
  if (isBuiltIn) {
    return {
      title: "Remove this built-in template?",
      message: `“${name}” is one of the templates that ship with the app. Removing it is effectively permanent: app updates will not bring it back, so you'd have to rebuild it by hand. ${shared}`,
      confirmLabel: "Remove for good",
    };
  }
  return {
    title: "Remove this template?",
    message: `“${name}” will disappear from the template list for everyone. ${shared}`,
    confirmLabel: "Remove",
  };
}
