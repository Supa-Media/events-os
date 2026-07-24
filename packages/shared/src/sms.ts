/**
 * SMS segment estimation + pricing (Attendance F) — used by BOTH the Convex
 * backend (`blasts.ts`'s cost preview + usage ledger, `smsUsage.ts`'s spend
 * summary) and the Expo app (`BlastComposerCard.tsx`'s live cost line), so
 * the estimate never drifts between the two.
 *
 * A carrier bills SMS per SEGMENT, not per message: a body that fits GSM-7
 * encoding gets 160 chars in a single segment (153/segment once it needs to
 * be split across multiple, because 7 bytes go to a concatenation header);
 * a body that needs UCS-2 (any character outside the GSM-7 repertoire — most
 * emoji, most non-Latin scripts) gets 70 chars single-segment (67/segment
 * once split). See docs/plans/sms-comms.md for the full design + the finance
 * recipe this feeds.
 */

// GSM 03.38 "basic" character set — each counts as ONE GSM-7 septet.
const GSM7_BASIC_CHARS = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);

// GSM 03.38 "extension" table — reached via an ESC (0x1B) escape, so each
// counts as TWO septets, not one.
const GSM7_EXTENDED_CHARS = new Set(["\f", "^", "{", "}", "\\", "[", "~", "]", "|", "€"]);

const GSM7_SINGLE_SEGMENT_LIMIT = 160;
const GSM7_MULTI_SEGMENT_SIZE = 153;
const UCS2_SINGLE_SEGMENT_LIMIT = 70;
const UCS2_MULTI_SEGMENT_SIZE = 67;

/**
 * Estimate how many SMS segments `body` will bill as. Iterates by Unicode
 * code point (not UTF-16 code unit) so an astral character (most emoji) is
 * inspected as one unit — the moment ANY character falls outside the GSM-7
 * basic+extended repertoire, the whole message downgrades to UCS-2 encoding
 * (a real carrier can't mix encodings within one message). An empty body
 * still costs one segment (Twilio bills the empty send).
 */
export function estimateSegments(body: string): number {
  if (body.length === 0) return 1;

  let isGsm7 = true;
  let gsm7Length = 0;
  for (const ch of body) {
    if (GSM7_BASIC_CHARS.has(ch)) {
      gsm7Length += 1;
    } else if (GSM7_EXTENDED_CHARS.has(ch)) {
      gsm7Length += 2;
    } else {
      isGsm7 = false;
      break;
    }
  }

  if (isGsm7) {
    if (gsm7Length <= GSM7_SINGLE_SEGMENT_LIMIT) return 1;
    return Math.ceil(gsm7Length / GSM7_MULTI_SEGMENT_SIZE);
  }

  // UCS-2: count UTF-16 code units (`.length`) — a surrogate-pair emoji
  // consumes 2 code units, matching how carriers actually segment it.
  const ucs2Length = body.length;
  if (ucs2Length <= UCS2_SINGLE_SEGMENT_LIMIT) return 1;
  return Math.ceil(ucs2Length / UCS2_MULTI_SEGMENT_SIZE);
}

/**
 * Flat per-segment price estimate in MICRO-dollars (1e-6 USD) — ≈ $0.01,
 * a ballpark of Twilio's US long-code/Messaging-Service SMS rate plus
 * typical carrier fees. This is an ESTIMATE CONSTANT for the cost preview +
 * usage ledger, NOT a live rate pulled from Twilio's pricing API — actual
 * per-segment cost varies by destination carrier and changes over time. See
 * docs/plans/sms-comms.md.
 */
export const SMS_SEGMENT_PRICE_USD_MICROS = 10_000;

/** Estimated total cost (micro-USD) to send `body` to `recipientCount`
 *  numbers, at the flat `SMS_SEGMENT_PRICE_USD_MICROS` rate. */
export function estimateSmsCostUsdMicros(
  body: string,
  recipientCount: number,
): number {
  return estimateSegments(body) * SMS_SEGMENT_PRICE_USD_MICROS * recipientCount;
}

/**
 * Micro-USD (1e-6 USD — the unit `costUsdMicros` fields use throughout the
 * app: `smsUsageEvents`, `aiUsageEvents`) as a display dollar string: 2
 * decimals at or above a cent, 4 decimals below (a single SMS segment is
 * ~$0.01, and a single AI call is often well under a cent, so both need the
 * extra precision down there), "$0.00" for exactly zero.
 *
 * The ONE shared micro-USD formatter — previously reimplemented three times
 * (`AiUsageSection.tsx`'s and `TwilioUsageSummary.tsx`'s near-identical
 * `formatMicroCost`, plus `BlastComposerCard.tsx`'s cents-rounding
 * `formatSmsCost`), which is how they drifted. Every mobile screen showing a
 * micro-USD amount should use this instead of a local copy.
 */
export function formatUsdMicros(micros: number): string {
  const usd = micros / 1_000_000;
  return usd === 0 ? "$0.00" : `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}
