/**
 * OPEN A MONTH'S PUBLIC PAGE BEFORE IT IS PUBLIC.
 *
 * Mint a short-lived token (`publicLedger.mintLedgerPreviewToken`), then open
 * the REAL public route with it — `/finances/<period>?preview=<token>` — so
 * what you're looking at is the page a stranger will see, rendered from the
 * live books, and not a second rendering that could drift from it.
 *
 * WHY IT'S A HOOK AND NOT A THIRD COPY. This mint-then-`openURL` pattern
 * started on the RSVP draft preview (`TicketingTab.tsx#openPreview`) and was
 * copied to the publish console; the Explain screen is where it would have
 * become a third. The two ledger call sites share a gate, a URL shape, and an
 * error string, so they share this hook instead — the ticketing one is a
 * different route and stays where it is.
 *
 * SCOPE IS OMITTED, NEVER SENT AS NULL. `mintLedgerPreviewToken` takes
 * `v.optional(scopeValidator)`, which accepts the field being ABSENT — an
 * explicit `null` fails argument validation before the handler runs, and the
 * caller sees "Couldn't open the preview" for what is really a malformed
 * call. Both call sites resolve scope to `SingleBookScope | null` (`?scope=`,
 * else the desk, else nothing), so the null case is reachable: a caller with
 * a home chapter but no resolved `ChapterContext` yet. Omitting lets the
 * backend apply its own documented fallback (the caller's home chapter).
 *
 * AND NEVER A GRID WORD. `scopeValidator` is `v.id("chapters") | "central"`;
 * the reconcile grid's `"all"` fails that validation the same uncatchable way
 * (2026-08-13 — the Explain screen passed its raw `?scope=` straight through
 * here). So `scope` is typed `SingleBookScope | null`, not `string | null`:
 * `Id<"chapters">` is a BRANDED string, so a caller that hasn't run its URL
 * param through `resolveBookScope` (`./bookScope`) no longer compiles.
 *
 * PREVIEWING IS NOT PUBLISHING, and the gate says so: the mint only needs
 * ledger-console access and works in every working status — draft, in review,
 * sent back, mid-amendment. Every screen that can read a month's worklist can
 * already mint (`monthCodingWorklist` and the mint run the SAME
 * `requireLedgerConsole`), so a host that shows this button can never be
 * showing one that throws.
 */
import { useState } from "react";
import { Linking } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
// The one canonical resolver for the public-page base URL (branded domain in
// prod, Convex .site fallback elsewhere) — same import the publish console
// used before this hook existed.
import { publicSiteUrl } from "../event/ticketing/helpers";
import type { SingleBookScope } from "./bookScope";

export interface LedgerPreview {
  /** Mint and open. Never throws — failures land in `error`. */
  open: (args: { scope: SingleBookScope | null; periodKey: string }) => Promise<void>;
  /** True only while a mint is in flight, so a host can keep this separate
   *  from whatever else it has busy (a submit, a publish) — looking should
   *  never appear queued behind a commitment. */
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

export function useLedgerPreview(): LedgerPreview {
  const mint = useMutation(api.publicLedger.mintLedgerPreviewToken);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async ({
    scope,
    periodKey,
  }: {
    scope: SingleBookScope | null;
    periodKey: string;
  }) => {
    setLoading(true);
    setError(null);
    try {
      // Built as a ternary, not a spread, and with no `as never`: the two
      // arg shapes are exactly what the mutation declares, so this call site
      // is type-checked against the real validator instead of silenced.
      const { token } = await mint(
        scope ? { scope, periodKey } : { periodKey },
      );
      void Linking.openURL(`${publicSiteUrl()}/finances/${periodKey}?preview=${token}`);
    } catch (e) {
      const data = (e as { data?: { message?: string } })?.data;
      setError(data?.message ?? "Couldn't open the preview. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return { open, loading, error, clearError: () => setError(null) };
}
