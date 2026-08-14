/**
 * FINANCES · PAYMENTS · What the public will read.
 *
 * The service description on a contractor agreement is not a note — it is a
 * sentence that publishes VERBATIM and PERMANENTLY on the chapter's public
 * ledger. Someone typing into a box labelled "what was the work?" has no way
 * of knowing that unless the screen shows them, so this renders the actual row
 * as they type it.
 *
 * TWO THINGS THIS CARD EXISTS TO SAY:
 *
 *  1. The counterparty is `CONTRACTOR_LEDGER_COUNTERPARTY` — "Contractor
 *     payment" — and NOT the payee's name. That's a founder decision
 *     (2026-08-14) and the conservative side of a one-way door: publishing a
 *     name later is possible, un-publishing one is not. Composers routinely
 *     assume the opposite, so the preview shows the real, name-free row rather
 *     than letting them find out after the month publishes.
 *  2. Personal details don't belong in it. `publicTextProblems` — the SAME
 *     check the server throws on (`assertPublicDescription`) and the same one
 *     the public page shows inline — runs on every keystroke, so a phone
 *     number in the description is caught while it's still a draft instead of
 *     after a round-trip.
 */
import { Text, View } from "react-native";
import {
  CONTRACTOR_LEDGER_COUNTERPARTY,
  CONTRACTOR_SERVICE_DESCRIPTION_MAX,
  formatCents,
  publicTextProblems,
} from "@events-os/shared";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";

type Props = {
  serviceDescription: string;
  amountCents: number;
  /** The service date when set; the row falls back to "when it's paid". */
  serviceDate: number | null;
};

export function LedgerPreviewCard({
  serviceDescription,
  amountCents,
  serviceDate,
}: Props) {
  const text = serviceDescription.trim();
  const problems = publicTextProblems(text);
  const over = text.length > CONTRACTOR_SERVICE_DESCRIPTION_MAX;

  return (
    <View className="mb-3 rounded-lg border border-border bg-sunken px-4 py-3.5">
      <View className="flex-row items-center gap-2">
        <Icon name="eye" size={14} color={colors.muted} />
        <Text className="flex-1 text-sm font-semibold text-ink">
          On the public ledger
        </Text>
      </View>
      <Text className="mt-1 text-xs text-muted">
        This is the row anyone will be able to read, word for word and forever.
        The contractor&apos;s name is deliberately not published.
      </Text>

      {/* The row itself, laid out the way the published ledger lays it out. */}
      <View className="mt-3 rounded-md border border-border bg-raised px-3 py-2.5">
        <View className="flex-row items-start gap-3">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink">
              {CONTRACTOR_LEDGER_COUNTERPARTY}
            </Text>
            <Text
              className={`mt-0.5 text-xs ${text ? "text-muted" : "italic text-faint"}`}
            >
              {text || "…what the work was goes here"}
            </Text>
          </View>
          <View className="items-end">
            <Text
              className="text-sm font-semibold text-ink"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {formatCents(amountCents)}
            </Text>
            <Text className="mt-0.5 text-2xs text-faint">
              {serviceDate != null ? formatDate(serviceDate) : "date it's paid"}
            </Text>
          </View>
        </View>
      </View>

      {/* Length: the server truncates at the shared max, so say it here. */}
      <Text
        className={`mt-2 text-2xs ${over ? "font-semibold text-danger" : "text-faint"}`}
      >
        {text.length} / {CONTRACTOR_SERVICE_DESCRIPTION_MAX} characters
        {over ? " — the rest will be cut off" : ""}
      </Text>

      {problems.map((p) => (
        <View key={p} className="mt-2 flex-row items-start gap-2">
          <Icon name="alert-triangle" size={13} color={colors.warn} />
          <Text className="flex-1 text-xs text-warn">
            {p} This publishes publicly — please reword it without personal
            details.
          </Text>
        </View>
      ))}
    </View>
  );
}
