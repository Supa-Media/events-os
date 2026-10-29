// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `bookScope.test.ts`).
import { describe, expect, test } from "@jest/globals";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  publicationBadge,
  publishBandAction,
  publishConsoleHref,
} from "./publishBandAction";

const BOOK = "k17abcdefghijklmnopqrstuvwx" as Id<"chapters">;

describe("publishBandAction", () => {
  test("a named book and a real month publish IN PLACE — the console's flow, over the grid", () => {
    // THE FOUNDER'S ASK, in one assertion: "I want to be able to preview and
    // publish from the same page." `in_place` is what mounts
    // `PublishMonthModal`, which renders the console's own `PublishMonthBody`
    // — same mutations, same server refusals, no second publish path.
    const action = publishBandAction({
      scope: BOOK,
      periodKey: "2026-03",
      month: { status: "draft" },
    });
    expect(action).toEqual({
      kind: "in_place",
      label: "Publish",
      scope: BOOK,
      periodKey: "2026-03",
    });
  });

  test("central's own book publishes in place too — it is a book like any other", () => {
    // Central is where the org's own money lives; a version of this that only
    // worked for chapters would leave the most-published book on the old
    // round trip.
    const action = publishBandAction({
      scope: "central",
      periodKey: "2026-03",
      month: { status: "in_review" },
    });
    expect(action.kind).toBe("in_place");
    expect(action.kind === "in_place" && action.scope).toBe("central");
  });

  test("THE MERGED ALL-BOOKS QUEUE ROUTES TO THE CONSOLE, where a book is chosen", () => {
    // `scope: null` means this grid is showing several books at once, and
    // `publicLedger` has no notion of publishing "all books" as one month —
    // every entry point takes ONE book. Opening the flow in place would have
    // to pick a book on the reader's behalf, over rows drawn from several.
    const action = publishBandAction({
      scope: null,
      periodKey: "2026-03",
      month: { status: "draft" },
    });
    expect(action.kind).toBe("console");
    // The month still travels, so the console lands ON it rather than on a
    // list of eighteen; the BOOK is the one thing left for the reader to say.
    expect(action.kind === "console" && action.href).toBe(
      "/finances/publish?period=2026-03",
    );
    expect(action.kind === "console" && action.href).not.toContain("scope=");
  });

  test("a month the console said nothing about routes rather than opening an empty flow", () => {
    // `console_` returns a continuous calendar back to the book's earliest
    // transaction, capped at 60 months. A band older than the cap has no row
    // to render a flow from — the console owns the whole calendar, so it takes
    // that case.
    const action = publishBandAction({
      scope: BOOK,
      periodKey: "2019-01",
      month: null,
    });
    expect(action.kind).toBe("console");
    expect(action.label).toBe("Publish");
  });

  test("a band key that is not a month never reaches preview/publish", () => {
    // Unreachable from a `groupBy: "month"` band today. Handled because the
    // in-place body would hand the key straight to `publicLedger.preview` and
    // `publish`, which throw BAD_PERIOD — and the period is dropped from the
    // href rather than forwarded as a param the console would ignore.
    const action = publishBandAction({
      scope: BOOK,
      periodKey: "unattributed",
      month: { status: "draft" },
    });
    expect(action.kind).toBe("console");
    expect(action.kind === "console" && action.href).toBe(
      `/finances/publish?scope=${BOOK}`,
    );
  });

  test("a live month says Amend, not Publish — there is no unpublish", () => {
    // The only thing left to do to a published month is correct it in public
    // (`publicLedger.ts#publish`: "WHY THERE IS NO UNPUBLISH"), and the button
    // says so in both frames.
    for (const scope of [BOOK, null] as const) {
      expect(
        publishBandAction({
          scope,
          periodKey: "2026-03",
          month: { status: "published" },
        }).label,
      ).toBe("Amend");
    }
  });

  test("every working status still reads Publish", () => {
    for (const status of ["draft", "in_review", "changes_requested", "amending"] as const) {
      expect(
        publishBandAction({ scope: BOOK, periodKey: "2026-03", month: { status } })
          .label,
      ).toBe("Publish");
    }
  });
});

describe("publishConsoleHref", () => {
  test("omits what it doesn't know rather than sending it empty", () => {
    // An empty `?scope=` is not "no scope": the console's `resolveBookScope`
    // would treat it as a refused book and print a correction naming a book
    // nobody asked for.
    expect(publishConsoleHref({ scope: null, periodKey: "nonsense" })).toBe(
      "/finances/publish",
    );
  });

  test("carries both when it has both", () => {
    const href = publishConsoleHref({ scope: "central", periodKey: "2025-11" });
    expect(href).toBe("/finances/publish?scope=central&period=2025-11");
  });
});

describe("publicationBadge", () => {
  test("a live month names its revision — 'Published' alone stops being the whole truth", () => {
    expect(publicationBadge({ status: "published", liveRevision: 3 })).toEqual({
      label: "Published · rev 3",
      tone: "success",
    });
  });

  test("published is the ONLY green; work in flight is amber, a send-back is red", () => {
    expect(publicationBadge({ status: "in_review", liveRevision: null }).tone).toBe("warn");
    expect(publicationBadge({ status: "amending", liveRevision: 1 }).tone).toBe("warn");
    expect(publicationBadge({ status: "changes_requested", liveRevision: null }).tone).toBe(
      "danger",
    );
    expect(publicationBadge({ status: "draft", liveRevision: null }).tone).toBe("neutral");
  });

  test("a month with no revision yet says only where it is up to", () => {
    expect(publicationBadge({ status: "draft", liveRevision: null }).label).toBe("Draft");
    // An amending month is LIVE on revision 1 while 2 is prepared — the badge
    // says "Amending" because that is what a publisher needs to act on; the
    // revision that is live is named by the flow itself.
    expect(publicationBadge({ status: "amending", liveRevision: 1 }).label).toBe("Amending");
  });
});
