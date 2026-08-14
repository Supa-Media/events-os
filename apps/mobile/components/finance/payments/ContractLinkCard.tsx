/**
 * FINANCES · PAYMENTS · "Copy the link and send it to the contractor."
 *
 * THIS CARD IS THE FEATURE. Everything else on the payment screens supports the
 * moment a staffer finishes writing an agreement and has to get it in front of
 * a person who has no account, no app, and no reason to check email — they
 * paste it into whatever thread they already talk to that person in. So the
 * copy is ONE tap, the confirmation is unmistakable, and the URL itself is
 * shown (never hidden behind an icon) because the founder's next move is
 * eyeballing that it's the right one before it leaves.
 *
 * Copying is web-first (`copyToClipboard`) with the native share sheet as the
 * native path — the same split `reimbursements/index.tsx#shareRequestLink`
 * uses, and for the same reason: `expo-clipboard` isn't reachable from this
 * workspace's registry, so native reports failure rather than pretending, and
 * we hand the OS share sheet instead of a silent no-op.
 *
 * When the link genuinely can't be built (see `lib/contractLink.ts` — a
 * chapter with no public slug, or a central desk), the card says so in words
 * instead of rendering a button that would copy a URL that 404s.
 */
import { useState } from "react";
import { Platform, Pressable, Share, Text, View } from "react-native";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { copyToClipboard } from "../../../lib/clipboard";
import type { ContractLinkState } from "../../../lib/contractLink";

type Props = {
  link: ContractLinkState;
  /** `true` while the agreement is still a draft — the link exists but nobody
   *  has been told about it, so the card leads with Send rather than Copy. */
  unsent: boolean;
  /** Mark it sent (and email the contractor when we have an address).
   *  Omitted when the caller can't compose, which hides the button. */
  onSend?: () => void;
  sending?: boolean;
  /** Shown above the link — lets the composer say "Sent. Here's the link" and
   *  the detail screen say "The contractor's link". */
  title?: string;
};

export function ContractLinkCard({
  link,
  unsent,
  onSend,
  sending = false,
  title = "The contractor's link",
}: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!link.url) return;
    if (await copyToClipboard(link.url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
      return;
    }
    // Native (and any web origin without the async clipboard API): hand it to
    // the OS share sheet, which is the same "get this into a text message"
    // gesture by another route.
    if (Platform.OS === "web") {
      if (typeof window !== "undefined") {
        window.prompt("Copy the contractor's link:", link.url);
      }
      return;
    }
    try {
      await Share.share({ message: link.url });
    } catch {
      // Dismissed the share sheet — nothing to do.
    }
  }

  return (
    <View className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-4 py-3.5">
      <View className="flex-row items-center gap-2">
        <Icon name="link" size={15} color={colors.accent} />
        <Text className="flex-1 text-sm font-semibold text-ink">{title}</Text>
        {unsent ? (
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Not sent yet
          </Text>
        ) : null}
      </View>

      {link.url ? (
        <>
          <Pressable
            onPress={() => void handleCopy()}
            accessibilityRole="button"
            accessibilityLabel="Copy the contractor's link"
            className="mt-2.5 rounded-md border border-border bg-raised px-3 py-2 active:opacity-80"
          >
            <Text className="text-xs text-muted" numberOfLines={2}>
              {link.url}
            </Text>
          </Pressable>

          <View className="mt-2.5 flex-row flex-wrap items-center gap-2">
            <Button
              title={copied ? "Copied" : "Copy link"}
              icon={copied ? "check" : "copy"}
              variant={copied ? "secondary" : "primary"}
              size="sm"
              onPress={() => void handleCopy()}
            />
            {onSend ? (
              <Button
                title={unsent ? "Send it" : "Re-send"}
                icon="send"
                variant="secondary"
                size="sm"
                loading={sending}
                onPress={onSend}
              />
            ) : null}
          </View>

          {/* The confirmation is a line of text, not just a button label
              change: on a phone the thumb covers the button it just pressed. */}
          <Text
            className={`mt-2 text-xs ${copied ? "font-semibold text-success" : "text-muted"}`}
          >
            {copied
              ? "Copied — paste it into your text or email to them."
              : unsent
                ? "Sending marks it sent (and emails them if you gave an address). You can copy the link either way."
                : "Paste it into a text or email — it's the contractor's whole side of this agreement."}
          </Text>
        </>
      ) : (
        <Text className="mt-2 text-xs text-muted">{link.reason}</Text>
      )}
    </View>
  );
}
