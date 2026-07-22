/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  MAX_PLANNING_DOC_CHARS,
  serializeEventPlan,
  stripMentionTokens,
  type PlanItem,
  type PlanModule,
  type PlanOverview,
} from "../lib/eventPlanSerializer";
import { encodeMention } from "@events-os/shared";

/**
 * `serializeEventPlan` — the pure event-plan → prompt-document serializer
 * behind `autofillEventPage`. Characterizes:
 *   - overview first, then one section per module WITH rows (in module order),
 *   - item detail/notes text (and other labeled fields) surfaces per row,
 *   - `@[Label](mention:...)` tokens flatten to their plain label,
 *   - the output never exceeds the cap, and truncation is fair — a huge
 *     section can't evict a small one.
 */

const OVERVIEW: PlanOverview = {
  name: "Rooftop Worship Night",
  eventDate: Date.UTC(2026, 7, 14),
  location: "Downtown rooftop",
  venueName: "The Chapel Roof",
  address: "123 Main St, Austin TX",
  budgetUsd: 500,
  tagline: null,
  description: null,
  givingPrompt: "Keep worship free",
};

const MODULES: PlanModule[] = [
  { key: "planning_doc", label: "Tasks" },
  { key: "comms", label: "Comms Schedule" },
  { key: "run_of_show", label: "Run of Show" },
];

describe("serializeEventPlan", () => {
  test("overview section first; one section per module with rows, none for empty modules", async () => {
    const items: PlanItem[] = [
      {
        module: "planning_doc",
        title: "Plan lawn games",
        status: "in_progress",
        fields: { details: "cornhole and giant Jenga", notes: "borrow sets" },
      },
      {
        module: "comms",
        title: "IG announcement",
        status: null,
        fields: { channel: ["ig_post", "ig_stories"] },
      },
    ];
    const doc = serializeEventPlan({ overview: OVERVIEW, modules: MODULES, items });

    // Overview leads with the event grounding + current copy.
    expect(doc.startsWith("## Event overview")).toBe(true);
    expect(doc).toContain("Event: Rooftop Worship Night");
    expect(doc).toContain("Venue: The Chapel Roof");
    expect(doc).toContain("Budget: $500");
    expect(doc).toContain("Current tagline: (none)");
    expect(doc).toContain("Current giving prompt: Keep worship free");

    // Module sections in order, with their rows' labeled fields.
    expect(doc).toContain("## Tasks");
    expect(doc).toContain("- Plan lawn games [in_progress]");
    expect(doc).toContain("Details: cornhole and giant Jenga");
    expect(doc).toContain("Notes: borrow sets");
    expect(doc).toContain("## Comms Schedule");
    expect(doc).toContain("Channel: ig_post, ig_stories");
    expect(doc.indexOf("## Tasks")).toBeLessThan(doc.indexOf("## Comms Schedule"));
    // Run of Show has no rows → no section at all.
    expect(doc).not.toContain("## Run of Show");
  });

  test("mention tokens are stripped to their plain labels", async () => {
    const mention = encodeMention("person", "p123", "Jordan Lee");
    const items: PlanItem[] = [
      {
        module: "planning_doc",
        title: `Ask ${mention} about sound`,
        status: null,
        fields: { notes: `Waiting on ${mention} to confirm` },
      },
    ];
    const doc = serializeEventPlan({ overview: OVERVIEW, modules: MODULES, items });

    expect(doc).toContain("Ask Jordan Lee about sound");
    expect(doc).toContain("Waiting on Jordan Lee to confirm");
    expect(doc).not.toContain("mention:");
    expect(doc).not.toContain("@[");
  });

  test("caps the total at maxChars, truncating fairly across sections", async () => {
    // One huge Tasks section, one small Comms section.
    const items: PlanItem[] = [
      {
        module: "planning_doc",
        title: "Giant task",
        status: null,
        fields: { details: "x".repeat(5_000) },
      },
      {
        module: "comms",
        title: "Tiny comm",
        status: null,
        fields: { notes: "short note" },
      },
    ];
    const maxChars = 1_000;
    const doc = serializeEventPlan({
      overview: OVERVIEW,
      modules: MODULES,
      items,
      maxChars,
    });

    expect(doc.length).toBeLessThanOrEqual(maxChars);
    // The overview is always kept whole…
    expect(doc).toContain("Event: Rooftop Worship Night");
    expect(doc).toContain("Current giving prompt: Keep worship free");
    // …the small section survives intact (fair share — the huge one can't
    // evict it), and the huge one is marked truncated.
    expect(doc).toContain("short note");
    expect(doc).toContain("…(truncated)");
  });

  test("default cap is MAX_PLANNING_DOC_CHARS", async () => {
    const items: PlanItem[] = [
      {
        module: "planning_doc",
        title: "Giant task",
        status: null,
        fields: { details: "y".repeat(MAX_PLANNING_DOC_CHARS * 2) },
      },
    ];
    const doc = serializeEventPlan({ overview: OVERVIEW, modules: MODULES, items });
    expect(doc.length).toBeLessThanOrEqual(MAX_PLANNING_DOC_CHARS);
  });

  test("no rows at all → the overview alone is still a valid document", async () => {
    const doc = serializeEventPlan({
      overview: OVERVIEW,
      modules: MODULES,
      items: [],
    });
    expect(doc.startsWith("## Event overview")).toBe(true);
    expect(doc).not.toContain("## Tasks");
  });
});

describe("stripMentionTokens", () => {
  test("plain text passes through unchanged", () => {
    expect(stripMentionTokens("no mentions here")).toBe("no mentions here");
  });

  test("multiple tokens flatten to labels in place", () => {
    const a = encodeMention("person", "p1", "Ana");
    const b = encodeMention("seat", "s1", "Event Lead");
    expect(stripMentionTokens(`${a} hands off to ${b}.`)).toBe(
      "Ana hands off to Event Lead.",
    );
  });
});
