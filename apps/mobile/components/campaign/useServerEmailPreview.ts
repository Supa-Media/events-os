/**
 * SERVER-RENDERED TIPTAP PREVIEW — one hook, so the reviewer's preview
 * (`CampaignStatusCard.tsx#ReviewEmailPreview`) and the templates library's
 * thumbnail (`CampaignTemplatesView.tsx#TemplatePreview`) can't drift into
 * two different loading/error treatments for the same
 * `api.emailPreview.renderCampaignPreview` call.
 *
 * Mirrors the fetch/loading/error shape `MailyDocumentHost.native.tsx`
 * already established for the composer's own read-only preview — same
 * `fetchCampaignPreview` wrapper (`lib/emailPreview.ts`), same three-state
 * result. `campaignId` doubles as a template's row id: templates are
 * `kind: "template"` rows in the same `campaigns` table
 * (`apps/convex/campaignTemplates.ts`'s module doc), and
 * `renderCampaignPreview` explicitly works on both kinds.
 *
 * This is a review/compliance surface, not an approximation: the server
 * action injects the same footer/postal address and dark-mode meta a real
 * send would carry, so what this renders is what actually sends — a
 * client-side re-implementation would not be able to promise that.
 */
import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { fetchCampaignPreview } from "../../lib/emailPreview";

export type ServerEmailPreviewState =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "unavailable" };

/**
 * Fetches the server-rendered HTML for a tiptap-format `campaigns` row
 * (email or template). Pass `enabled: false` to skip the fetch entirely
 * (e.g. the row isn't tiptap-format, so the caller renders the legacy
 * client-side path instead) — the hook still runs (Rules of Hooks), it just
 * never calls out and stays in `"loading"`.
 */
export function useServerEmailPreview(
  campaignId: Id<"campaigns">,
  enabled: boolean,
): ServerEmailPreviewState {
  const convex = useConvex();
  const [state, setState] = useState<ServerEmailPreviewState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: "loading" });
    fetchCampaignPreview(convex, campaignId)
      .then((result) => {
        if (!cancelled) setState({ status: "ready", html: result.html });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [convex, campaignId, enabled]);

  return state;
}
