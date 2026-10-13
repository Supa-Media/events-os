import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  BUILT_IN_ACADEMY_CATALOG,
  buildAcademyCatalog,
  type AcademyCatalog,
} from "@events-os/shared";

/**
 * The Academy as learners see it: the code-defined curriculum with every
 * published in-app course edit laid over it. Built from the same rows the
 * server grades against (`academy.courseEdits` → `buildAcademyCatalog`), so a
 * quiz on screen always matches the one that gets graded.
 *
 * `undefined` while the edits load — screens wait on it the way they wait on
 * `myProgress`, rather than flashing the built-in text and swapping it.
 */
export function useAcademyCatalog(): AcademyCatalog | undefined {
  const edits = useQuery(api.academy.courseEdits);
  return useMemo(() => {
    if (edits === undefined) return undefined;
    return edits.length === 0 ? BUILT_IN_ACADEMY_CATALOG : buildAcademyCatalog(edits);
  }, [edits]);
}
