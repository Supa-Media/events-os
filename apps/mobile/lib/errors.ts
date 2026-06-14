import { ConvexError } from "convex/values";

/**
 * Surface a human-readable message from a thrown error. ConvexError payloads
 * (the app throws `{ code, message }`) are unwrapped so the user sees the real
 * reason; falls back to the provided default otherwise.
 */
export function errorMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | undefined;
    if (data?.message) return data.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
