/**
 * Shared helpers for the Campaigns desk — status → Badge tone, the
 * cross-platform confirm dialog (mirrors `ticketing/helpers.ts#confirmAction`
 * and `TemplatesView`'s `confirmArchiveTemplate`), and small display helpers.
 */
import { Alert, Platform } from "react-native";
import type { BadgeTone } from "../ui";

/** A campaign's lifecycle status, per the `campaigns` contract. */
export type CampaignStatus = "draft" | "sending" | "sent" | "failed";

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Draft",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
};

const STATUS_TONE: Record<CampaignStatus, BadgeTone> = {
  draft: "neutral",
  sending: "warn",
  sent: "success",
  failed: "danger",
};

export function campaignStatusLabel(status: string): string {
  return STATUS_LABEL[status as CampaignStatus] ?? status;
}

export function campaignStatusTone(status: string): BadgeTone {
  return STATUS_TONE[status as CampaignStatus] ?? "neutral";
}

/** Cross-platform confirm: window.confirm on web, Alert.alert on native. */
export function confirmAction({
  title,
  message,
  confirmLabel,
  onConfirm,
  destructive = false,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
}): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: confirmLabel,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}

/** "1 recipient" / "3 recipients". */
export function pluralCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "1 reply" / "3 replies" — `pluralCount` can't handle the irregular plural. */
export function pluralReply(n: number): string {
  return `${n} repl${n === 1 ? "y" : "ies"}`;
}
