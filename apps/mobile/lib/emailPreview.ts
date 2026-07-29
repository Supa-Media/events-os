/**
 * TIPTAP PREVIEW WRAPPER — the client half of the contract in
 * `packages/shared/src/emailDocFormat.ts`:
 *
 *   api.emailPreview.renderCampaignPreview({ campaignId }) → { html, text }
 *
 * `apps/convex/emailPreview.ts` (WS2b) is the server side of this contract —
 * a real action on the generated `api` object, called the same way every
 * other action in this app is (`CampaignStatusCard.tsx`'s `sendTest` is the
 * precedent).
 */
import type { ConvexReactClient } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";

export type CampaignPreviewResult = { html: string; text: string };

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
  return client.action(api.emailPreview.renderCampaignPreview, { campaignId });
}
