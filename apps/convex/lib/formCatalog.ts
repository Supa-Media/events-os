/**
 * PW Forms consolidation — the 6 Google Form definitions (checked in as DATA,
 * not authored through a builder UI in this PR) plus the CSV parsing/
 * normalization the one-off import (`formSubmissionsImport.ts`) and its tests
 * share. Pure TypeScript, no Convex runtime dependency, so it's usable from a
 * `"use node"` action (reading the founder's local CSV exports) AND from
 * plain vitest.
 *
 * ── Google Forms export quirks this file works around ──────────────────────
 *
 * 1. TRAILING SPACES: Google Forms bakes the question wording verbatim into
 *    the CSV header, including a trailing space some questions happen to end
 *    with ("email ", "Full Name "). Every header lookup here normalizes via
 *    `normalizeHeader` (trim) on BOTH sides, so a catalog entry never has to
 *    match the export byte-for-byte.
 *
 * 2. DUPLICATE / NEAR-DUPLICATE COLUMNS from a mid-flight form edit: "Pop The
 *    Balloon" has the exact same question text twice ("Please select when
 *    you'd be available to meet!", asked in two branches of the form) AND a
 *    near-duplicate pair that only differs by capitalization ("...Partiful or
 *    Givebutter?" vs "...Partiful or GiveButter?" — the founder fixed a typo
 *    mid-collection). `readColumn` accepts an ARRAY of header variants and
 *    merges every matching column's non-empty values (a respondent only ever
 *    answers ONE of the two branches, so this is almost always a single
 *    value, not a real merge) — this is also what transparently handles the
 *    exact-duplicate case (both variants normalize to the same string, so
 *    `indexHeaders` already grouped them under one key).
 *
 * 3. MULTI-SELECT vs. FREE-TEXT "OTHER", BOTH COMMA-JOINED: a Google Forms
 *    checkbox question's export is a single comma-joined string, but so is a
 *    free-text "Other" answer that happens to contain commas — you cannot
 *    naively `.split(",")` and treat every piece as a selected option. Team
 *    Interest's "which areas are you interested in serving?" is the one
 *    question in this catalog that needs this (`splitAgainstOptions: true`):
 *    `splitMultiselectWithOther` matches each comma-separated token against
 *    the KNOWN option list (`KNOWN_TEAM_INTEREST_OPTIONS`, derived below) and
 *    files anything that doesn't match into a single `_other` free-text
 *    answer instead of corrupting it into several bogus "options".
 *
 * ── What's promoted onto `people` vs. left in `answers` ─────────────────────
 * Identity (`name`/`email`/`phone`) and Team Interest's matched service
 * checkboxes (via `TEAM_INTEREST_SERVICE_LABELS`, resolved against the
 * Service Catalog seeded on this branch) are the ONLY promotions this PR
 * makes — see `formSubmissions.ts`'s import mutation. Every other durable-
 * looking field (`location`, `referral_source`, Contact Information's
 * consent TIMESTAMP — the Yes/No itself IS promoted, as `marketingOptOut`)
 * is reserved for the sibling `feat/person-form-fields` branch's schema
 * fields and stays in `answers` verbatim so that branch can promote it later
 * WITHOUT re-importing anything.
 */
import type { Id } from "../_generated/dataModel";
import { COLUMN_TYPES, type ColumnType } from "@events-os/shared";

// ═══════════════════════════════════════════════════════════════════════════
// CSV parsing — minimal RFC4180 (quoted fields, embedded commas/newlines,
// escaped `""` quotes). No external dependency; the exports here are small
// (the largest is ~110 rows).
// ═══════════════════════════════════════════════════════════════════════════

export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip a leading BOM, if present

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // swallow — a following "\n" (or end of file) ends the row
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Final field/row, for a file with no trailing newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop a trailing wholly-blank line (a common trailing-newline artifact).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function normalizeHeader(h: string): string {
  return h.trim();
}

/** Group raw header column indexes by their NORMALIZED text — the single
 *  mechanism that handles both the exact-duplicate case (two columns that
 *  normalize to the identical string) and, combined with `readColumn`'s
 *  variant array, the near-duplicate case (different text, same intent). */
function indexHeaders(rawHeaders: string[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  rawHeaders.forEach((h, i) => {
    const key = normalizeHeader(h);
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  });
  return map;
}

/** Read one logical column's value out of a row, merging every index that
 *  matches ANY of `headerNames`'s variants (trimmed non-empty values, deduped,
 *  joined with "; " when more than one distinct value survives — the
 *  overwhelmingly common case is exactly one, since a respondent only ever
 *  answers one branch of a split/edited question). Returns `undefined` when
 *  nothing matched (column absent from this export, or genuinely blank). */
function readColumn(
  row: string[],
  headerIndex: Map<string, number[]>,
  headerNames: string | string[],
): string | undefined {
  const names = Array.isArray(headerNames) ? headerNames : [headerNames];
  const indexes = names.flatMap((n) => headerIndex.get(normalizeHeader(n)) ?? []);
  const values = indexes.map((i) => (row[i] ?? "").trim()).filter((v) => v.length > 0);
  if (values.length === 0) return undefined;
  return [...new Set(values)].join("; ");
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi-select vs. free-text "Other" splitting (see module doc, point 3).
// ═══════════════════════════════════════════════════════════════════════════

export function splitMultiselectWithOther(
  raw: string,
  knownOptions: readonly string[],
): { matched: string[]; other?: string } {
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const knownByLower = new Map(knownOptions.map((o) => [o.toLowerCase(), o]));
  const matched: string[] = [];
  const leftover: string[] = [];
  for (const token of tokens) {
    const hit = knownByLower.get(token.toLowerCase());
    if (hit) matched.push(hit);
    else leftover.push(token);
  }
  return { matched, other: leftover.length > 0 ? leftover.join(", ") : undefined };
}

/**
 * Team Interest's checkbox option universe. The 19 entries with a comment
 * marker below are the ones with ≥2 exact repeats across respondents in the
 * source export (an unambiguous signal of a real checkbox option, not a
 * one-off free-text answer) — these are exactly the founder-specified
 * promotion targets (`TEAM_INTEREST_SERVICE_LABELS`). The rest were seen
 * exactly once each but still read as short, checkbox-style labels (not the
 * sentences/URLs/first-person prose the genuine "Other" free-text answers
 * are) — included here so the splitter doesn't mistake them for free text,
 * even though this PR doesn't yet promote them onto the Service Catalog
 * (no founder-given mapping for them yet).
 */
export const KNOWN_TEAM_INTEREST_OPTIONS: readonly string[] = [
  // ≥2 repeats — promoted (see TEAM_INTEREST_SERVICE_LABELS).
  "Event Coordinator",
  "Instrumentalist – Keyboard",
  "In person Evangelism and Prayer",
  "Social Media – Personality/Influencer",
  "Social Media Strategy / Marketing",
  "Christian Artist (developing your brand)",
  "Music Production / Beat Making",
  "Logistics / Venue Coordination",
  "Greeter",
  "Filmmaking / DP Work",
  "Video Editing",
  "Photography",
  "Graphic Design",
  "Development/Fundraising",
  "Hiring/Recruiting",
  "Finance/Budgeting",
  "Project Management",
  "Pastoral Ministry",
  "Songwriting",
  // Seen once each — known but not (yet) promoted.
  "Audio Engineering – Recording",
  "Brand Storytelling & Public Relations Skills",
  "Event Setup/takedown",
  "Guest service",
  "Instrumentalist – Drums",
  "Intercessor",
  "Miscellaneous",
  "Singing",
  "Vocals",
  "Working With Childeren/Childhood Christian Education",
  "Worship Team",
];

/**
 * Founder-specified mapping: a matched Team Interest checkbox label → one or
 * more canonical Service Catalog labels (`lib/serviceCatalog.ts#CANONICAL_SERVICE_CATALOG`,
 * `"Name"` for a top-level option, `"Parent:Child"` for a child — the same
 * format `ensureOrgWideServiceCatalog`'s `labelToId` map uses). One raw
 * option can map onto MORE than one catalog service ("In person Evangelism
 * and Prayer" → both `Evangelism` and `Prayer & Intercession`).
 */
export const TEAM_INTEREST_SERVICE_LABELS: Readonly<Record<string, readonly string[]>> = {
  "Event Coordinator": ["Event Coordination"],
  "Instrumentalist – Keyboard": ["Instruments:Keyboard"],
  "In person Evangelism and Prayer": ["Evangelism", "Prayer & Intercession"],
  "Social Media – Personality/Influencer": ["Social Media:Content"],
  "Social Media Strategy / Marketing": ["Social Media:Strategy"],
  "Christian Artist (developing your brand)": ["Artist Development"],
  "Music Production / Beat Making": ["Music Production"],
  "Logistics / Venue Coordination": ["Logistics & Venue"],
  Greeter: ["Guest Services"],
  "Filmmaking / DP Work": ["Media:Filmmaking"],
  "Video Editing": ["Media:Video Editing"],
  Photography: ["Media:Photography"],
  "Graphic Design": ["Graphic Design"],
  "Development/Fundraising": ["Development & Fundraising"],
  "Hiring/Recruiting": ["Hiring & Recruiting"],
  "Finance/Budgeting": ["Finance & Budgeting"],
  "Project Management": ["Project Management"],
  "Pastoral Ministry": ["Pastoral Ministry"],
  Songwriting: ["Songwriting"],
};

/**
 * Resolve Team Interest's MATCHED checkbox options (the `matched` array
 * `splitMultiselectWithOther` produced) to Service Catalog ids, against an
 * already-resolved `labelToId` (from `lib/serviceCatalog.ts#ensureOrgWideServiceCatalog`).
 * Mirrors `resolveLegacyServiceStrings`'s "report, never guess" contract: a
 * raw option with no `TEAM_INTEREST_SERVICE_LABELS` entry, or whose mapped
 * label isn't in `labelToId`, is reported in `unmapped` rather than dropped
 * silently.
 */
export function resolveTeamInterestServiceIds(
  labelToId: Map<string, Id<"serviceOptions">>,
  matchedOptions: readonly string[],
): { serviceIds: Id<"serviceOptions">[]; unmapped: string[] } {
  const ids = new Set<Id<"serviceOptions">>();
  const unmapped: string[] = [];
  for (const raw of matchedOptions) {
    const labels = TEAM_INTEREST_SERVICE_LABELS[raw];
    if (!labels) {
      unmapped.push(raw);
      continue;
    }
    for (const label of labels) {
      const id = labelToId.get(label.toLowerCase());
      if (id) ids.add(id);
      else unmapped.push(`${raw} → ${label}`);
    }
  }
  return { serviceIds: [...ids], unmapped };
}

// ═══════════════════════════════════════════════════════════════════════════
// Timestamp parsing — the REAL Google Forms response time, not import time.
// ═══════════════════════════════════════════════════════════════════════════

/** Day-of-month of the Nth Sunday of a (UTC-anchored) month — used only to
 *  compute the US DST transition dates below. */
function nthSundayOfMonth(year: number, month1to12: number, n: number): number {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstSundayOffset = (7 - first.getUTCDay()) % 7;
  return 1 + firstSundayOffset + (n - 1) * 7;
}

/** US Eastern DST rule: 2nd Sunday of March through 1st Sunday of November. */
function isEasternDaylightTime(year: number, month: number, day: number): boolean {
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  const marchSecondSunday = nthSundayOfMonth(year, 3, 2);
  const novemberFirstSunday = nthSundayOfMonth(year, 11, 1);
  return month === 3 ? day >= marchSecondSunday : day < novemberFirstSunday;
}

/**
 * Parse a Google Forms export's `Timestamp` column ("M/D/YYYY H:MM:SS", no
 * timezone in the export) into epoch ms. Google Forms stamps responses in
 * the form OWNER's Apps Script timezone — Public Worship's forms are all
 * owned/run out of NYC, so this assumes America/New_York and applies the US
 * DST rule above. Good enough for import/history ordering and display; a
 * handful of rows within an hour of a DST transition may be off by an hour,
 * which doesn't affect ordering across days or the aggregate reporting this
 * data feeds. Falls back to `Date.parse` (then `Date.now()`) for anything
 * that doesn't match the expected export format.
 */
export function parseGoogleFormsTimestamp(raw: string): number {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) {
    const fallback = Date.parse(raw);
    return Number.isNaN(fallback) ? Date.now() : fallback;
  }
  const [, moS, dayS, yearS, hS, minS, secS] = m;
  const month = Number(moS);
  const day = Number(dayS);
  const year = Number(yearS);
  const hour = Number(hS);
  const minute = Number(minS);
  const second = Number(secS);
  const offsetHours = isEasternDaylightTime(year, month, day) ? 4 : 5;
  return Date.UTC(year, month - 1, day, hour + offsetHours, minute, second);
}

// ═══════════════════════════════════════════════════════════════════════════
// Form catalog — one entry per Google Form CSV.
// ═══════════════════════════════════════════════════════════════════════════

export type FormScope = "person" | "event";

export interface FormColumnDef {
  /** The raw CSV header (or, for a mid-flight-edited question, every variant
   *  seen across the export's lifetime — see module doc point 2). Matched
   *  after `normalizeHeader` (trim) on both sides. */
  header: string | string[];
  /** Stable key `formSubmissions.answers` is keyed by — survives a header
   *  wording change (unlike the raw header itself). */
  key: string;
  label: string;
  type: ColumnType;
  options?: string[];
  /** Team Interest's checkbox question only (see module doc point 3): split
   *  the raw comma-joined value against `options` (falls back to
   *  `KNOWN_TEAM_INTEREST_OPTIONS` when `options` is unset), producing an
   *  ARRAY under `key` plus a `${key}_other` free-text remainder. */
  splitAgainstOptions?: boolean;
}

export interface FormDefinition {
  formKey: string;
  title: string;
  scope: FormScope;
  /** A stable substring of the founder's exported filename — matched instead
   *  of the exact filename, which is unwieldy and can shift on re-export
   *  (Google appends "(1)", the sheet's own display name, etc). */
  fileMatch: string;
  columns: FormColumnDef[];
}

const YES_NO = ["Yes", "No"];
/** Ordered worst→best — position (1-indexed) is the numeric score
 *  `formSubmissions.ts#summaryForEvent` averages. Exported so that reader
 *  can recognize/aggregate a rating-scale answer generically. */
export const RATING_SCALE = ["Poor", "Fair", "Good", "Excellent"] as const;

/** Eden survey's rating-style questions, in the order `summaryForEvent`
 *  reports them — every one uses `RATING_SCALE`. */
export const EDEN_RATING_KEYS: readonly string[] = [
  "rating_overall",
  "rating_picnic_blanket_layout",
  "rating_floral_arrangement",
  "rating_charcuterie_table",
  "rating_event_flow",
  "rating_hospitality",
];

export const FORM_CATALOG: readonly FormDefinition[] = [
  {
    formKey: "contact_information",
    title: "Contact Information",
    scope: "person",
    fileMatch: "Contact Information",
    columns: [
      { header: "Name", key: "name", label: "Name", type: "text" },
      { header: "Email", key: "email", label: "Email", type: "text" },
      { header: "Phone number", key: "phone", label: "Phone number", type: "text" },
      {
        header:
          "Where are you from? [If living in NYC, specify which borough. If outside of NYC, specify city and state]",
        key: "location",
        label: "Where are you from?",
        type: "text",
      },
      {
        header: "How did you hear about Public Worship Life",
        key: "referral_source",
        label: "How did you hear about Public Worship Life",
        type: "text",
      },
      {
        header: "How would you describe your walk with Jesus",
        key: "walk_with_jesus",
        label: "How would you describe your walk with Jesus",
        type: "longtext",
      },
      {
        header:
          "Do you consent to receiving emails or messages, by Public Worship Life, promoting upcoming events and activities in the future? ",
        key: "consent",
        label: "Consent to marketing emails",
        type: "select",
        options: YES_NO,
      },
    ],
  },
  {
    formKey: "eden_survey",
    title: "Eden: Worship & Picnic Attendee Survey",
    scope: "event",
    fileMatch: "Eden_ Worship",
    columns: [
      {
        header: "How did you hear about our Eden: Worship & Picnic event?",
        key: "heard_about",
        label: "How did you hear about this event?",
        type: "text",
      },
      {
        header: "How would you rate the overall event?",
        key: "rating_overall",
        label: "Overall rating",
        type: "select",
        options: [...RATING_SCALE],
      },
      {
        header: "What was your favorite part of Eden: Worship & Picnic?",
        key: "favorite_part",
        label: "Favorite part",
        type: "text",
      },
      {
        header: "How would you rate the following? [Picnic Blanket Layout]",
        key: "rating_picnic_blanket_layout",
        label: "Rating: Picnic Blanket Layout",
        type: "select",
        options: [...RATING_SCALE],
      },
      {
        header: "How would you rate the following? [Floral arrangement station]",
        key: "rating_floral_arrangement",
        label: "Rating: Floral arrangement station",
        type: "select",
        options: [...RATING_SCALE],
      },
      {
        header: "How would you rate the following? [Charcuterie grazing table]",
        key: "rating_charcuterie_table",
        label: "Rating: Charcuterie grazing table",
        type: "select",
        options: [...RATING_SCALE],
      },
      {
        header: "How would you rate the following? [Event flow/schedule]",
        key: "rating_event_flow",
        label: "Rating: Event flow/schedule",
        type: "select",
        options: [...RATING_SCALE],
      },
      {
        header: "How would you rate the following? [Hospitality/welcome]",
        key: "rating_hospitality",
        label: "Rating: Hospitality/welcome",
        type: "select",
        options: [...RATING_SCALE],
      },
      {
        header: "What possible experiences would you enjoy at a future Eden event?",
        key: "future_experiences",
        label: "Future experience ideas",
        type: "longtext",
      },
      {
        header:
          "Did you leave with a clear understanding of what Public Worship is as a non-profit organization?",
        key: "understood_nonprofit",
        label: "Understood nonprofit mission?",
        type: "select",
        options: YES_NO,
      },
      {
        header: "Any additional feedback or comments?",
        key: "additional_feedback",
        label: "Additional feedback",
        type: "longtext",
      },
      {
        header: "Any testimonies or praise reports related to Eden: Worship & Picnic?",
        key: "testimonies",
        label: "Testimonies / praise reports",
        type: "longtext",
      },
    ],
  },
  {
    formKey: "crossover_vocals",
    title: "PW Crossover Night Vocals Interest Form",
    scope: "person",
    fileMatch: "Crossover Night Vocals",
    columns: [
      { header: "Full Name ", key: "name", label: "Full name", type: "text" },
      { header: "phone number ", key: "phone", label: "Phone number", type: "text" },
      { header: "email ", key: "email", label: "Email", type: "text" },
      { header: "Voice Part", key: "voice_part", label: "Voice part", type: "select" },
      {
        header: "Are you available for rehearsal Wednesday December 17th @ 6:00 pm ",
        key: "rehearsal_available",
        label: "Available for rehearsal (Dec 17, 6pm)?",
        type: "select",
        options: YES_NO,
      },
      {
        header: "Do you have experience singing background vocals",
        key: "backup_vocals_experience",
        label: "Background vocals experience?",
        type: "select",
        options: YES_NO,
      },
      { header: "Years of Experience", key: "years_experience", label: "Years of experience", type: "text" },
      {
        header: "Are you familiar with African Praise and Worship",
        key: "familiar_african_praise_worship",
        label: "Familiar with African Praise and Worship?",
        type: "select",
        options: YES_NO,
      },
      {
        header: "Please upload a short singing clip. (30 secs- 1 minutes) ",
        key: "singing_clip_upload",
        label: "Singing clip upload",
        type: "url",
      },
      {
        header:
          "Please provide a short singing clip (30 seconds–1 minute) and a public video link (e.g., YouTube, Instagram, Dropbox). Make sure the link is viewable without login.",
        key: "singing_clip_link",
        label: "Singing clip link",
        type: "url",
      },
    ],
  },
  {
    formKey: "pop_the_balloon",
    title: "Pop The Balloon [Christian Edition] Questionnaire",
    scope: "person",
    fileMatch: "Pop The Balloon",
    columns: [
      { header: "What's your name (first and last)?", key: "name", label: "Name", type: "text" },
      { header: "Email address?", key: "email", label: "Email", type: "text" },
      { header: "Age?", key: "age", label: "Age", type: "number" },
      {
        header: "What is your preferred age range when dating?",
        key: "preferred_age_range",
        label: "Preferred age range",
        type: "text",
      },
      {
        header:
          "are you a fruit-bearing, Jesus loving, God-fearing, bible believing, spirit filled individual?",
        key: "fruit_bearing_believer",
        label: "Fruit-bearing believer?",
        type: "select",
      },
      { header: "Occupation?", key: "occupation", label: "Occupation", type: "text" },
      {
        header: "Do you live in NYC or surrounding areas permanently? ",
        key: "lives_in_nyc_area",
        label: "Lives in NYC area?",
        type: "text",
      },
      {
        header: "How would you describe your single season?",
        key: "single_season",
        label: "Single season",
        type: "longtext",
      },
      { header: "Which church do you attend?", key: "church", label: "Church", type: "text" },
      {
        header:
          "Do you want to be the main person facing the panel or in the panel holding a balloon?",
        key: "panel_role_preference",
        label: "Panel role preference",
        type: "select",
      },
      { header: "Do you have any kids?", key: "has_kids", label: "Has kids?", type: "select", options: YES_NO },
      {
        header: "Would you be open to someone with children?",
        key: "open_to_kids",
        label: "Open to someone with children?",
        type: "select",
        options: YES_NO,
      },
      {
        header:
          "Instagram username / recent photo link (please link a recent photo of yourself if your page is private or you don't have social media)",
        key: "instagram_or_photo",
        label: "Instagram username / photo link",
        type: "text",
      },
      {
        header: "Gender? (Only accepting male applicants)",
        key: "gender",
        label: "Gender",
        type: "select",
      },
      {
        // Duplicate header text (asked in two branches of the form) — see
        // module doc point 2. `readColumn` merges both automatically.
        header: "Please select when you'd be available to meet!",
        key: "availability",
        label: "Availability",
        type: "text",
      },
      {
        // Near-duplicate pair from a mid-flight capitalization fix
        // ("Givebutter" → "GiveButter") — see module doc point 2.
        header: [
          "Have you gotten your ticket or RSVP’d on Partiful or Givebutter?",
          "Have you gotten your ticket or RSVP’d on Partiful or GiveButter?",
        ],
        key: "rsvp_confirmed",
        label: "RSVP'd on Partiful or Givebutter?",
        type: "select",
        options: YES_NO,
      },
    ],
  },
  {
    formKey: "team_interest",
    title: "Public Worship Team Interest",
    scope: "person",
    fileMatch: "Team Interest",
    columns: [
      { header: "Full Name", key: "name", label: "Full name", type: "text" },
      { header: "Email", key: "email", label: "Email", type: "text" },
      { header: "Phone Number", key: "phone", label: "Phone number", type: "text" },
      { header: "City & State", key: "location", label: "City & State", type: "text" },
      { header: "Social media handle", key: "social_handle", label: "Social media handle", type: "text" },
      {
        header: "Which areas are you interested in serving?",
        key: "services_selected",
        label: "Areas interested in serving",
        type: "multiselect",
        options: [...KNOWN_TEAM_INTEREST_OPTIONS],
        splitAgainstOptions: true,
      },
      {
        header:
          "Tell us more about your background, experience, or why you want to serve with Public Worship",
        key: "background",
        label: "Background / experience",
        type: "longtext",
      },
      {
        header: "Are you currently available to serve in any way if a need arises?",
        key: "availability",
        label: "Currently available to serve?",
        type: "select",
        options: [
          "Yes, I’m available now",
          "Only for short-term projects",
          "Not right now, but keep me in the loop",
          "I’m just curious / exploring",
        ],
      },
      {
        header: "Anything else you'd like to share?",
        key: "additional_notes",
        label: "Anything else you'd like to share?",
        type: "longtext",
      },
    ],
  },
  {
    formKey: "wws_interest",
    title: "Public Worship: WWS Interest Form",
    scope: "person",
    fileMatch: "WWS Interest",
    columns: [
      { header: "Email Address", key: "email", label: "Email", type: "text" },
      { header: "Full Name", key: "name", label: "Full name", type: "text" },
      { header: "Phone Number", key: "phone", label: "Phone number", type: "text" },
      { header: "IG Username", key: "ig_username", label: "Instagram username", type: "text" },
      { header: "TikTok Username", key: "tiktok_username", label: "TikTok username", type: "text" },
      { header: "Where are you located?", key: "location", label: "Where are you located?", type: "text" },
      {
        header: "Please indicate all dates on which you are available from the list below:",
        key: "available_dates",
        label: "Available dates",
        type: "text",
      },
      {
        header: "Do you consent to being a collaborator on your posts?",
        key: "consent_collaborator",
        label: "Consents to being a collaborator?",
        type: "select",
        options: YES_NO,
      },
      {
        header: "Would you like vocal harmony?",
        key: "wants_vocal_harmony",
        label: "Wants vocal harmony?",
        type: "select",
        options: ["Yes", "No", "Open to it!"],
      },
      {
        header:
          "Please read these guidelines for the type of worship songs we seek to highlight as a collective",
        key: "song_choice",
        label: "Song choice / guideline acknowledgment",
        type: "text",
      },
      {
        header:
          "I have emailed the project lead, Julie (julie@publicworship.life), a 30-60 second recording of me singing a worship song of my choice\n\nOR\n\nI have my own singing content on my social media platforms and have provided the username to my accounts above",
        key: "recording_confirmation",
        label: "Recording / content confirmation",
        type: "longtext",
      },
      {
        header: "Any comments and/or questions?",
        key: "comments",
        label: "Comments / questions",
        type: "longtext",
      },
    ],
  },
];

export function findFormByKey(formKey: string): FormDefinition | undefined {
  return FORM_CATALOG.find((f) => f.formKey === formKey);
}

/** Pick a form's catalog entry from a CSV filename via `fileMatch` (a stable
 *  substring — see `FormDefinition.fileMatch`'s doc). */
export function findFormByFileName(fileName: string): FormDefinition | undefined {
  return FORM_CATALOG.find((f) => fileName.includes(f.fileMatch));
}

/** The DB-persisted shape of a form's question list (`schema/forms.ts#formDefinitions`) —
 *  strips the parser-only fields (`fileMatch`, `scope`, `splitAgainstOptions`)
 *  that have no column in that table. */
export function toFormDefinitionRow(
  form: FormDefinition,
): { formKey: string; title: string; questions: { key: string; label: string; type: ColumnType; options?: string[] }[] } {
  return {
    formKey: form.formKey,
    title: form.title,
    questions: form.columns.map((c) => ({
      key: c.key,
      label: c.label,
      type: c.type,
      ...(c.options ? { options: c.options } : {}),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Row parsing — turns one CSV's raw text into structured submission rows.
// ═══════════════════════════════════════════════════════════════════════════

export interface ParsedFormRow {
  submittedAt: number;
  name?: string;
  email?: string;
  phone?: string;
  answers: Record<string, unknown>;
}

/** Parse one form's CSV export text into structured rows — the shared core
 *  both the import action and its tests use. Blank rows (every cell empty —
 *  a common trailing-line artifact) are skipped. */
export function parseFormCsv(form: FormDefinition, csvText: string): ParsedFormRow[] {
  const table = parseCsvText(csvText);
  if (table.length === 0) return [];
  const [rawHeaders, ...dataRows] = table;
  const headerIndex = indexHeaders(rawHeaders);
  const timestampIndexes = headerIndex.get("Timestamp");

  return dataRows
    .filter((row) => row.some((cell) => cell.trim().length > 0))
    .map((row) => {
      const answers: Record<string, unknown> = {};
      for (const col of form.columns) {
        const raw = readColumn(row, headerIndex, col.header);
        if (raw === undefined) continue;
        if (col.splitAgainstOptions) {
          const { matched, other } = splitMultiselectWithOther(
            raw,
            col.options ?? KNOWN_TEAM_INTEREST_OPTIONS,
          );
          answers[col.key] = matched;
          if (other) answers[`${col.key}_other`] = other;
        } else {
          answers[col.key] = raw;
        }
      }
      const timestampRaw = timestampIndexes ? row[timestampIndexes[0]] ?? "" : "";
      const name = typeof answers.name === "string" ? (answers.name as string) : undefined;
      const email = typeof answers.email === "string" ? (answers.email as string) : undefined;
      const phone = typeof answers.phone === "string" ? (answers.phone as string) : undefined;
      return {
        submittedAt: parseGoogleFormsTimestamp(timestampRaw),
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        answers,
      };
    });
}

/** Contact Information's consent column: `"No"` MUST become
 *  `people.marketingOptOut: true` — never imported as reachable. Any other
 *  value (including the expected `"Yes"`) leaves the default (reachable)
 *  alone. */
export function isMarketingOptOut(answers: Record<string, unknown>): boolean {
  return answers.consent === "No";
}
