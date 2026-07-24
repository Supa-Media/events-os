/**
 * The `emailReplies` row shape (`apps/convex/schema/campaigns.ts`), the rows
 * `campaigns.getReplies` returns. Kept as an explicit named type (rather
 * than `FunctionReturnType<typeof api.campaigns.getReplies>[number]` inline
 * at every use) because both `RepliesView` and `CampaignRepliesSection`
 * share it for props/helpers.
 */
import type { Id } from "@events-os/convex/_generated/dataModel";

export type EmailReply = {
  _id: Id<"emailReplies">;
  _creationTime: number;
  campaignId?: Id<"campaigns">;
  fromEmail: string;
  fromName?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  receivedAt: number;
  read?: boolean;
};
