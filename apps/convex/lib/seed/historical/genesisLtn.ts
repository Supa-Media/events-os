/**
 * Curated one-time finance backfill data (2026-07-19). Private repo.
 *
 * OWNER-PAID LOVE THY NEIGHBOR EXPENSES — three personal Zelle payments the
 * owner (Seyi) made on the org's behalf for the Love Thy Neighbor 2025 event.
 * These NEVER touched the org's Relay bank account, so they are absent from the
 * genesis bank history — but they are real org expenses and must appear on the
 * finances side. The GIVING side records the matching in-kind gifts separately;
 * THIS side records only the EXPENSE leg (an outflow), never a reimbursement or
 * repayment — the owner is not being paid back (see the runner's doc comment for
 * why `reimbursementRequests`/`personalRepayments` don't fit).
 *
 * `conf` (the Zelle confirmation code) is the stable, unique idempotency key —
 * the runner derives the txn `externalId` from it (`genesis-ltn:<conf>`).
 */
import type { GenesisLtnRow } from "./types";

export const GENESIS_LTN_ROWS: GenesisLtnRow[] = [
  {
    date: "Aug 24, 2025",
    description: "Soul Cry Studios production deposit — Love Thy Neighbor",
    amountCents: 150000,
    conf: "tkplz76rz",
  },
  {
    date: "Sep 20, 2025",
    description: "Soul Cry Studios sound balance — Love Thy Neighbor",
    amountCents: 150000,
    conf: "wekn4esl0",
  },
  {
    date: "Sep 20, 2025",
    description: "SoulCry love offering — Love Thy Neighbor",
    amountCents: 50000,
    conf: "ug3ml7wr4",
  },
];
