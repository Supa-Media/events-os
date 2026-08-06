/**
 * Genesis-era ledger cleanup (2026-08-06). Private repo.
 *
 * The second and final pass over the owner-paid "bought personally" rows. The
 * gear2024 split (`gear2024Orders.ts`) fixed the single worst row; this fixes
 * everything the owner then went through with fresh evidence — Amazon order history,
 * his Uber trip history, an Instacart receipt, a DoorDash group order, and Apple Cash
 * screenshots.
 *
 * SIX KINDS OF CHANGE, each its own exported list so a reviewer reads one concern at
 * a time: deletions, new transactions, patches, receipts-only, categories, and
 * receipt exceptions.
 *
 * BUDGETS AND CATEGORIES RESOLVE BY NAME, NOT ID. Convex ids are per-deployment, so
 * this dataset names `budgetLabel` / `categoryName` and the runner looks them up on
 * the live chapter. An unresolvable name is REPORTED, never silently skipped — a typo
 * must not quietly drop a row's coding.
 *
 * THE $700 (owner decision, 2026-08-06). `don24:layomi-speakers` was never a
 * purchase: it was $700 Layomi gave toward speakers, which landed in the owner's
 * personal account because the org had no bank account yet. Three consequences that
 * only make sense together:
 *   - the EXPENSE is deleted (nothing was bought);
 *   - Layomi's $700 in-kind GIFT stays (she really did give it);
 *   - the owner's own `genesis:gear2024` gift drops by $700, because her money
 *     arrived Nov 2024 — AFTER the Aug–Oct gear it reimbursed — and those purchases
 *     are already booked as HIS in-kind giving. Without this, the same $700 counts as
 *     two people's donations.
 * The books balance afterwards: gear expense $4,446.91 = owner $3,746.91 + Layomi $700.
 *
 * THE UBERS (owner ruling, 2026-08-06): "anything in my Uber account is definitely
 * me." That settles what looked like a date conflict. Two rides to and from Central
 * Park on 2025-06-14 sit in his history at $37.54 and $32.34; the ledger separately
 * holds three Central Park rides dated 2025-03-15 at $31.96, $37.44 and $32.34. They
 * are DIFFERENT rides on the same route — Eden was in Central Park on Jun 14, the
 * social-media shoot was there in March — which is why the fares are so close. So the
 * June rides are added as NEW Eden transactions and the March rows are left alone.
 * The $32.34 March row is recorded as Layomi-funded and stays that way: per the same
 * ruling, a ride absent from the owner's account is someone else's, and Layomi owes
 * that receipt.
 */
import type {
  CleanupNewTxn,
  CleanupPatch,
  CleanupCategory,
  CleanupException,
} from "./types";

/**
 * Budgets filed on `central` that belong to New York, reparented before anything
 * else runs (owner ruling, 2026-08-06: "all these imports should live in the New York
 * chapter, they shouldn't live in Central").
 *
 * "Worship in Public - Social Media Growth Strategy" is unambiguous: it sits on
 * `central`, but its linked PROJECT is already a New York project and all 17
 * transactions referencing it are New York rows. It was created in the wrong scope.
 * Moving it is a single-field patch — nothing denormalizes the budget's chapter
 * (0 `budgetLines`, 0 `budgetTagLinks`, and `budgetApprovalLog` carries no
 * `chapterId`), so there is no fan-out to keep in step.
 *
 * DELIBERATELY NOT MOVED — two other central budgets also have some New York rows,
 * but they are genuinely mixed and are live 2026 spend, not genesis imports:
 * "Renegade Evergreen (EP)" (4 of 12 rows are NY) and "Setup $10,000 Google Ad Spend"
 * (1 of 2). Reparenting a budget that central really does share would move money out
 * of central's own reporting. Flagged for the owner; out of scope for this cleanup.
 */
export const CLEANUP_BUDGET_MOVES: { label: string; reason: string }[] = [
  {
    label: "Worship in Public - Social Media Growth Strategy",
    reason:
      "Created on central, but its project and all 17 of its transactions are New York's.",
  },
];

/** The one row that was never an expense. */
export const CLEANUP_DELETIONS: { externalId: string; reason: string }[] = [
  {
    externalId: "genesis-inkind-exp:don24:layomi-speakers",
    reason:
      "$700 Layomi gave toward speakers, booked as a purchase by an earlier import. " +
      "Money came IN, not out; her in-kind gift is the true record of it.",
  },
];

/** The owner's in-kind restatement that accompanies that deletion — never applied apart. */
export const OWNER_GIFT_REF = "genesis:gear2024";
export const OWNER_GIFT_REDUCTION_CENTS = 70000;

/** Real spend that reached neither Notion nor the ledger. */
export const CLEANUP_NEW_TXNS: CleanupNewTxn[] = [
  // ── Amazon, from the "2025 Amazon" folder ─────────────────────────────────
  { slug: "amz:113-2546312-7227436", dateMs: Date.UTC(2025, 2, 28), amountCents: 7865, merchant: "Amazon",
    description: 'Amazon order 113-2546312-7227436 — Victiv 72" video tripod with fluid head',
    budgetLabel: "Equipment Repairs & Upgrades", categoryName: "Equipment",
    receiptFile: "Screenshot 2026-08-05 at 11.20.46 PM.png" },
  { slug: "amz:113-8488100-7337862", dateMs: Date.UTC(2025, 3, 2), amountCents: 3700, merchant: "Amazon",
    description: "Amazon order 113-8488100-7337862 — Doseno foldable stools ×2, red",
    budgetLabel: "Equipment Repairs & Upgrades", categoryName: "Supplies",
    receiptFile: "Screenshot 2026-08-05 at 11.45.30 PM.png" },
  { slug: "amz:114-5812487-2917020", dateMs: Date.UTC(2025, 3, 22), amountCents: 11321, merchant: "Amazon",
    description: "Amazon order 114-5812487-2917020 — MARBERO portable power bank + kookoomia 50L tactical backpack",
    budgetLabel: "Equipment Repairs & Upgrades", categoryName: "Equipment",
    receiptFile: "Screenshot 2026-08-05 at 11.44.30 PM.png" },
  { slug: "amz:113-7755495-5208264", dateMs: Date.UTC(2025, 4, 6), amountCents: 6531, merchant: "Amazon",
    description: "Amazon order 113-7755495-5208264 — FUNYKICH 3ft camping folding table",
    budgetLabel: "Equipment Repairs & Upgrades", categoryName: "Supplies",
    receiptFile: "Screenshot 2026-08-05 at 11.44.10 PM.png" },
  { slug: "amz:113-5878480-0532267", dateMs: Date.UTC(2025, 5, 11), amountCents: 7553, merchant: "Amazon",
    description: "Amazon order 113-5878480-0532267 — Turkish beach towels ×2 + plastic drop cloths, 20 pcs",
    budgetLabel: "Eden · June 2025", categoryName: "Supplies",
    receiptFile: "Screenshot 2026-08-05 at 11.42.23 PM.png" },
  { slug: "amz:113-2826417-4777857", dateMs: Date.UTC(2025, 5, 12), amountCents: 2599, merchant: "Amazon",
    description: "Amazon order 113-2826417-4777857 — disposable rain ponchos, 50-pack",
    budgetLabel: "Eden · June 2025", categoryName: "Supplies",
    receiptFile: "Screenshot 2026-08-05 at 11.42.06 PM.png" },
  { slug: "amz:112-1015391-5033821", dateMs: Date.UTC(2025, 6, 2), amountCents: 7324, merchant: "Amazon",
    description: "Amazon order 112-1015391-5033821 — CRAFTSMAN 30-drawer organizer + Vtopmart stackable drawers ×2",
    budgetLabel: "Equipment Repairs & Upgrades", categoryName: "Supplies",
    receiptFile: "Screenshot 2026-08-05 at 11.35.46 PM.png" },
  { slug: "amz:111-6636873-5273804", dateMs: Date.UTC(2025, 7, 7), amountCents: 12520, merchant: "Amazon",
    description: "Amazon order 111-6636873-5273804 — DSLR hot-shoe rain cover + COMICA VM20 shotgun microphone",
    budgetLabel: "Equipment Repairs & Upgrades", categoryName: "Equipment",
    receiptFile: "Screenshot 2026-08-05 at 11.33.52 PM.png" },

  // ── Uber, from the owner's trip history ───────────────────────────────────
  // Nov 2 2024 brackets PW's First Event at Washington Square Park.
  { slug: "uber:2024-11-02:out", dateMs: Date.UTC(2024, 10, 2), amountCents: 5128, merchant: "Uber",
    description: "Uber to PW's First Event — Long Island City → Washington Square Park",
    budgetLabel: "PW's First Event", categoryName: "Transportation", receiptFile: "IMG_1428.png" },
  { slug: "uber:2024-11-02:back", dateMs: Date.UTC(2024, 10, 2), amountCents: 4274, merchant: "Uber",
    description: "Uber from PW's First Event — Washington Square Park → Long Island City",
    budgetLabel: "PW's First Event", categoryName: "Transportation", receiptFile: "IMG_1429.png" },
  // Feb 5 2025 is the day the drum kit, bongos and SM58s were bought; both rides are
  // short Long Island City hops. Owner confirmed: transport for the drum kits.
  { slug: "uber:2025-02-05:out", dateMs: Date.UTC(2025, 1, 5), amountCents: 1398, merchant: "Uber",
    description: "Uber — drum kit transport, Long Island City",
    budgetLabel: "Equipment Repairs & Upgrades", categoryName: "Transportation", receiptFile: "IMG_1426.png" },
  { slug: "uber:2025-02-05:back", dateMs: Date.UTC(2025, 1, 5), amountCents: 2001, merchant: "Uber",
    description: "Uber — drum kit transport, Northern Blvd → Long Island City",
    budgetLabel: "Equipment Repairs & Upgrades", categoryName: "Transportation", receiptFile: "IMG_1427.png" },
  // Jun 14 2025 — Eden, in Central Park. See this file's header on why these are NEW
  // rather than corrections to the March rows.
  { slug: "uber:2025-06-14:out", dateMs: Date.UTC(2025, 5, 14), amountCents: 3754, merchant: "Uber",
    description: "Uber to Eden — Long Island City → 65th St Transverse Rd, Central Park",
    budgetLabel: "Eden · June 2025", categoryName: "Transportation", receiptFile: "IMG_1423.png" },
  { slug: "uber:2025-06-14:back", dateMs: Date.UTC(2025, 5, 14), amountCents: 3234, merchant: "Uber",
    description: "Uber from Eden — 880 5th Ave, Central Park → Long Island City",
    budgetLabel: "Eden · June 2025", categoryName: "Transportation", receiptFile: "IMG_1422.png" },
  { slug: "uber:2025-09-20:out", dateMs: Date.UTC(2025, 8, 20), amountCents: 2747, merchant: "Uber",
    description: "Uber to Love Thy Neighbor — Long Island City → 72nd St",
    budgetLabel: "Love Thy Neighbor 2025", categoryName: "Transportation", receiptFile: "IMG_1431.png" },
  { slug: "uber:2025-09-20:back", dateMs: Date.UTC(2025, 8, 20), amountCents: 2354, merchant: "Uber",
    description: "Uber from Love Thy Neighbor — 72nd St → Long Island City",
    budgetLabel: "Love Thy Neighbor 2025", categoryName: "Transportation", receiptFile: "IMG_1432.png" },
];

/**
 * Corrections to rows that already exist. Only the fields present are written.
 * `mergeExternalIds` deletes those rows after the patch lands — used only for the
 * Zoom order, where three per-item rows collapse into the one charge that cleared.
 */
export const CLEANUP_PATCHES: CleanupPatch[] = [
  { externalId: "genesis-inkind-exp:buy25:3", amountCents: 5440,
    description: "Amazon order 113-8758403-7261044 — SanDisk 128GB Extreme PRO ×2 + BENFEI 4-in-1 card reader",
    reason: "Row recorded only the card reader; the order also held two SanDisk cards.",
    receiptFile: "Screenshot 2026-08-05 at 11.46.08 PM.png" },
  { externalId: "genesis-inkind-exp:buy25:22", amountCents: 6465,
    description: "Amazon order 113-9213459-6965863 — Axidou red stackable chairs, 4-pack",
    reason: "$60.00 was an estimate; the order total is $64.65.",
    receiptFile: "Screenshot 2026-08-05 at 11.45.19 PM.png" },
  { externalId: "genesis-inkind-exp:buy25:2", amountCents: 5878,
    description: "Amazon order 113-8229826-5373022 — Lexar 128GB Professional SD + Doseno foldable stools ×2",
    reason: "Row recorded only the SD card; the order also held two stools.",
    receiptFile: "Screenshot 2026-08-05 at 11.36.24 PM.png" },
  {
    externalId: "genesis-inkind-exp:buy25:25",
    amountCents: 48646,
    dateMs: Date.UTC(2025, 3, 20),
    budgetLabel: "Worship in Public - Social Media Growth Strategy",
    description:
      "Amazon order 113-9180746-7110646 — Zoom H6essential recorder, Zoom EXH-6e input capsule, " +
      "Amazon Basics 128GB micro SDXC, AA batteries 100-pack",
    reason:
      "Three per-item rows with tax spread — the capsule misdated to 2025-05-21 and the " +
      "$25.84 battery pack dropped entirely. One order-level row is what cleared the card.",
    mergeExternalIds: ["genesis-inkind-exp:buy25:26", "genesis-inkind-exp:buy25:27"],
    receiptFile: "Screenshot 2026-08-05 at 11.44.52 PM.png",
  },
];

/** Rows that need no change beyond the document arriving. */
export const CLEANUP_RECEIPTS_ONLY: { externalId: string; receiptFile: string }[] = [
  { externalId: "genesis-inkind-exp:buy25:9",  receiptFile: "Screenshot 2026-08-05 at 9.48.48 PM.png" },   // Cajon
  { externalId: "genesis-inkind-exp:buy25:0",  receiptFile: "Screenshot 2026-08-05 at 11.46.36 PM.png" },  // Casio
  { externalId: "genesis-inkind-exp:buy25:1",  receiptFile: "Screenshot 2026-08-05 at 11.46.20 PM.png" },  // Picnic basket
  { externalId: "genesis-inkind-exp:buy25:24", receiptFile: "Screenshot 2026-08-05 at 11.34.10 PM.png" },  // 128GB micro
  { externalId: "genesis-inkind-exp:buy25:19", receiptFile: "IMG_1424.png" },                              // Uber to Gantry
  { externalId: "genesis-inkind-exp:buy25:20", receiptFile: "IMG_1425.png" },                              // Uber from Gantry
  { externalId: "genesis-inkind-exp:buy25:12", receiptFile: "IMG_1430.png" },                              // Uber to Perspective Saints
  { externalId: "genesis-inkind-exp:buy25:30", receiptFile: "Instacart Receipt for Order #061317202447354413288.pdf" }, // Eden drinks
  { externalId: "genesis-inkind-exp:buy25:23", receiptFile: "IMG_1436.png" },                              // Chick-fil-A
];

/** Expense category for every genesis row that had none. */
export const CLEANUP_CATEGORIES: CleanupCategory[] = [
  ...[
    "gear2024:114-9890645-7982630", "gear2024:114-5352971-4525852",
    "gear2024:113-9783604-6351443", "gear2024:114-9720035-4663454",
    "gear2024:114-2921193-5253036", "gear2024:SW-42245906",
    "gear2024:113-0050781-0511435", "gear2024:113-8295064-4780255",
    "gear2024:113-8870418-2398600", "gear2024:113-3344077-9105060",
    "gear2024:114-0656524-2178659", "gear2024:113-8159100-9204204",
    "gear2024:113-3535920-5449002", "gear2024:113-5055024-2268266",
    "gear2024:114-3211256-5253822", "gear2024:114-2172407-9957842",
    "gear2024:113-3096883-7982617", "gear2024:113-7023722-7963431",
    "buy25:2", "buy25:3", "buy25:4", "buy25:5", "buy25:6", "buy25:25",
  ].map((s) => ({ externalId: `genesis-inkind-exp:${s}`, categoryName: "Equipment" })),

  ...["buy25:16", "buy25:17", "buy25:23", "buy25:28", "buy25:29", "buy25:30", "don25:layomi-jingli"]
    .map((s) => ({ externalId: `genesis-inkind-exp:${s}`, categoryName: "Food & Meals" })),

  // Vendors, honoraria, and the lens RENTALS — a service, not an acquisition.
  ...["buy25:10", "buy25:31", "buy25:32", "buy25:33", "don25:layomi-lens1", "don25:layomi-lens2"]
    .map((s) => ({ externalId: `genesis-inkind-exp:${s}`, categoryName: "Professional Services" })),

  ...["buy25:21", "buy25:22"]
    .map((s) => ({ externalId: `genesis-inkind-exp:${s}`, categoryName: "Supplies" })),

  ...["buy25:7", "buy25:8", "buy25:19", "buy25:20", "don25:layomi-uber"]
    .map((s) => ({ externalId: `genesis-inkind-exp:${s}`, categoryName: "Transportation" })),
];

/**
 * Rows with no obtainable receipt, filed as RECEIPT EXCEPTIONS rather than left
 * nagging as overdue. Two carry `evidenceFile` — an Apple Cash screenshot showing the
 * money moving to the person who made the purchase. That is deliberately evidence and
 * NOT a receipt: it proves what was paid to whom, not what was bought, and the
 * exception system keeps that distinction visible on a published ledger.
 *
 * ALL FOUR ARE `lost`, NOT `no_receipt_issued` (owner correction, 2026-08-06).
 * `no_receipt_issued` means a document never existed — a parking meter, a cash tip, a
 * donation box. A grocery store, a restaurant and Instacart all issue receipts; these
 * were issued and simply not kept. Recording them as "never issued" would overstate
 * how unavoidable the gap was, which is the opposite of what an exception is for.
 *
 * Everything else still bare is being CHASED (Layomi owes five rows; the owner can
 * still pull two March Central Park rides from his own Uber history), so those are
 * deliberately absent here — a row awaiting a document must keep nagging.
 */
export const CLEANUP_EXCEPTIONS: CleanupException[] = [
  {
    externalId: "genesis-inkind-exp:buy25:16",
    reason: "lost",
    note: "Chicken gyros and water bottles for the team during the March 2025 social-media shoot. Bought in person and paid personally; the restaurant issued a receipt but it was not kept. Owner checked his camera roll — no photo of it either.",
  },
  {
    externalId: "genesis-inkind-exp:buy25:17",
    reason: "lost",
    note: "Chicken gyros for the team during the March 2025 social-media shoot. Bought in person and paid personally; the restaurant issued a receipt but it was not kept. Owner checked his camera roll — no photo of it either.",
  },
  {
    externalId: "genesis-inkind-exp:buy25:21",
    reason: "lost",
    note: "Flowers, fruits and snacks used as props for the March 2025 social-media shoot in Central Park. Ella bought them at a store on the day — a receipt was issued to her but not kept. She was reimbursed $40 by Apple Cash; the texts arranging it and the payment are attached as evidence of the purchase.",
    evidenceFile: "IMG_1418.png",
  },
  {
    externalId: "genesis-inkind-exp:buy25:28",
    reason: "lost",
    note: "Charcuterie for volunteers at Eden, June 2025. Cindy ordered it on her own Instacart account — Instacart issued her a receipt but it was not kept. She confirmed the $85 by text and was reimbursed $85 by Apple Cash, attached as evidence of the purchase.",
    evidenceFile: "IMG_1421.jpeg",
  },
];
