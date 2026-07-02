import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { newT } from "./setup.helpers";

/**
 * Characterization tests for the `places.autocomplete` action — the server-side
 * proxy that keeps the Google Places key off the client and hands back a trimmed
 * suggestion shortlist. `fetch` and `GOOGLE_PLACES_API_KEY` are stubbed so the
 * tests never touch the network. The contract they pin down:
 *   - guards short-circuit BEFORE any network call (short query, missing key),
 *   - every non-OK path (HTTP error, thrown fetch, non-OK Google status) fails
 *     soft to zero suggestions rather than throwing,
 *   - ZERO_RESULTS is a normal empty answer, not an error,
 *   - the prediction → suggestion mapping (field mapping, main-text fallback,
 *     empty-description filter, MAX_SUGGESTIONS cap, query trimming/encoding).
 */

type Prediction = {
  description?: string;
  place_id?: string;
  structured_formatting?: { main_text?: string; secondary_text?: string };
};

/** Stub `fetch` with a Google-shaped JSON body and an OK HTTP response. */
function stubFetchOk(body: {
  status?: string;
  error_message?: string;
  predictions?: Prediction[];
}) {
  const fetchMock = vi.fn(async (_url: string) => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const KEY = "test-places-key";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("places.autocomplete — guards (no network)", () => {
  test("returns empty for a query under the 3-char minimum, without fetching", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    const fetchMock = stubFetchOk({ status: "OK", predictions: [] });
    const t = newT();

    const res = await t.action(api.places.autocomplete, { query: "we" });

    expect(res).toEqual({ suggestions: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("trims the query before the length check (whitespace-only is too short)", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    const fetchMock = stubFetchOk({ status: "OK", predictions: [] });
    const t = newT();

    const res = await t.action(api.places.autocomplete, { query: "   " });

    expect(res.suggestions).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns empty when the API key is unset, without fetching", async () => {
    // No stubEnv → process.env.GOOGLE_PLACES_API_KEY is undefined.
    const fetchMock = stubFetchOk({ status: "OK", predictions: [] });
    const t = newT();

    const res = await t.action(api.places.autocomplete, { query: "wembley" });

    expect(res.suggestions).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("places.autocomplete — network / status failures fail soft", () => {
  test("HTTP non-2xx → empty suggestions", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    const t = newT();

    const res = await t.action(api.places.autocomplete, { query: "wembley" });

    expect(res.suggestions).toEqual([]);
  });

  test("fetch throwing → empty suggestions (no rethrow)", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const t = newT();

    const res = await t.action(api.places.autocomplete, { query: "wembley" });

    expect(res.suggestions).toEqual([]);
  });

  test("a non-OK Google status (e.g. REQUEST_DENIED) → empty suggestions", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    stubFetchOk({
      status: "REQUEST_DENIED",
      error_message: "bad key",
      predictions: [{ description: "should be ignored" }],
    });
    const t = newT();

    const res = await t.action(api.places.autocomplete, { query: "wembley" });

    expect(res.suggestions).toEqual([]);
  });

  test("ZERO_RESULTS is a normal empty answer (not an error)", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    stubFetchOk({ status: "ZERO_RESULTS", predictions: [] });
    const t = newT();

    const res = await t.action(api.places.autocomplete, { query: "zzzzqqq" });

    expect(res.suggestions).toEqual([]);
  });
});

describe("places.autocomplete — prediction → suggestion mapping", () => {
  test("maps description / structured main + secondary / placeId", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    stubFetchOk({
      status: "OK",
      predictions: [
        {
          description: "Wembley Stadium, London, UK",
          place_id: "place-1",
          structured_formatting: {
            main_text: "Wembley Stadium",
            secondary_text: "London, UK",
          },
        },
      ],
    });
    const t = newT();

    const { suggestions } = await t.action(api.places.autocomplete, {
      query: "wembley",
    });

    expect(suggestions).toEqual([
      {
        description: "Wembley Stadium, London, UK",
        mainText: "Wembley Stadium",
        secondaryText: "London, UK",
        placeId: "place-1",
      },
    ]);
  });

  test("mainText falls back to description when structured_formatting is absent", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    stubFetchOk({
      status: "OK",
      predictions: [{ description: "Some Venue", place_id: "p" }],
    });
    const t = newT();

    const { suggestions } = await t.action(api.places.autocomplete, {
      query: "some venue",
    });

    expect(suggestions[0].mainText).toBe("Some Venue");
    expect(suggestions[0].secondaryText).toBe("");
  });

  test("drops predictions with an empty/missing description", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    stubFetchOk({
      status: "OK",
      predictions: [
        { description: "", place_id: "empty" },
        { place_id: "missing" },
        { description: "Real Place", place_id: "keep" },
      ],
    });
    const t = newT();

    const { suggestions } = await t.action(api.places.autocomplete, {
      query: "place",
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].description).toBe("Real Place");
  });

  test("caps the list at 5 suggestions even when Google returns more", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    stubFetchOk({
      status: "OK",
      predictions: Array.from({ length: 9 }, (_, i) => ({
        description: `Venue ${i}`,
        place_id: `p${i}`,
      })),
    });
    const t = newT();

    const { suggestions } = await t.action(api.places.autocomplete, {
      query: "venue",
    });

    expect(suggestions).toHaveLength(5);
    // The cap is applied to the first N, in order.
    expect(suggestions.map((s) => s.description)).toEqual([
      "Venue 0",
      "Venue 1",
      "Venue 2",
      "Venue 3",
      "Venue 4",
    ]);
  });

  test("trims and URL-encodes the query, and passes the key, into the request URL", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    const fetchMock = stubFetchOk({ status: "OK", predictions: [] });
    const t = newT();

    await t.action(api.places.autocomplete, { query: "  New York  " });

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("input=New%20York");
    expect(url).not.toContain("input=%20%20New");
    expect(url).toContain(`key=${KEY}`);
  });
});
