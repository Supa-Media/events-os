/**
 * Givebutter CONTACTS export parser (founder ask, 2026-07-25: "add all these
 * contacts") — the third paste shape the giving Import screen recognizes,
 * next to canonical rows and the Givebutter TRANSACTIONS export. Detected by
 * its own headers ("Givebutter Contact ID" + "Primary Email" — the
 * transactions export has neither); every parsed row becomes ONE canonical
 * `contact` row (never a donor, never money history — the Contributions
 * columns in this export are display rollups, not transactions).
 *
 * Deliberate choices:
 *  - First/Last names are kept SPLIT (the export has them split; joining and
 *    re-splitting would lose multi-token halves) — they flow to
 *    `people.firstName`/`lastName` via the canonical row's own
 *    firstName/lastName fields.
 *  - "Preferred First Name", when present, wins over "First Name" for the
 *    display name AND the stored half — it's what the person asked to be
 *    called.
 *  - The Engage subscription columns are IGNORED (founder call, 2026-07-25:
 *    clean slate — everyone imports as reachable; PW's own `emailSuppressions`
 *    ledger, which this import never touches, keeps honoring anyone who has
 *    already unsubscribed from PW mail).
 *  - Phones normalize to digits and must be ≥10 of them (the transactions
 *    preset's rule); rows with NO email and no usable phone still parse (the
 *    server's no-identifier owner rule reports them honestly) but are
 *    counted via `noIdentifier` so the screen can flag them up front.
 *
 * The record splitter is QUOTE-AWARE ACROSS NEWLINES (unlike the
 * transactions preset's line splitter): contacts exports carry free-text
 * columns (Notes, Additional Addresses) that can legally contain embedded
 * line breaks inside quotes.
 */

export type GivebutterContact = {
  firstName?: string;
  lastName?: string;
  /** Display name — "Preferred-or-First Last", or the email's local part as a
   *  last resort (a nameless row with an email is still a reachable contact). */
  name: string;
  email?: string;
  phone?: string;
};

export type GivebutterContactsParse = {
  contacts: GivebutterContact[];
  /** Rows with neither an email nor a ≥10-digit phone — they'll be reported
   *  (not created) by the server's owner rule; surfaced up front. */
  noIdentifier: number;
  /** Rows dropped outright: no name, no email, no phone — nothing to import. */
  dropped: number;
};

/** Split raw CSV text into records of cells — quote-aware INCLUDING newlines
 *  inside quoted cells (`""` = escaped quote). CRLF/LF agnostic. */
export function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  let sawAny = false;
  const endCell = () => {
    cells.push(cur.trim());
    cur = "";
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c !== "")) records.push(cells);
    cells = [];
    sawAny = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ",") {
      endCell();
      sawAny = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (sawAny || cur !== "") endRecord();
    } else {
      cur += ch;
      sawAny = true;
    }
  }
  if (sawAny || cur !== "") endRecord();
  return records;
}

function headerIndex(headers: string[], name: string): number {
  const t = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === t);
}

/** Detect + parse a Givebutter CONTACTS export; null if the paste isn't one. */
export function parseGivebutterContacts(text: string): GivebutterContactsParse | null {
  const records = splitCsvRecords(text);
  if (records.length < 1) return null;
  const headers = records[0];
  const iId = headerIndex(headers, "Givebutter Contact ID");
  const iEmail = headerIndex(headers, "Primary Email");
  if (iId < 0 || iEmail < 0) return null; // not this export

  const iFirst = headerIndex(headers, "First Name");
  const iPreferred = headerIndex(headers, "Preferred First Name");
  const iLast = headerIndex(headers, "Last Name");
  const iPhone = headerIndex(headers, "Primary Phone");

  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? "").trim() : "");

  const contacts: GivebutterContact[] = [];
  let noIdentifier = 0;
  let dropped = 0;
  for (const r of records.slice(1)) {
    const preferred = cell(r, iPreferred);
    const firstName = preferred || cell(r, iFirst);
    const lastName = cell(r, iLast);
    const email = cell(r, iEmail).toLowerCase() || undefined;
    const phoneDigits = cell(r, iPhone).replace(/\D/g, "");
    const phone = phoneDigits.length >= 10 ? phoneDigits : undefined;

    const composed = [firstName, lastName].filter(Boolean).join(" ");
    const name = composed || (email ? email.split("@")[0] : "");
    if (!name && !email && !phone) {
      dropped++;
      continue;
    }
    if (!email && !phone) noIdentifier++;
    contacts.push({
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      name: name || "Unknown",
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    });
  }
  return { contacts, noIdentifier, dropped };
}
