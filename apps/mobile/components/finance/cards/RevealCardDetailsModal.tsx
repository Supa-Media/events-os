/**
 * The reveal modal for `api.cards.revealCardDetails` (WP-C.3) — the manual
 * add-to-wallet path. Shows the PAN/expiry/CVC Increase just returned, in
 * memory ONLY (this component receives `details` as a prop from the parent's
 * `useState`, never a query — nothing sensitive is ever persisted anywhere,
 * see `cards.ts`'s `revealCardDetails` doc comment for the full chain of
 * custody). Auto-hides after 60s so a forgotten-open screen doesn't leave the
 * card number on display indefinitely; the countdown is visible so the holder
 * isn't surprised mid-copy. Each value (PAN / expiry / CVC) has its own
 * `CopyButton` (`components/ui`, the same web Clipboard API used elsewhere in
 * the app — no new dependency) so the holder can grab exactly what they need.
 *
 * Native push provisioning (a one-tap "Add to Apple Wallet" button) is
 * EXPLICITLY DEFERRED — it needs the Apple PassKit entitlement (out of scope
 * for WP-C.3). This modal is the day-one path: the holder reads the number
 * off the screen and types it into their phone's Wallet app themselves.
 */
import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { CopyButton, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

const AUTO_HIDE_SECONDS = 60;

export type RevealedCardDetails = {
  primaryAccountNumber: string;
  expirationMonth: number;
  expirationYear: number;
  verificationCode: string;
};

/** "4242424242424242" → "4242 4242 4242 4242". */
function formatPan(pan: string): string {
  return (pan.match(/.{1,4}/g) ?? [pan]).join(" ");
}

/** (8, 2029) → "08/29". */
function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${String(year).slice(-2)}`;
}

export function RevealCardDetailsModal({
  details,
  onClose,
}: {
  details: RevealedCardDetails | null;
  onClose: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_HIDE_SECONDS);

  // Reset + tick the countdown while the modal is open; auto-hide at zero.
  useEffect(() => {
    if (!details) return;
    setSecondsLeft(AUTO_HIDE_SECONDS);
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval);
          onClose();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm only when a NEW reveal opens
  }, [details]);

  if (!details) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">
              Card details
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="gap-4 px-5 py-5">
            <View className="gap-1">
              <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
                Card number
              </Text>
              <View className="flex-row items-center gap-2">
                <Text
                  className="font-display text-xl text-ink"
                  style={{ fontVariant: ["tabular-nums"] }}
                  selectable
                >
                  {formatPan(details.primaryAccountNumber)}
                </Text>
                <CopyButton text={details.primaryAccountNumber} />
              </View>
            </View>

            <View className="flex-row gap-6">
              <View className="gap-1">
                <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Expiry
                </Text>
                <View className="flex-row items-center gap-2">
                  <Text
                    className="text-lg text-ink"
                    style={{ fontVariant: ["tabular-nums"] }}
                    selectable
                  >
                    {formatExpiry(details.expirationMonth, details.expirationYear)}
                  </Text>
                  <CopyButton
                    text={formatExpiry(details.expirationMonth, details.expirationYear)}
                  />
                </View>
              </View>
              <View className="gap-1">
                <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
                  CVC
                </Text>
                <View className="flex-row items-center gap-2">
                  <Text
                    className="text-lg text-ink"
                    style={{ fontVariant: ["tabular-nums"] }}
                    selectable
                  >
                    {details.verificationCode}
                  </Text>
                  <CopyButton text={details.verificationCode} />
                </View>
              </View>
            </View>

            <View className="rounded-md border border-border bg-sunken px-3 py-2">
              <Text className="text-xs text-muted">
                Add these in your phone's Wallet app (Apple Wallet or Google
                Wallet) — open Wallet, tap add a card, and enter the number
                above. This screen hides itself in {secondsLeft}s.
              </Text>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
