/**
 * Pure validation for the New Event form's Create button. Extracted from
 * `new.tsx` so the "why is Create grey" question always has a single,
 * unit-testable source of truth — both the disabled predicate AND the
 * one-line reason shown under the button read from this same function
 * (never two places that can drift apart).
 *
 * Root-cause note (the live-blocker this file fixes): the button used to be
 * disabled ONLY on `!selectedId` (no template chosen) with no visible
 * explanation, and template selection was mandatory even for a one-off event
 * planned on the fly. `"blank"` is now a first-class, always-selectable
 * choice (see `BLANK_TEMPLATE_ID` in `new.tsx`) so ad-hoc creation never
 * requires picking a real template — and the reason text below means a dead
 * grey button is never unexplained again.
 */
import { parseDateInput, parseDateTimeInput } from "../../lib/format";

export type CreateFormState = {
  /** A real template id, `"blank"` for the ad-hoc path, or unset. */
  selectedId: string | null;
  /** The name that will actually be submitted (post template-default). */
  effectiveName: string;
  /** Canonical `YYYY-MM-DD`, or `""` if unset. */
  date: string;
  /** Canonical `HH:mm` (24h), or `""` if unset. */
  time: string;
};

/**
 * The first reason Create can't be submitted yet, or `null` once every
 * required field is valid. Mirrors `handleCreate`'s own validation order
 * exactly, so the button's disabled state and its submit-time error can never
 * disagree about what's missing.
 */
export function getCreateBlockReason(state: CreateFormState): string | null {
  if (!state.selectedId) return "Pick a template — or start blank.";
  if (!state.effectiveName.trim()) return "Give the event a name.";
  if (parseDateInput(state.date) === null) {
    return state.date.trim()
      ? "That date isn't valid — check the year, month, and day."
      : "Pick an event date.";
  }
  if (!state.time.trim()) {
    return "Set a start time — the run of show is timed from it.";
  }
  if (parseDateTimeInput(state.date, state.time) === null) {
    return "That start time isn't valid — check the hour and minute.";
  }
  return null;
}
