/**
 * MentionDataProvider — fetches the @mention suggestion/resolution data
 * (people, org-chart seats, and current seat holders) ONCE for a whole
 * screen, so every mention-aware text cell under it can offer the `@`
 * picker and resolve tokens without each cell (or each grid) re-querying.
 *
 * Cells read it via `useMentionData()`, which returns `null` when no
 * provider is mounted — the signal for a grid cell to fall back to the
 * plain (non-mention) inline editor. This is deliberate: surfaces like the
 * template editor render the same grids but should NOT offer mentions, and
 * they simply don't mount the provider.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";

export interface MentionData {
  people: { _id: string; name: string }[];
  seatHoldings: { personId: string; seatDefId: string }[];
  seatOptions: { seatDefId: string; title: string }[];
}

const MentionDataContext = createContext<MentionData | null>(null);

export function MentionDataProvider({ children }: { children: ReactNode }) {
  const people = useQuery(api.people.list, {});
  const seatOptions = useQuery(api.responsibilities.seatOptions);
  const seatHoldings = useQuery(api.responsibilities.chapterSeatHoldings);

  const value = useMemo<MentionData>(
    () => ({
      people: people ?? [],
      seatHoldings: seatHoldings ?? [],
      seatOptions: seatOptions ?? [],
    }),
    [people, seatHoldings, seatOptions],
  );

  return (
    <MentionDataContext.Provider value={value}>
      {children}
    </MentionDataContext.Provider>
  );
}

/** Mention data from the nearest provider, or `null` when none is mounted. */
export function useMentionData(): MentionData | null {
  return useContext(MentionDataContext);
}
