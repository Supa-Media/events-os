/**
 * Curated GENESIS giving backfill — Public Worship's pre-platform giving history
 * (2024–2026), owner-curated and APPROVED for production on 2026-07-19.
 * Contains contact PII + founder financial records — private repo; trimmed to
 * needed fields.
 *
 * Provenance: a Notion export of the org's 2024 donation table, founder bank
 * records (Truist → Relay wires/transfers), Zelle receipts for vendor payments
 * made on behalf of the org, and an itemized in-kind gear/expense ledger. These
 * predate BOTH the Givebutter era (see `giving.ts`) and this platform, so they
 * carry no Givebutter txn id — each row instead gets a stable, curated
 * `genesis:`-prefixed `externalRef` that is the idempotency key
 * `historicalBackfill.runGenesisBackfill` dedups on.
 *
 * Fed through the SAME donor/gift commit primitives the canonical import uses
 * (`matchOrCreateDonor` / `recordGiftForDonor`), scoped to the NY chapter.
 * Method → gift.method mapping (never a new union value): `inKind` → "in_kind";
 * else `wire` → "wire"; else (`external`/`transfer`) → "other" — the specific
 * channel is preserved in each row's `note`.
 */

/** How the money arrived, as recorded in the source records. Mapped onto the
 *  existing `GIFT_METHODS` union at commit time (see the module header). */
export type GenesisGiftMethod = "external" | "wire" | "transfer" | "on-behalf";

/** One curated genesis gift. `donorEmail` is present only where the source
 *  record carried one (match-or-create dedups by email when present, else exact
 *  name). `inKind` marks a paid-on-behalf / in-kind gift (committed as an
 *  "in_kind" gift). */
export type GenesisGiftRow = {
  externalRef: string;
  donorName: string;
  donorEmail?: string;
  amountCents: number;
  giftDateMs: number;
  method: GenesisGiftMethod;
  inKind: boolean;
  note: string;
};

export const GENESIS_GIFTS: GenesisGiftRow[] = [
  { externalRef: "genesis:don24:jude", donorName: "Jude Omodon", amountCents: 100000, giftDateMs: 1726228800000, method: "external", inKind: false, note: "Genesis-era donation (Notion 2024 record)" },
  { externalRef: "genesis:don24:segun", donorName: "Segun Olujide", amountCents: 100000, giftDateMs: 1726315200000, method: "external", inKind: false, note: "Music Ministry (Notion 2024 record)" },
  { externalRef: "genesis:don24:tajzai1", donorName: "Tajzai Powell", amountCents: 1500, giftDateMs: 1729080000000, method: "external", inKind: false, note: "For Track (Notion 2024 record)" },
  { externalRef: "genesis:don24:tajzai2", donorName: "Tajzai Powell", amountCents: 5000, giftDateMs: 1766836800000, method: "external", inKind: false, note: "PW Offering (recorded in Notion 2024 table, dated 2025-12-27)" },
  { externalRef: "genesis:don24:layomi-speakers", donorName: "Layomi Kupoluyi", donorEmail: "jesulayomi3.0@gmail.com", amountCents: 70000, giftDateMs: 1730635200000, method: "external", inKind: false, note: "Public Worship Speakers (Notion 2024 record)" },
  { externalRef: "genesis:don24:layomi-food", donorName: "Layomi Kupoluyi", donorEmail: "jesulayomi3.0@gmail.com", amountCents: 44530, giftDateMs: 1730548800000, method: "external", inKind: false, note: "Jing Li & Lagos — covered the 'Food after event' expense (Notion 2024 record)" },
  { externalRef: "genesis:don25:layomi-lens1", donorName: "Layomi Kupoluyi", donorEmail: "jesulayomi3.0@gmail.com", amountCents: 9987, giftDateMs: 1742644800000, method: "external", inKind: true, note: "In-kind: Camera Lens Rental" },
  { externalRef: "genesis:don25:layomi-lens2", donorName: "Layomi Kupoluyi", donorEmail: "jesulayomi3.0@gmail.com", amountCents: 7459, giftDateMs: 1743249600000, method: "external", inKind: true, note: "In-kind: Camera Lens Rental + Transport" },
  { externalRef: "genesis:don25:layomi-uber", donorName: "Layomi Kupoluyi", donorEmail: "jesulayomi3.0@gmail.com", amountCents: 3234, giftDateMs: 1742040000000, method: "external", inKind: true, note: "In-kind: Uber from Central Park" },
  { externalRef: "genesis:don25:layomi-jingli", donorName: "Layomi Kupoluyi", donorEmail: "jesulayomi3.0@gmail.com", amountCents: 6733, giftDateMs: 1743249600000, method: "external", inKind: true, note: "In-kind: Jing Li (food)" },
  { externalRef: "genesis:wire:2025-09-17", donorName: "Oluseyi Olujide", amountCents: 100000, giftDateMs: 1758110400000, method: "wire", inKind: false, note: "Founder wire into Relay (bank: OLUSEYI OLUJIDE, Wire)" },
  { externalRef: "genesis:wire:2026-03-26", donorName: "Oluseyi Olujide", amountCents: 700000, giftDateMs: 1774526400000, method: "wire", inKind: false, note: "Founder wire into Relay (bank: OLUSEYI OLUJIDE, Wire)" },
  { externalRef: "genesis:truist:1", donorName: "Oluseyi Olujide", amountCents: 50000, giftDateMs: 1758283200000, method: "transfer", inKind: false, note: "Founder contribution via Truist -> Relay transfer (1 of 2)" },
  { externalRef: "genesis:truist:2", donorName: "Oluseyi Olujide", amountCents: 50000, giftDateMs: 1758283200000, method: "transfer", inKind: false, note: "Founder contribution via Truist -> Relay transfer (2 of 2)" },
  { externalRef: "genesis:ltn:sound-deposit", donorName: "Oluseyi Olujide", amountCents: 150000, giftDateMs: 1756036800000, method: "on-behalf", inKind: true, note: "Paid on behalf: LTN production deposit, Soul Cry Studios (Zelle to Gary Soulcry, conf tkplz76rz). Invoice: labor $900 + equipment $1,500 + instruments $600 = $3,000." },
  { externalRef: "genesis:ltn:sound-balance", donorName: "Oluseyi Olujide", amountCents: 150000, giftDateMs: 1758369600000, method: "on-behalf", inKind: true, note: "Paid on behalf: LTN sound second half, Soul Cry Studios (Zelle conf wekn4esl0)" },
  { externalRef: "genesis:ltn:love-offering", donorName: "Oluseyi Olujide", amountCents: 50000, giftDateMs: 1758369600000, method: "on-behalf", inKind: true, note: "Paid on behalf: Love offering to SoulCry Worship for LTN opening set (Zelle conf ug3ml7wr4)" },
  { externalRef: "genesis:gear2024", donorName: "Oluseyi Olujide", amountCents: 372940, giftDateMs: 1735646400000, method: "on-behalf", inKind: true, note: "In-kind: 2024 music-ministry gear, 33 items bought personally (itemized in Notion export; prices include quantities). Dated year-end 2024 — per-item dates were not recorded." },
  { externalRef: "genesis:buy25:0", donorName: "Oluseyi Olujide", amountCents: 23844, giftDateMs: 1741694400000, method: "on-behalf", inKind: true, note: "In-kind: Casio Keyboard [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:1", donorName: "Oluseyi Olujide", amountCents: 3581, giftDateMs: 1741867200000, method: "on-behalf", inKind: true, note: "In-kind: Picnic Basket [Prop] — bought personally" },
  { externalRef: "genesis:buy25:2", donorName: "Oluseyi Olujide", amountCents: 4349, giftDateMs: 1749729600000, method: "on-behalf", inKind: true, note: "In-kind: 128 GB SD Card [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:3", donorName: "Oluseyi Olujide", amountCents: 1087, giftDateMs: 1742299200000, method: "on-behalf", inKind: true, note: "In-kind: SD Card Reader [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:4", donorName: "Oluseyi Olujide", amountCents: 10879, giftDateMs: 1738756800000, method: "on-behalf", inKind: true, note: "In-kind: Shure SM58 Mic [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:5", donorName: "Oluseyi Olujide", amountCents: 116608, giftDateMs: 1738756800000, method: "on-behalf", inKind: true, note: "In-kind: Drum set, Drum Covers, Drum Sticks and Drum Seat [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:6", donorName: "Oluseyi Olujide", amountCents: 14153, giftDateMs: 1738756800000, method: "on-behalf", inKind: true, note: "In-kind: Bongos [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:7", donorName: "Oluseyi Olujide", amountCents: 3196, giftDateMs: 1742040000000, method: "on-behalf", inKind: true, note: "In-kind: Uber to Central Park [Transportation] — bought personally" },
  { externalRef: "genesis:buy25:8", donorName: "Oluseyi Olujide", amountCents: 3744, giftDateMs: 1742040000000, method: "on-behalf", inKind: true, note: "In-kind: Uber from Central Park (1/2) [Transportation] — bought personally" },
  { externalRef: "genesis:buy25:9", donorName: "Oluseyi Olujide", amountCents: 10886, giftDateMs: 1738584000000, method: "on-behalf", inKind: true, note: "In-kind: Cajon [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:10", donorName: "Oluseyi Olujide", amountCents: 10000, giftDateMs: 1741435200000, method: "on-behalf", inKind: true, note: "In-kind: Josh Adriano 3-8 Honorarium [Vendor/Services] — bought personally" },
  { externalRef: "genesis:buy25:12", donorName: "Oluseyi Olujide", amountCents: 3644, giftDateMs: 1739016000000, method: "on-behalf", inKind: true, note: "In-kind: Uber to Perspective Saints Popup [Transportation] — bought personally" },
  { externalRef: "genesis:buy25:13", donorName: "Oluseyi Olujide", amountCents: 8954, giftDateMs: 1739016000000, method: "on-behalf", inKind: true, note: "In-kind: Uber from Perspective Saints Popup [Transportation] — bought personally" },
  { externalRef: "genesis:buy25:16", donorName: "Oluseyi Olujide", amountCents: 2446, giftDateMs: 1742644800000, method: "on-behalf", inKind: true, note: "In-kind: Chicken Gyros and Water Bottles [Food] — bought personally" },
  { externalRef: "genesis:buy25:17", donorName: "Oluseyi Olujide", amountCents: 3592, giftDateMs: 1743249600000, method: "on-behalf", inKind: true, note: "In-kind: Chicken Gyros [Food] — bought personally" },
  { externalRef: "genesis:buy25:19", donorName: "Oluseyi Olujide", amountCents: 1392, giftDateMs: 1743249600000, method: "on-behalf", inKind: true, note: "In-kind: Uber to Gantry State Park [Transportation] — bought personally" },
  { externalRef: "genesis:buy25:20", donorName: "Oluseyi Olujide", amountCents: 1460, giftDateMs: 1743249600000, method: "on-behalf", inKind: true, note: "In-kind: Uber from Gantry State Park [Transportation] — bought personally" },
  { externalRef: "genesis:buy25:21", donorName: "Oluseyi Olujide", amountCents: 4000, giftDateMs: 1742040000000, method: "on-behalf", inKind: true, note: "In-kind: Flowers, Fruits & Snacks [Prop] — bought personally" },
  { externalRef: "genesis:buy25:22", donorName: "Oluseyi Olujide", amountCents: 6000, giftDateMs: 1743681600000, method: "on-behalf", inKind: true, note: "In-kind: Red Chairs [Prop] — bought personally" },
  { externalRef: "genesis:buy25:23", donorName: "Oluseyi Olujide", amountCents: 19992, giftDateMs: 1753531200000, method: "on-behalf", inKind: true, note: "In-kind: Chickfila for volunteers (Get exact later) [Food] — bought personally" },
  { externalRef: "genesis:buy25:24", donorName: "Oluseyi Olujide", amountCents: 1204, giftDateMs: 1752840000000, method: "on-behalf", inKind: true, note: "In-kind: 128 GB Amazon Basics Micro [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:25", donorName: "Oluseyi Olujide", amountCents: 32657, giftDateMs: 1745150400000, method: "on-behalf", inKind: true, note: "In-kind: Zoom H6essential Recorder [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:26", donorName: "Oluseyi Olujide", amountCents: 1196, giftDateMs: 1745150400000, method: "on-behalf", inKind: true, note: "In-kind: 128 GB Amazon Basics Micro [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:27", donorName: "Oluseyi Olujide", amountCents: 11974, giftDateMs: 1747828800000, method: "on-behalf", inKind: true, note: "In-kind: Zoom EXH-6e External Input Capsule [Equipment] — bought personally" },
  { externalRef: "genesis:buy25:28", donorName: "Oluseyi Olujide", amountCents: 8500, giftDateMs: 1749902400000, method: "on-behalf", inKind: true, note: "In-kind: Eden - Charcuterie [Food] — bought personally" },
  { externalRef: "genesis:buy25:29", donorName: "Oluseyi Olujide", amountCents: 40500, giftDateMs: 1749902400000, method: "on-behalf", inKind: true, note: "In-kind: Eden - Lagos Restaurant (Food for volunteers) [Food] — bought personally" },
  { externalRef: "genesis:buy25:30", donorName: "Oluseyi Olujide", amountCents: 12573, giftDateMs: 1749816000000, method: "on-behalf", inKind: true, note: "In-kind: Eden - Drinks [Food] — bought personally" },
  { externalRef: "genesis:buy25:31", donorName: "Oluseyi Olujide", amountCents: 40000, giftDateMs: 1748952000000, method: "on-behalf", inKind: true, note: "In-kind: Development Consulting Fee [Vendor/Services] — bought personally" },
  { externalRef: "genesis:buy25:32", donorName: "Oluseyi Olujide", amountCents: 25000, giftDateMs: 1743854400000, method: "on-behalf", inKind: true, note: "In-kind: Josh Adriano - Filming [Vendor/Services] — bought personally" },
  { externalRef: "genesis:buy25:33", donorName: "Oluseyi Olujide", amountCents: 12500, giftDateMs: 1744459200000, method: "on-behalf", inKind: true, note: "In-kind: John Adriano - Filming [Vendor/Services] — bought personally" },
];
