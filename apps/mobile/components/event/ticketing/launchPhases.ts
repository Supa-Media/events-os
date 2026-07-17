/**
 * The event-page admin as a four-phase LAUNCH JOURNEY. Everything the old flat
 * scroll stacked (page setup, publish, tickets, giving, guests, blasts,
 * check-in, stats) folds into these phases, in the order you actually do them:
 * build the page → publish it → fill the room → run the door. Each phase owns a
 * lifecycle hue (reused from the planning workspace) so the arc reads at a
 * glance: build amber → publish red → grow plum → run green.
 */
import type { IconName } from "../../ui";
import { phaseColors } from "../../../lib/theme";

export type LaunchPhaseKey = "design" | "publish" | "grow" | "run";

export type LaunchPhaseDef = {
  key: LaunchPhaseKey;
  /** Short stepper label. */
  label: string;
  /** The verb line under the label ("the page", "go live"…). */
  tagline: string;
  /** One-line purpose shown on the phase header. */
  purpose: string;
  icon: IconName;
  /** Phase hue { main, soft } drawn from the shared lifecycle palette. */
  hue: { main: string; soft: string };
};

export const LAUNCH_PHASES: LaunchPhaseDef[] = [
  {
    key: "design",
    label: "Design",
    tagline: "the page",
    purpose: "Cover, story, location & what guests can do",
    icon: "edit-3",
    hue: phaseColors.prePlan,
  },
  {
    key: "publish",
    label: "Publish",
    tagline: "go live",
    purpose: "Make the link live and copy it anywhere",
    icon: "globe",
    hue: phaseColors.planning,
  },
  {
    key: "grow",
    label: "Grow",
    tagline: "the guest list",
    purpose: "Send a blast, watch the RSVPs roll in",
    icon: "send",
    hue: phaseColors.dayOf,
  },
  {
    key: "run",
    label: "Run",
    tagline: "the door",
    purpose: "Scan tickets & track the room, day-of",
    icon: "check-circle",
    hue: phaseColors.post,
  },
];

// ── Phase completion + status, derived from the event-page row ───────────────

export type PhaseStatusTone = "phase" | "neutral" | "good";

/** The slice of the eventPages row the launch flow reads to gauge progress. */
export type LaunchPageStats = {
  tagline?: string | null;
  venueName?: string | null;
  published: boolean;
  goingCount: number;
  maybeCount: number;
};

export type LaunchPhaseState = {
  /** Phases whose work is "done" — drives the stepper's ✓ markers. */
  doneKeys: Set<LaunchPhaseKey>;
  /** The header status chip for each phase. */
  status: Record<LaunchPhaseKey, { label: string; tone: PhaseStatusTone }>;
};

/**
 * Reduce a page row to per-phase completion + status chips:
 * - Design is done once it has the essentials (a tagline AND a venue).
 * - Publish is done once the page is live.
 * - Grow is done once anyone has RSVP'd going/maybe.
 * - Run has no "done" — it's the day-of surface — so it only carries a chip.
 */
export function launchPhaseState(p: LaunchPageStats): LaunchPhaseState {
  const guests = p.goingCount + p.maybeCount;
  const designDone = !!(p.tagline?.trim() && p.venueName?.trim());
  const publishDone = p.published;
  const growDone = guests > 0;

  const doneKeys = new Set<LaunchPhaseKey>();
  if (designDone) doneKeys.add("design");
  if (publishDone) doneKeys.add("publish");
  if (growDone) doneKeys.add("grow");

  return {
    doneKeys,
    status: {
      design: designDone
        ? { label: "Ready", tone: "good" }
        : { label: "In progress", tone: "phase" },
      publish: publishDone
        ? { label: "Live now", tone: "good" }
        : { label: "Draft · not live", tone: "neutral" },
      grow: growDone
        ? { label: `${guests} guest${guests === 1 ? "" : "s"}`, tone: "good" }
        : { label: "0 guests", tone: "neutral" },
      run:
        p.goingCount > 0
          ? { label: `${p.goingCount} going`, tone: "neutral" }
          : { label: "Door tools", tone: "neutral" },
    },
  };
}

/**
 * Which phase to open by default — the first thing left to do. Used only until
 * the user touches the accordion. Falls back to Design when everything's done.
 */
export function defaultOpenPhase(doneKeys: Set<LaunchPhaseKey>): LaunchPhaseKey {
  if (!doneKeys.has("design")) return "design";
  if (!doneKeys.has("publish")) return "publish";
  if (!doneKeys.has("grow")) return "grow";
  return "design";
}
