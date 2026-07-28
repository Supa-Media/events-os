/**
 * TEMPLATE FIELDS — the pure logic behind the Templates home
 * (`CampaignTemplatesView.tsx`): how a stored row's document is summarised,
 * what an edit actually sends to `campaignTemplates.updateTemplate`, and the
 * exact words the archive confirmation uses.
 *
 * Split out for the same two reasons `audienceFilterFields.ts` is: the view
 * stays about layout, and this half is unit-testable under the repo's
 * node-environment Jest config (nothing here imports React or react-native).
 *
 * The interesting piece is `templateDetailsPatch`. `updateTemplate` takes
 * `description: v.optional(v.union(v.string(), v.null()))` — the
 * `previewText` null-sentinel convention from `campaigns.ts`, where
 * `undefined` means "leave it alone" and `null` means "clear it". A form that
 * always sent `description: text` would silently write `""`-as-cleared even
 * when the author never touched the field, so the patch has to distinguish
 * untouched from emptied. It also refuses a whitespace-only NAME up front
 * rather than round-tripping the server's `EMPTY` error.
 */

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

// ── Document summary ────────────────────────────────────────────────────────

/** Plain names for the block kinds in `@events-os/shared`'s `EmailBlock`
 *  union — the same words the designer's palette uses, so a template's
 *  contents line reads like the thing you'd build. */
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

/** How many blocks a stored `doc` has. `doc` is `v.any()` on the row (the
 *  shape is enforced by `validateEmailDocument` at the write gate, not by
 *  Convex), so this reads defensively — a row written before a rule existed
 *  must still list, not crash the screen. */
export function templateBlockCount(doc: unknown): number {
  const blocks = (doc as { blocks?: unknown } | null | undefined)?.blocks;
  return Array.isArray(blocks) ? blocks.length : 0;
}

/**
 * "12 blocks · Heading, Text, Image and 2 more" — the one-line contents
 * summary under a template's name. Distinct kinds in first-appearance order,
 * capped so a long newsletter doesn't spill the card.
 */
export function templateBlockSummary(doc: unknown, maxKinds = 3): string {
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
    "Campaigns already created from it are unaffected — a campaign copies the template, it never links back to it.";
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
