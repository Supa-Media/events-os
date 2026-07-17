# Central↔Chapter Transfer Ops Notes

**Audience:** whoever operates the City Launch Fund / settlement machinery in
production (central bookkeeper+, or a maintainer agent debugging on their behalf).
**What this is:** short, practical notes for running the transfer ledger day to
day — starting with how to correct a mis-recorded transfer. **What this isn't:** a
design doc — see `docs/plans/finance-v2-split-prd.md` and the doc comments on
`recordSkimTransfer` / `recordLaunchGrant` / `recordSettlementTransfer` /
`interScopeBalances` in `apps/convex/transfers.ts` for the mechanics and the why.

---

## Correcting a mis-recorded transfer

Applies to all three transfer kinds — a skim (`source:"skim"`), a launch grant
(`source:"launch_grant"`), and a settlement (`source:"settlement"`). Each is booked
as a PAIR of `flow:"transfer"` transactions (one leg per scope) keyed by a
deterministic `transferGroupId` (chapter + year + month, e.g.
`skimTransferGroupId`/`launchTransferGroupId`/`settlementTransferGroupId`).

**There is no undo/edit mutation.** `record*Transfer` and `record*PairFromIncrease`
all gate on `ALREADY_RECORDED` — a second call for the same chapter/year/month pair
is REJECTED, not merged or overwritten. This is intentional (idempotency on the
deterministic group id is what makes retries after a network hiccup safe), but it
means a wrong amount, wrong direction, or wrong month recorded today CANNOT be
edited or deleted through the app.

Two ways to fix it, in order of preference:

1. **Offsetting entry next month (preferred).** Book a correcting transfer in the
   FOLLOWING month's cycle that nets the mistake out — e.g. if March's skim was
   recorded $100 too high, reduce April's skim by $100 (or, for a settlement,
   record an extra settlement leg in the opposite direction next month for the
   difference). This keeps every recorded row an honest, auditable fact ("what we
   actually told each side happened") and lets `interScopeBalances`/the City
   Launch Fund position self-correct over the next reporting period. Always
   accompany this with a `note` on the correcting entry explaining which prior
   month/amount it offsets — the ledger has no other way to link the two.
2. **Raw row deletion (last resort).** If the error is severe enough (or recent
   enough) that waiting a month isn't acceptable, a maintainer can delete the pair
   directly from the Convex dashboard (or a one-off `internalMutation`) —
   `transactions` rows matching `transferGroupId` on the `by_transfer_group`
   index, BOTH legs together (deleting only one leg leaves the ledger unbalanced
   and `interScopeBalances` wrong for that chapter). Only do this for a genuine
   mis-entry (fat-fingered amount, wrong chapter, wrong direction) that hasn't
   settled anything downstream yet — never for "I don't like how this reads" once
   other entries have started referencing that month. There is no soft-delete or
   audit trail for this path today, so leave a comment/record OUTSIDE the app
   (e.g. this doc, a PR, or an internal note) of what was deleted and why.

**Do not** try to fix a mis-recorded transfer by inserting a THIRD leg into the same
`transferGroupId` — every reader (`interScopeBalances`, the City Launch Fund
position, `dashboardCentral`) assumes exactly two legs per group id, and a stray
third row will silently double- or triple-count.
