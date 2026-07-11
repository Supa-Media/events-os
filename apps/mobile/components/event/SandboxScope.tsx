import { createContext, useContext } from "react";

/**
 * TRAINING-SANDBOX scope. The event screen provides the event's id here when
 * the event is an Academy training sandbox (`isTraining`); anything rendered
 * inside — role pickers, grid person cells, the crew tab — reads it to scope
 * people pickers down to the learner + placeholder people (the sample bench).
 * The actual filtering is enforced SERVER-SIDE (people.list / teamMembers
 * take the eventId); this context only carries the id to the pickers.
 *
 * Null (the default) means "not a sandbox" — normal rosters everywhere.
 */
const SandboxContext = createContext<string | null>(null);

/** Wrap an event screen's body: value = eventId when isTraining, else null. */
export const SandboxScope = SandboxContext.Provider;

/** The surrounding training event's id, or null outside a sandbox. */
export function useSandboxEventId(): string | null {
  return useContext(SandboxContext);
}
