import { Text, View } from "react-native";
import {
  CARD_STATUSES,
  CARD_TYPES,
  RECEIPT_GRACE_DAYS,
} from "@events-os/shared";
import { Card, Icon, Pill } from "../../ui";
import { colors } from "../../../lib/theme";

/** Capitalize a lowercase enum member for display ("virtual" → "Virtual"). */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The prototype's "Card philosophy" pair, verbatim in spirit: cards are
 * person-owned (not budget-scoped), everyone owns their own receipts, and the
 * only two hard controls are a monthly safety cap + a validity window. Plus the
 * "personal charge? pay it back" explainer. All static copy — no data.
 */
export function CardPhilosophy() {
  return (
    <View className="gap-4">
      <View className="flex-row flex-wrap gap-4">
        {/* One card per person */}
        <View className="min-w-[280px] flex-1">
          <Card>
            <View className="gap-3">
              <View className="flex-row items-center gap-2">
                <Icon name="credit-card" size={16} color={colors.accent} />
                <Text className="font-semibold text-ink">
                  One card per person — you own it
                </Text>
              </View>
              <View className="flex-row flex-wrap gap-2">
                <Pill label="Everyone gets a card" />
                <Pill label="No budget scoping" />
                <Pill label="You keep your own receipts" />
                <Pill label={`Auto-lock at ${RECEIPT_GRACE_DAYS} days late`} />
              </View>
              <Text className="text-xs text-muted">
                Cards aren't tied to a budget line — they're tied to a{" "}
                <Text className="font-semibold text-ink">person</Text>, so
                someone is always on the hook for every charge's receipt and
                coding. The only two hard controls are a{" "}
                <Text className="font-semibold text-ink">monthly safety cap</Text>{" "}
                and a{" "}
                <Text className="font-semibold text-ink">validity window</Text>;
                anything off-pattern is caught in reconciliation, not by the
                card.
              </Text>
              <Text className="text-xs text-faint">
                Issued as {CARD_TYPES.map(cap).join(" or ")} cards on the
                chapter's Increase account.
              </Text>
            </View>
          </Card>
        </View>

        {/* Personal charge? Pay it back */}
        <View className="min-w-[280px] flex-1">
          <Card>
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <Icon name="refresh-cw" size={16} color={colors.accent} />
                <Text className="font-semibold text-ink">
                  Personal charge? Pay it back
                </Text>
              </View>
              <Text className="text-xs text-muted">
                Used the Public Worship card for a personal expense by mistake? Flag it
                and repay in one tap — from your own{" "}
                <Text className="font-semibold text-ink">debit card</Text> or{" "}
                <Text className="font-semibold text-ink">bank (ACH)</Text>. The
                repayment posts as an offsetting credit (a transfer), so the
                books stay clean with no reimbursement paperwork.
              </Text>
            </View>
          </Card>
        </View>
      </View>

      {/* Card states legend (from the shared CARD_STATUSES enum). */}
      <Text className="text-xs text-faint">
        Card states: {CARD_STATUSES.map(cap).join(" · ")}.
      </Text>
    </View>
  );
}
