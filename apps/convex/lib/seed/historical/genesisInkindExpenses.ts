/**
 * Curated one-time finance backfill data (2026-07-19). Private repo.
 *
 * OWNER-PAID IN-KIND EXPENSE MIRROR — the org's founders (Seyi and Layomi)
 * personally paid for 37 real org expenses (gear, transport, food, vendor fees)
 * across 2024-2025, the genesis-era predecessor to the three LTN Zelle payments
 * in `genesisLtn.ts`. Each one is ALREADY recorded on the giving side as an
 * in-kind gift (`genesis:...` externalRef, from #304's giving backfill) — this
 * dataset is the matching EXPENSE leg, so the finances/reconcile side reflects
 * the same reality the giving ledger already does ("a lot of the stuff I did
 * before were donations but also expenses").
 *
 * `amountCents` is SIGNED and always NEGATIVE (an outflow), unlike
 * `GenesisLtnRow.amountCents` which is stored non-negative — this dataset came
 * from the curated source already sign-carrying, and the runner takes the
 * absolute value for the stored (non-negative) txn amount.
 *
 * `externalRef` is the full, already-prefixed idempotency key
 * (`genesis-inkind-exp:<slug>`) — used directly as the txn `externalId`, no
 * further prefixing needed. `sourceGiftRef` is the matching giving-side
 * `externalRef`, carried into the txn note as a cross-reference so a reader can
 * find the in-kind gift this expense mirrors.
 *
 * Like the LTN rows, these never touched the org's Relay bank account (they
 * were paid personally), so the runner does NOT run cross-source bank dedup on
 * them — only the `externalId` self-dedup applies.
 */
import type { GenesisInkindExpenseRow } from "./types";

export const GENESIS_INKIND_EXPENSE_ROWS: GenesisInkindExpenseRow[] = [
  {
    externalRef: "genesis-inkind-exp:don24:layomi-speakers",
    dateMs: 1730635200000,
    amountCents: -70000,
    description: "Public Worship Speakers (Notion 2024 record)",
    fundedBy: "Layomi Kupoluyi",
    sourceGiftRef: "genesis:don24:layomi-speakers",
  },
  {
    externalRef: "genesis-inkind-exp:don24:layomi-food",
    dateMs: 1730548800000,
    amountCents: -44530,
    description: "Jing Li & Lagos — covered the 'Food after event' expense (Notion 2024 record)",
    fundedBy: "Layomi Kupoluyi",
    sourceGiftRef: "genesis:don24:layomi-food",
  },
  {
    externalRef: "genesis-inkind-exp:don25:layomi-lens1",
    dateMs: 1742644800000,
    amountCents: -9987,
    description: "Camera Lens Rental",
    fundedBy: "Layomi Kupoluyi",
    sourceGiftRef: "genesis:don25:layomi-lens1",
  },
  {
    externalRef: "genesis-inkind-exp:don25:layomi-lens2",
    dateMs: 1743249600000,
    amountCents: -7459,
    description: "Camera Lens Rental + Transport",
    fundedBy: "Layomi Kupoluyi",
    sourceGiftRef: "genesis:don25:layomi-lens2",
  },
  {
    externalRef: "genesis-inkind-exp:don25:layomi-uber",
    dateMs: 1742040000000,
    amountCents: -3234,
    description: "Uber from Central Park",
    fundedBy: "Layomi Kupoluyi",
    sourceGiftRef: "genesis:don25:layomi-uber",
  },
  {
    externalRef: "genesis-inkind-exp:don25:layomi-jingli",
    dateMs: 1743249600000,
    amountCents: -6733,
    description: "Jing Li (food)",
    fundedBy: "Layomi Kupoluyi",
    sourceGiftRef: "genesis:don25:layomi-jingli",
  },
  {
    externalRef: "genesis-inkind-exp:gear2024",
    dateMs: 1735646400000,
    amountCents: -372940,
    description: "2024 music-ministry gear, 33 items bought personally (itemized in Notion export; prices include quantities). Dated year-end 2024 — per-item dates were not recorded.",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:gear2024",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:0",
    dateMs: 1741694400000,
    amountCents: -23844,
    description: "Casio Keyboard [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:0",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:1",
    dateMs: 1741867200000,
    amountCents: -3581,
    description: "Picnic Basket [Prop] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:1",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:2",
    dateMs: 1749729600000,
    amountCents: -4349,
    description: "128 GB SD Card [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:2",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:3",
    dateMs: 1742299200000,
    amountCents: -1087,
    description: "SD Card Reader [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:3",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:4",
    dateMs: 1738756800000,
    amountCents: -10879,
    description: "Shure SM58 Mic [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:4",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:5",
    dateMs: 1738756800000,
    amountCents: -116608,
    description: "Drum set, Drum Covers, Drum Sticks and Drum Seat [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:5",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:6",
    dateMs: 1738756800000,
    amountCents: -14153,
    description: "Bongos [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:6",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:7",
    dateMs: 1742040000000,
    amountCents: -3196,
    description: "Uber to Central Park [Transportation] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:7",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:8",
    dateMs: 1742040000000,
    amountCents: -3744,
    description: "Uber from Central Park (1/2) [Transportation] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:8",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:9",
    dateMs: 1738584000000,
    amountCents: -10886,
    description: "Cajon [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:9",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:10",
    dateMs: 1741435200000,
    amountCents: -10000,
    description: "Josh Adriano 3-8 Honorarium [Vendor/Services] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:10",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:12",
    dateMs: 1739016000000,
    amountCents: -3644,
    description: "Uber to Perspective Saints Popup [Transportation] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:12",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:13",
    dateMs: 1739016000000,
    amountCents: -8954,
    description: "Uber from Perspective Saints Popup [Transportation] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:13",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:16",
    dateMs: 1742644800000,
    amountCents: -2446,
    description: "Chicken Gyros and Water Bottles [Food] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:16",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:17",
    dateMs: 1743249600000,
    amountCents: -3592,
    description: "Chicken Gyros [Food] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:17",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:19",
    dateMs: 1743249600000,
    amountCents: -1392,
    description: "Uber to Gantry State Park [Transportation] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:19",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:20",
    dateMs: 1743249600000,
    amountCents: -1460,
    description: "Uber from Gantry State Park [Transportation] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:20",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:21",
    dateMs: 1742040000000,
    amountCents: -4000,
    description: "Flowers, Fruits & Snacks [Prop] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:21",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:22",
    dateMs: 1743681600000,
    amountCents: -6000,
    description: "Red Chairs [Prop] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:22",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:23",
    dateMs: 1753531200000,
    amountCents: -19992,
    description: "Chickfila for volunteers (Get exact later) [Food] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:23",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:24",
    dateMs: 1752840000000,
    amountCents: -1204,
    description: "128 GB Amazon Basics Micro [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:24",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:25",
    dateMs: 1745150400000,
    amountCents: -32657,
    description: "Zoom H6essential Recorder [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:25",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:26",
    dateMs: 1745150400000,
    amountCents: -1196,
    description: "128 GB Amazon Basics Micro [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:26",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:27",
    dateMs: 1747828800000,
    amountCents: -11974,
    description: "Zoom EXH-6e External Input Capsule [Equipment] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:27",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:28",
    dateMs: 1749902400000,
    amountCents: -8500,
    description: "Eden - Charcuterie [Food] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:28",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:29",
    dateMs: 1749902400000,
    amountCents: -40500,
    description: "Eden - Lagos Restaurant (Food for volunteers) [Food] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:29",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:30",
    dateMs: 1749816000000,
    amountCents: -12573,
    description: "Eden - Drinks [Food] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:30",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:31",
    dateMs: 1748952000000,
    amountCents: -40000,
    description: "Development Consulting Fee [Vendor/Services] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:31",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:32",
    dateMs: 1743854400000,
    amountCents: -25000,
    description: "Josh Adriano - Filming [Vendor/Services] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:32",
  },
  {
    externalRef: "genesis-inkind-exp:buy25:33",
    dateMs: 1744459200000,
    amountCents: -12500,
    description: "John Adriano - Filming [Vendor/Services] — bought personally",
    fundedBy: "Oluseyi Olujide",
    sourceGiftRef: "genesis:buy25:33",
  },
];
