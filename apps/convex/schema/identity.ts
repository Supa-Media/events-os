import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Guest Identity review — the human half of Partiful name-only RSVP
 * resolution (the automated half is `migrations/0049_link_rsvp_identifiers.ts`,
 * which auto-links the small slice of rsvps that already carry an email or
 * phone; everything else needs a human to look at it — see `identity.ts`).
 *
 * `identityDecisions` is the append-only decision ledger behind the review
 * queue's suppression/resurfacing logic:
 *  - `guest_link` — `subjectKey` is a normalized name-only guest name
 *    (`dataHygiene.ts#normName`), `candidatePersonId` an existing `people`
 *    row proposed (or later chosen) as the same person.
 *  - `person_merge` — `subjectKey` is `String(duplicatePersonId)`,
 *    `candidatePersonId` the OTHER person in the suspected-duplicate pair
 *    (the one presented as the merge survivor).
 *
 * Only a `"different"` verdict is ever written by the generic
 * `identity.ts#recordDecision` mutation — a `"same"` verdict is written
 * INLINE by `identity.ts#linkGuestToPerson` / `#createPersonFromGuest` /
 * `#mergeDuplicatePeople` as a side effect of actually performing the
 * link/merge, so a `"same"` row always coexists with the underlying data
 * change (the rsvp's `personId` already set / the duplicate already gone) —
 * no separate suppression check is ever needed for `"same"`. A "not sure"
 * verdict writes NOTHING here at all — it's a purely client-side "move to
 * the back of my current session's queue" behavior with no server call.
 *
 * RESURFACING: `evidenceHash` (`lib/identityEvidence.ts#computeIdentityEvidenceHash`)
 * fingerprints what was KNOWN about the pair at decision time. A `"different"`
 * verdict is fingerprinted on THIN evidence (often just a name) and must not
 * suppress the pair FOREVER — if the candidate later gains an email or phone,
 * the live hash no longer matches the stored one and the pair resurfaces in
 * the queue (see `identity.ts`'s suppression check for the read-side half of
 * this contract).
 */
export const identityDecisions = defineTable({
  chapterId: v.id("chapters"),
  kind: v.union(v.literal("guest_link"), v.literal("person_merge")),
  subjectKey: v.string(),
  candidatePersonId: v.id("people"),
  verdict: v.union(v.literal("same"), v.literal("different")),
  evidenceHash: v.string(),
  decidedBy: v.id("users"),
  decidedAt: v.number(),
})
  // The exact-match suppression/resurfacing lookup: "has this candidate pair
  // already been decided?" — see identity.ts's `shouldIncludeIdentityPair`.
  .index("by_chapter_kind_subject_candidate", [
    "chapterId",
    "kind",
    "subjectKey",
    "candidatePersonId",
  ])
  .index("by_chapter_and_kind", ["chapterId", "kind"]);
