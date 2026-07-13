/**
 * Places autocomplete — the server-side proxy for location suggestions.
 *
 * The client never sees the Google API key: the mobile app calls this action
 * with the user's partial query, and we forward it to Google's Places
 * Autocomplete endpoint and hand back a trimmed list of predictions. We only
 * store the chosen location as free text (see `events.location`), so we return
 * the human-readable description plus the split main/secondary text for a
 * Google-Maps-style two-line suggestion row.
 *
 * Requires the `GOOGLE_PLACES_API_KEY` Convex environment variable (set via
 * `npx convex env set GOOGLE_PLACES_API_KEY <key>`). If it's missing the action
 * degrades gracefully to zero suggestions, so the field stays a plain text box.
 */
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { requireAccess } from "./lib/context";

const AUTOCOMPLETE_URL =
  "https://maps.googleapis.com/maps/api/place/autocomplete/json";

/** Don't bother querying Google until there's enough to match on. */
const MIN_QUERY_LENGTH = 3;

/** Cap suggestions so the dropdown stays a glanceable shortlist. */
const MAX_SUGGESTIONS = 5;

const suggestionValidator = v.object({
  /** Full single-line label, e.g. "Wembley Stadium, London, UK". */
  description: v.string(),
  /** Primary line, e.g. "Wembley Stadium". */
  mainText: v.string(),
  /** Secondary line, e.g. "London, UK" (may be empty). */
  secondaryText: v.string(),
  /** Google place id — kept for future use (maps, place details). */
  placeId: v.string(),
});

type Prediction = {
  description?: string;
  place_id?: string;
  structured_formatting?: { main_text?: string; secondary_text?: string };
};

/**
 * Ask Google for predictions matching `query`. Fails SOFT: any HTTP, network,
 * or Google-status problem is logged and returned as an empty list, so the
 * caller always degrades to a plain text box rather than throwing.
 */
async function fetchPredictions(
  query: string,
  key: string,
): Promise<Prediction[]> {
  const url = `${AUTOCOMPLETE_URL}?input=${encodeURIComponent(query)}&key=${key}`;
  let data: { status?: string; error_message?: string; predictions?: Prediction[] };
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Places autocomplete HTTP ${res.status}`);
      return [];
    }
    data = await res.json();
  } catch (e) {
    console.error("Places autocomplete request failed", e);
    return [];
  }

  // ZERO_RESULTS is a normal empty answer; anything else non-OK is a config or
  // quota problem worth logging (but we still fail soft for the user).
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    console.error(
      `Places autocomplete status ${data.status}: ${data.error_message ?? ""}`,
    );
    return [];
  }
  return data.predictions ?? [];
}

/** Trim Google's predictions into the glanceable two-line suggestion shortlist. */
function toSuggestions(predictions: Prediction[]) {
  return predictions
    .slice(0, MAX_SUGGESTIONS)
    .map((p) => ({
      description: p.description ?? "",
      mainText: p.structured_formatting?.main_text ?? p.description ?? "",
      secondaryText: p.structured_formatting?.secondary_text ?? "",
      placeId: p.place_id ?? "",
    }))
    .filter((s) => s.description.length > 0);
}

/**
 * Access gate for the autocomplete action. Actions have no `ctx.db`, so the
 * allowlist check (which reads the user row + guest table) runs inside this
 * internalQuery that the action calls first — the established pattern for
 * authenticating actions in this codebase (see `ai.myContext`).
 */
export const assertAccess = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireAccess(ctx);
    return null;
  },
});

export const autocomplete = action({
  args: { query: v.string() },
  returns: v.object({ suggestions: v.array(suggestionValidator) }),
  handler: async (ctx, { query }) => {
    // Gate before spending a Google quota call on an unauthenticated request.
    await ctx.runQuery(internal.places.assertAccess, {});

    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) return { suggestions: [] };

    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) {
      console.warn(
        "GOOGLE_PLACES_API_KEY is not set — location autocomplete disabled.",
      );
      return { suggestions: [] };
    }

    const predictions = await fetchPredictions(q, key);
    return { suggestions: toSuggestions(predictions) };
  },
});
