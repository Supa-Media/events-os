/**
 * TIPTAP PREVIEW WRAPPER — the client half of the contract in
 * `packages/shared/src/emailDocFormat.ts`:
 *
 *   api.emailPreview.renderCampaignPreview({ campaignId }) → { html, text }
 *
 * TODO(WS2b): `apps/convex/emailPreview.ts` does not exist yet — this is the
 * ONLY function in the mobile app that reaches for it. `api.emailPreview` is
 * therefore not a real key on the generated `api` object today, so this file
 * routes the call through an `unknown`-typed escape hatch (`callAction`)
 * rather than `useAction(api.emailPreview.renderCampaignPreview)`, which
 * would fail `tsc` immediately (no such property). The moment
 * `apps/convex/emailPreview.ts` lands, delete `callAction` and the cast
 * inside it and call `useAction(api.emailPreview.renderCampaignPreview)`
 * directly like every other action in this app (`CampaignStatusCard.tsx`'s
 * `sendTest` is the precedent) — `fetchCampaignPreview`'s own signature
 * already matches the contract exactly, so nothing downstream
 * (`MailyDocumentHost.web.tsx` / `.native.tsx`) needs to change.
 *
 * Until then, calling this throws (Convex has no `emailPreview` module to
 * resolve the action against) — both hosts catch that and show a quiet
 * "preview isn't available yet" state instead of a live preview, per the
 * plan's own instruction not to pretend a preview that can't render is live.
 */
import type { ConvexReactClient } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";

export type CampaignPreviewResult = { html: string; text: string };

/** `unknown`-typed until WS2b — see the file doc. */
function callAction(
  client: ConvexReactClient,
  campaignId: Id<"campaigns">,
): Promise<CampaignPreviewResult> {
  const anyApi = api as unknown as {
    emailPreview?: { renderCampaignPreview?: unknown };
  };
  const ref = anyApi.emailPreview?.renderCampaignPreview;
  if (!ref) {
    return Promise.reject(
      new Error("emailPreview.renderCampaignPreview isn't deployed yet (TODO(WS2b))."),
    );
  }
  return client.action(ref as FunctionReference<"action">, { campaignId });
}

/**
 * Fetch the server-rendered preview for a tiptap-format campaign. Rejects
 * (never a "friendly" empty result) so callers can distinguish "not
 * available yet" from "rendered, and it's blank" — the two need different
 * copy on screen.
 */
export function fetchCampaignPreview(
  client: ConvexReactClient,
  campaignId: Id<"campaigns">,
): Promise<CampaignPreviewResult> {
  return callAction(client, campaignId);
}
