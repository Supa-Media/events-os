/**
 * Curated 2024 gear-purchase orders (2026-08-05). Private repo.
 *
 * THE RECEIPT-BACKED REPLACEMENT for the single lumped `genesis-inkind-exp:gear2024`
 * transaction. That row recorded "2024 music-ministry gear, 33 items bought
 * personally" as ONE $3,729.40 outflow dated year-end 2024, with no receipt and no
 * per-item dates — it was transcribed from a Notion table, not from the source
 * documents. The owner has since located the ORIGINAL order confirmations, so this
 * dataset replaces the lump with what actually happened: 18 real purchases across
 * Aug–Oct 2024, each one a single card charge with a single receipt document.
 *
 * GRANULARITY — one row per ORDER, not per line item (owner decision, 2026-08-05).
 * An order is what actually cleared the Visa and what the receipt attests to, so a
 * row maps 1:1 to a transaction and 1:1 to a receipt file. Per-line-item rows would
 * need tax allocated pro-rata (a derived number no document backs) and would fan one
 * receipt across many transactions. The line items live in `items` below, which the
 * runner joins into the transaction description — so the detail is still readable in
 * the grid without inventing sub-charges.
 *
 * `amountCents` is the receipt's GRAND TOTAL (tax and shipping included), stored
 * NON-NEGATIVE — the runner sets `flow: "outflow"`. This differs from
 * `GenesisInkindExpenseRow`, whose amounts are stored signed-negative; these came
 * straight off the order summaries as positive totals and are never summed with
 * that dataset.
 *
 * TOTAL — $4,446.91 across the 18 orders, against the lump's $3,729.40 (+$717.51).
 * The delta is NOT a correction of the same items; it resolves in two directions:
 *
 *   - The Notion row "Mixer $1,415.36" is really the Sweetwater Behringer X32 Rack
 *     at $978.79 (order 42245906) — the Notion figure was high by $436.57.
 *   - The Notion table simply MISSED purchases the receipts prove: the Alto Busker
 *     200W PA ($349.00 inside order 114-3211256-5253822), the keyboard stand and
 *     bench in that same order, BOTH Anker 521 power stations, the tambourines, the
 *     guitar pickup, and several cables — +$1,154.08 in all.
 *
 * The mirrored in-kind gift `genesis:gear2024` is restated to the same $4,446.91 by
 * the runner, so the giving and finance legs stay equal (see `gear2024Split.ts`).
 *
 * KNOWN OPEN QUESTION — two Anker 521 portable power stations were bought two days
 * apart (2024-10-25 inside the $701.13 order, and 2024-10-27 for $185.08). Both order
 * confirmations are real, so both are recorded here; if one was a replacement for a
 * returned unit, the refund is a separate row that has not surfaced. Flagged in the
 * runner's note on the 10-27 order rather than silently dropped.
 *
 * `receiptFile` is the basename of the source screenshot in the owner's
 * "2024 Equipment" folder. It is NOT read by any Convex function — storage upload
 * happens outside the deployment (see `scripts/upload-gear2024-receipts.mjs`), which
 * passes the resulting `storageId` back in keyed by `orderRef`. It lives here so the
 * mapping from row to source document is reviewable in one place.
 */
import type { Gear2024OrderRow } from "./types";

export const GEAR_2024_ORDER_ROWS: Gear2024OrderRow[] = [
  {
    orderRef: "114-9890645-7982630",
    dateMs: Date.UTC(2024, 7, 6),
    merchant: "Amazon",
    amountCents: 1087,
    items: ["RNSXYAT universal sustain pedal"],
    receiptFile: "Screenshot 2026-08-05 at 9.11.28 PM.png",
  },
  {
    orderRef: "114-5352971-4525852",
    dateMs: Date.UTC(2024, 7, 18),
    merchant: "Amazon",
    amountCents: 38926,
    items: [
      "USB-C to 3.5mm headphone/charger adapters (3-pack)",
      "CME WIDI Master wireless MIDI adapter",
      "Amazon Basics adjustable boom microphone stand",
      "MOKiN 7-in-1 USB-C hub",
      "SWIFF guitar wireless transmitter/receiver",
      "NETGEAR Nighthawk RAX54S WiFi 6 router",
      "Lightning to 3.5mm adapters (2x 3-pack)",
    ],
    receiptFile: "Screenshot 2026-08-05 at 9.10.25 PM.png",
  },
  {
    orderRef: "113-9783604-6351443",
    dateMs: Date.UTC(2024, 7, 21),
    merchant: "Amazon",
    amountCents: 5659,
    items: ["keephifi KZ EDX Pro in-ear monitors (3)"],
    receiptFile: "Screenshot 2026-08-05 at 9.09.42 PM.png",
  },
  {
    orderRef: "114-9720035-4663454",
    dateMs: Date.UTC(2024, 7, 31),
    merchant: "Amazon",
    amountCents: 113175,
    items: [
      "Phenyx Pro PTM-33 quad-channel wireless in-ear monitor system",
      "Phenyx Pro PTU-7000-4H quad-channel wireless microphone system",
      "AC Infinity 2U rack mount drawer",
      "Pyle 19-inch 1U vented rack shelf",
      "Donner 12-inch guitar patch cables (2x 6-pack)",
      "Rack rail screws and washers (25 sets)",
      "CESS-039 right-angle XLR extension cables (3x 2-pack)",
      "POWEROWL rechargeable AA batteries with charger (2x 8-pack)",
      "Klein Tools 32305 ratcheting screwdriver",
      "Foam microphone covers (6 pcs)",
    ],
    receiptFile: "Screenshot 2026-08-05 at 9.05.19 PM.png",
  },
  {
    orderRef: "114-2921193-5253036",
    dateMs: Date.UTC(2024, 7, 31),
    merchant: "Amazon",
    amountCents: 27218,
    items: ["Sound Town STRC-A10UT 10U PA/DJ rack road case"],
    receiptFile: "Screenshot 2026-08-05 at 9.07.25 PM.png",
  },
  {
    // Ordered 08-31, shipped and CHARGED 09-30 (Sweetwater bills on ship). Dated to
    // the order date to match the other August purchases; the payment line on the
    // receipt reads 2024-09-30 and the runner's note records that.
    orderRef: "SW-42245906",
    dateMs: Date.UTC(2024, 7, 31),
    merchant: "Sweetwater",
    amountCents: 97879,
    items: ["Behringer X32 Rack 40-input 25-bus digital rack mixer"],
    receiptFile: "Screenshot 2026-08-05 at 9.14.57 PM.png",
  },
  {
    orderRef: "113-0050781-0511435",
    dateMs: Date.UTC(2024, 8, 3),
    merchant: "Amazon",
    amountCents: 2874,
    items: ["Pyle PMKS3 foldable tripod microphone stands (2)"],
    receiptFile: "Screenshot 2026-08-05 at 8.57.45 PM.png",
  },
  {
    orderRef: "113-8295064-4780255",
    dateMs: Date.UTC(2024, 8, 4),
    merchant: "Amazon",
    amountCents: 2940,
    items: ["Shure WA371 microphone clips (3)"],
    receiptFile: "Screenshot 2026-08-05 at 8.57.11 PM.png",
  },
  {
    orderRef: "113-8870418-2398600",
    dateMs: Date.UTC(2024, 8, 4),
    merchant: "Amazon",
    amountCents: 11433,
    items: ["Behringer P2 personal in-ear monitor amplifiers (3)"],
    receiptFile: "Screenshot 2026-08-05 at 8.57.22 PM.png",
  },
  {
    orderRef: "113-3344077-9105060",
    dateMs: Date.UTC(2024, 8, 4),
    merchant: "Amazon",
    amountCents: 6856,
    items: [
      "KZ ZSN Pro X in-ear monitors",
      "keephifi KZ EDX Pro in-ear monitors",
      "YINYOO KZ ZST in-ear monitors",
    ],
    receiptFile: "Screenshot 2026-08-05 at 8.57.33 PM.png",
  },
  {
    orderRef: "114-0656524-2178659",
    dateMs: Date.UTC(2024, 8, 8),
    merchant: "Amazon",
    amountCents: 30899,
    items: [
      "Pyle 19-outlet 1U rackmount PDU power conditioner",
      "25 ft XLR microphone cables (10-pack)",
      "Phenyx Pro BNC antenna kit",
      "Monoprice 8-channel 1/4-inch TRS snake cable",
      "TAISUSAN 30 ft USB-B to USB-C printer/MIDI cable",
      "YATIME 4-channel XLR snake cable",
      "Wyssay 10-port USB charging station",
      "Smithok XLR adapters (6-pack)",
      "Reusable cable ties (150 pcs)",
      "Colored masking tape (12 pcs)",
    ],
    receiptFile: "Screenshot 2026-08-05 at 8.56.06 PM.png",
  },
  {
    orderRef: "113-8159100-9204204",
    dateMs: Date.UTC(2024, 8, 12),
    merchant: "Amazon",
    amountCents: 870,
    items: ["Benriotel 10 ft USB-B to USB-C MIDI cable"],
    receiptFile: "Screenshot 2026-08-05 at 8.55.21 PM.png",
  },
  {
    orderRef: "113-3535920-5449002",
    dateMs: Date.UTC(2024, 9, 5),
    merchant: "Amazon",
    amountCents: 1850,
    items: ["tisino 1/8-inch TRS to dual 1/4-inch TS Y-splitter cable, 10 ft"],
    receiptFile: "Screenshot 2026-08-05 at 8.54.56 PM.png",
  },
  {
    orderRef: "113-5055024-2268266",
    dateMs: Date.UTC(2024, 9, 6),
    merchant: "Amazon",
    amountCents: 5116,
    items: ["Rechargeable active soundhole acoustic guitar pickup"],
    receiptFile: "Screenshot 2026-08-05 at 8.54.40 PM.png",
  },
  {
    orderRef: "114-3211256-5253822",
    dateMs: Date.UTC(2024, 9, 25),
    merchant: "Amazon",
    amountCents: 70113,
    items: [
      "Alto Professional Busker 200W portable PA speaker system",
      "Anker 521 portable power station",
      "NiuNyuNeu multi-functional keyboard stand",
      "RockJam KB100 adjustable keyboard bench",
    ],
    receiptFile: "Screenshot 2026-08-05 at 8.54.20 PM.png",
  },
  {
    orderRef: "114-2172407-9957842",
    dateMs: Date.UTC(2024, 9, 27),
    merchant: "Amazon",
    amountCents: 4064,
    items: [
      "Suanqi XLR to XLR adapter cable",
      "Smithok 1/4-inch to XLR adapter cables (2)",
    ],
    receiptFile: "Screenshot 2026-08-05 at 8.53.10 PM.png",
  },
  {
    orderRef: "113-3096883-7982617",
    dateMs: Date.UTC(2024, 9, 27),
    merchant: "Amazon",
    amountCents: 5224,
    items: ['EOEXN 10" half-moon tambourines (2x 4-pack)'],
    receiptFile: "Screenshot 2026-08-05 at 8.53.38 PM.png",
  },
  {
    // SECOND Anker 521 in three days (the first is inside 114-3211256-5253822).
    // Both order confirmations are genuine; see this file's header note.
    orderRef: "113-7023722-7963431",
    dateMs: Date.UTC(2024, 9, 27),
    merchant: "Amazon",
    amountCents: 18508,
    items: ["Anker 521 portable power station"],
    note: "Second Anker 521 within three days of the one in order 114-3211256-5253822 — recorded from its own order confirmation. If one unit was returned, the refund is a separate row not yet located.",
    receiptFile: "Screenshot 2026-08-05 at 8.54.03 PM.png",
  },
];

/** The dataset's total in cents — the amount the lump is restated to on both the
 *  finance and giving legs. Derived, never hand-maintained. */
export const GEAR_2024_TOTAL_CENTS = GEAR_2024_ORDER_ROWS.reduce(
  (sum, row) => sum + row.amountCents,
  0,
);
