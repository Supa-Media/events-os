import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import {
  BUILT_IN_ACADEMY_CATALOG,
  courseEditFromCatalog,
  type AcademyCatalog,
  type CourseEdit,
} from "@events-os/shared";
import { useAcademyCatalog } from "../../../lib/useAcademyCatalog";
import { errorMessage } from "../../../lib/errors";

type EditorState = FunctionReturnType<typeof api.academyEditor.courseEditor>;

export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

/** How long typing pauses before the draft saves. */
const AUTOSAVE_MS = 700;

/**
 * One course's shared draft, as the editor screens work on it.
 *
 * The draft lives on the server (`academyEditor.saveDraft`) and AUTOSAVES a
 * moment after each change, so closing the screen never loses work and the
 * course editor and lesson editor — two screens — always agree. Local state is
 * the working copy; it reloads from the server whenever the server's draft
 * changes for a reason other than our own save (the other editor screen,
 * another editor, a publish, a discard, a restore) and nothing local is
 * waiting to be saved.
 *
 * `edit` is what the screens render: the draft if there is one, else the
 * course exactly as learners see it now.
 */
export function useCourseDraft(courseSlug: string) {
  const state = useQuery(api.academyEditor.courseEditor, { courseSlug });
  const catalog = useAcademyCatalog();
  const saveDraft = useMutation(api.academyEditor.saveDraft);

  const [edit, setEdit] = useState<CourseEdit | null>(null);
  const [isReset, setIsReset] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const editRef = useRef<CourseEdit | null>(null);
  const basedOn = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const lastSavedAt = useRef<number | null>(null);
  const loadedStamp = useRef<string | null>(null);
  const loadedCatalog = useRef<AcademyCatalog | null>(null);

  // Load (or reload) the working copy from the server's state.
  useEffect(() => {
    if (!state || !catalog) return;
    const stamp = `${state.draft?.updatedAt ?? "none"}:${state.currentVersion}`;
    // With no draft the working copy IS the live catalog, which can arrive a
    // beat after the editor state does (just after a publish) — follow it.
    const catalogMoved = !state.draft && catalog !== loadedCatalog.current;
    if (stamp === loadedStamp.current && !catalogMoved) return;
    if (timer.current || inFlight.current) return; // our own change is pending
    if (
      loadedStamp.current !== null &&
      state.draft?.updatedAt != null &&
      state.draft.updatedAt === lastSavedAt.current
    ) {
      loadedStamp.current = stamp; // the echo of our own save
      return;
    }
    loadedStamp.current = stamp;
    loadedCatalog.current = catalog;
    const next = workingCopy(state, catalog, courseSlug);
    editRef.current = next.edit;
    basedOn.current = next.basedOn;
    setEdit(next.edit);
    setIsReset(next.isReset);
    setSaveState(state.draft ? "saved" : "idle");
  }, [state, catalog, courseSlug]);

  const saveNow = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const current = editRef.current;
    if (!current) return;
    setSaveState("saving");
    const p = saveDraft({ courseSlug, edit: current, basedOnVersion: basedOn.current })
      .then((r) => {
        lastSavedAt.current = r.updatedAt;
        setSaveError(null);
        // A change made while this save was in flight schedules its own save.
        setSaveState(timer.current ? "pending" : "saved");
      })
      .catch((err: unknown) => {
        setSaveError(errorMessage(err));
        setSaveState("error");
      })
      .finally(() => {
        if (inFlight.current === p) inFlight.current = null;
      });
    inFlight.current = p;
    await p;
  }, [courseSlug, saveDraft]);

  /** Apply a change to the working copy and schedule the autosave. */
  const update = useCallback(
    (fn: (prev: CourseEdit) => CourseEdit) => {
      const prev = editRef.current;
      if (!prev) return;
      const next = fn(prev);
      editRef.current = next;
      setEdit(next);
      setIsReset(false);
      setSaveState("pending");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void saveNow();
      }, AUTOSAVE_MS);
    },
    [saveNow],
  );

  /** Save anything pending right now (before navigating or publishing). */
  const flush = useCallback(async () => {
    if (timer.current) await saveNow();
    else if (inFlight.current) await inFlight.current;
  }, [saveNow]);

  /** Drop any pending local change (before a discard or restore). */
  const cancelPending = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // Never lose a pending change to a screen closing.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        const current = editRef.current;
        if (current) {
          void saveDraft({ courseSlug, edit: current, basedOnVersion: basedOn.current });
        }
      }
    },
    [courseSlug, saveDraft],
  );

  return {
    state,
    catalog,
    edit,
    /** The draft puts the course back to its built-in version. */
    isReset,
    /** There is a draft (saved, or about to be). */
    hasDraft: state?.draft != null || saveState === "pending" || saveState === "saving",
    saveState,
    saveError,
    update,
    flush,
    cancelPending,
  };
}

function workingCopy(
  state: EditorState,
  catalog: AcademyCatalog,
  courseSlug: string,
): { edit: CourseEdit | null; basedOn: number; isReset: boolean } {
  if (state.draft) {
    if (state.draft.edit) {
      return { edit: state.draft.edit, basedOn: state.draft.basedOnVersion, isReset: false };
    }
    // A "back to built-in" draft: show the built-in course.
    return {
      edit: courseEditFromCatalog(BUILT_IN_ACADEMY_CATALOG, courseSlug, null),
      basedOn: state.draft.basedOnVersion,
      isReset: true,
    };
  }
  return {
    edit: courseEditFromCatalog(catalog, courseSlug, state.published?.edit ?? null),
    basedOn: state.currentVersion,
    isReset: false,
  };
}
