/**
 * What "Add person" should do with the roster-create mutation's outcome:
 * hand back the new person's id so the caller opens its detail sheet
 * immediately, or hand back the caught error so the caller can surface it —
 * never let a rejection go unhandled. (See #783 — before this existed,
 * `handleAddRow` neither opened anything on success nor caught anything on
 * failure, so every click looked like a no-op.)
 */
export async function addPersonAndGetOpenId(
  create: (args: { name: string }) => Promise<string>,
  name = "New person",
): Promise<{ id: string; error?: undefined } | { id?: undefined; error: unknown }> {
  try {
    const id = await create({ name });
    return { id };
  } catch (error) {
    return { error };
  }
}
