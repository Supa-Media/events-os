# Central↔Chapter Transfer Ops Notes

**Audience:** whoever operates the City Launch Fund / inter-scope balance
machinery in production (central bookkeeper+, or a maintainer agent debugging
on their behalf).
**What this is:** short, practical notes for running the transfer ledger day to
day — starting with how to correct a mis-recorded transfer. **What this isn't:** a
design doc — see `docs/plans/finance-v2-split-prd.md` and the doc comments on
`recordTransfer` / `interScopeBalances` in `apps/convex/transfers.ts` for the
mechanics and the why.

**2026-07-26 — collapsed to one generic transfer.** The skim (`source:"skim"`),
launch grant (`source:"launch_grant"`), and settlement (`source:"settlement"`)
used to be three separate mutations, each with a deterministic
`transferGroupId` (one per chapter/year/month, or one per chapter ever) and an
`initiate*` action that could fire a real Increase account-to-account
transfer. Founder decision: "we just have 1 chapter and not a lot of backers,
it feels unnecessarily complex... it could be just a manual transfer." All
three are now ONE mutation, `recordTransfer({direction, chapterId,
amountCents, postedAt, note})`, always `source:"transfer"`, with a free-text
`note` for what it was for. There is no more Increase auto-initiate path —
every transfer is recorded for money that already moved outside the app.
Historical `skim`/`launch_grant`/`settlement` rows are untouched and still
read correctly (see `transfers.ts`'s header comment and
`finances.ts#dashboardCentral`'s City Launch Fund computation).

---

## Correcting a mis-recorded transfer

Every transfer (new `source:"transfer"` rows, and the historical
`skim`/`launch_grant`/`settlement` kinds) is booked as a PAIR of
`flow:"transfer"` transactions (one leg per scope) keyed by a shared
`transferGroupId`. A NEW transfer's id is
`transfer-<chapterId>-<postedAt>-<8 hex chars>` — explicit but RANDOM, not
deterministic (there's no natural "one per month" key for a manual transfer
anymore — a treasurer can record as many as they like, any day).

**There is no undo/edit mutation.** `recordTransfer` gates on
`ALREADY_RECORDED` only as defense-in-depth against a genuine id collision
(vanishingly unlikely given the random suffix) — it is NOT a "you already
recorded this month" guard anymore, since there's no month-keyed uniqueness
to enforce. In practice this means recording the SAME transfer twice by
mistake (e.g. a double-tap) silently succeeds as two independent rows — there
is no built-in duplicate-submission guard beyond normal UI hygiene
(disable-on-submit). A wrong amount, wrong direction, or wrong date recorded
today CANNOT be edited or deleted through the app.

Two ways to fix it, in order of preference:

1. **Offsetting entry (preferred).** Book a correcting transfer in the
   OPPOSITE direction for the difference — e.g. if a $500 chapter→central
   transfer should have been $400, record a $100 central→chapter transfer to
   net it back out. This keeps every recorded row an honest, auditable fact
   ("what we actually told each side happened") and lets
   `interScopeBalances`/the City Launch Fund position self-correct
   immediately (there's no "next month's cycle" to wait for anymore — record
   the correction whenever you catch the mistake). Always put a `note` on the
   correcting entry explaining which prior transfer it offsets — the ledger
   has no other way to link the two.
2. **Raw row deletion (last resort).** If the error is severe enough (or
   recent enough) that an offsetting entry isn't acceptable, a maintainer can
   delete the pair directly from the Convex dashboard (or a one-off
   `internalMutation`) — `transactions` rows matching `transferGroupId` on the
   `by_transfer_group` index, BOTH legs together (deleting only one leg leaves
   the ledger unbalanced and `interScopeBalances` wrong for that chapter).
   Only do this for a genuine mis-entry (fat-fingered amount, wrong chapter,
   wrong direction) that hasn't settled anything downstream yet — never for "I
   don't like how this reads" once other entries have started referencing it.
   There is no soft-delete or audit trail for this path today, so leave a
   comment/record OUTSIDE the app (e.g. this doc, a PR, or an internal note)
   of what was deleted and why.

**Do not** try to fix a mis-recorded transfer by inserting a THIRD leg into the
same `transferGroupId` — every reader (`interScopeBalances`, the City Launch
Fund position, `dashboardCentral`) assumes exactly two legs per group id, and a
stray third row will silently double- or triple-count.
