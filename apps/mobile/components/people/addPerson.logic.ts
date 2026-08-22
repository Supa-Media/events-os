import type { CreatePersonArgs } from "./addPersonForm.logic";

/**
 * What "Add person" should do with the roster-create mutation's outcome:
 * hand back the new person's id so the caller opens its detail sheet
 * immediately, or hand back the caught error so the caller can surface it —
 * never let a rejection go unhandled. (See #783 — before this existed,
 * `handleAddRow` neither opened anything on success nor caught anything on
 * failure, so every click looked like a no-op.)
 *
 * The Add Person modal (`AddPersonModal.tsx`) builds the full `create` args
 * itself (`addPersonForm.logic.ts#buildAddPersonArgs`) and hands them
 * straight through here — this function no longer defaults a bare name.
 */
export async function addPersonAndGetOpenId(
  create: (args: CreatePersonArgs) => Promise<string>,
  args: CreatePersonArgs,
): Promise<{ id: string; error?: undefined } | { id?: undefined; error: unknown }> {
  try {
    const id = await create(args);
    return { id };
  } catch (error) {
    return { error };
  }
}
