/**
 * FINANCES · PAYMENTS · "Paid someone before?" — the composer's roster picker.
 *
 * The founder's ask, in her words: "an autofill, like hey it's this person."
 * A contractor we have already paid has a durable profile — a name, an email, a
 * phone, a tax form, a bank account — and asking a staffer to re-type the first
 * three while asking the CONTRACTOR to re-file the last two is the friction
 * this removes.
 *
 * WHAT IT FILLS, AND WHAT IT REFUSES TO. Identity only:
 * `contractorIdentityPatch` returns the name, the email and the phone, and the
 * unit test asserts it can never grow a fourth key. The amount, the service
 * description and the service date stay EMPTY, because they are this job's
 * terms rather than this person's facts — the description publishes verbatim
 * and permanently on the public ledger, and an amount that arrives pre-filled
 * is an amount nobody decided. The one concession is `usualRateUsd`, rendered
 * here as a HINT somebody has to press. Pressing it is a decision; a filled
 * field is not.
 *
 * WHAT IT SAYS OUT LOUD. Under the picked contractor, what the org already
 * holds — "W-9 on file since Mar 14, 2026 · account ending 6789 — they won't be
 * asked again" — because the whole value of the roster is invisible otherwise,
 * and a staffer who doesn't know the form is on file will apologise to the
 * contractor for asking again. When the form has LAPSED (a W-8 has a life; a
 * W-9 doesn't) the card says so in the server's own words and says they'll be
 * asked for a new one. It never blocks the payment: being asked for a current
 * form is the normal path through their link, not an error.
 *
 * It renders nothing at all when the roster is empty or unreadable — the first
 * contractor a chapter ever pays should not be greeted by an empty picker.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Badge, Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  filterContractors,
  lastPaidLine,
  onFileShortLine,
  onFileSummary,
  taxClassificationLabel,
  taxClassificationMissing,
  usualRateHint,
  type ContractorOnFile,
  type ContractorRosterRow,
} from "./contractorHelpers";

type Props = {
  /** The roster rows, or `undefined` while the read is in flight. */
  contractors: readonly ContractorRosterRow[] | undefined;
  /** What's on file for the currently picked person (`undefined` = none picked
   *  or still loading). */
  onFile: ContractorOnFile | undefined;
  /** True once a person is picked — held by the composer, since it is what
   *  goes to `createAgreement` as `personId`. */
  picked: boolean;
  onPick: (row: ContractorRosterRow) => void;
  onClear: () => void;
  /** Press-through for the usual-rate hint. The composer writes it into the
   *  Amount field; this component never does. */
  onUseUsualRate: (amountText: string) => void;
};

export function ContractorPicker({
  contractors,
  onFile,
  picked,
  onPick,
  onClear,
  onUseUsualRate,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Nothing to offer yet: a chapter's first contractor, or a caller whose
  // roster read was refused. Either way the composer is unchanged rather than
  // carrying a dead affordance.
  if (!picked && (contractors === undefined || contractors.length === 0)) {
    return null;
  }

  if (picked) {
    return (
      <PickedContractorCard
        onFile={onFile}
        onChange={() => {
          onClear();
          setOpen(true);
          setQuery("");
        }}
        onClear={() => {
          onClear();
          setOpen(false);
        }}
        onUseUsualRate={onUseUsualRate}
      />
    );
  }

  const rows = filterContractors(contractors ?? [], query);

  return (
    <View className="mb-4 rounded-lg border border-border bg-sunken px-4 py-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Icon name="users" size={15} color={colors.muted} />
        <Text className="flex-1 text-sm font-semibold text-ink">
          Paid someone before?
        </Text>
        <Button
          title={open ? "Never mind" : "Pick from the roster"}
          variant="secondary"
          size="sm"
          icon={open ? "x" : "user-check"}
          onPress={() => {
            setOpen((o) => !o);
            setQuery("");
          }}
        />
      </View>
      <Text className="mt-1 text-xs text-muted">
        Pick a returning contractor and we&apos;ll fill in who they are. What
        the work is, when, and how much stay yours to write.
      </Text>

      {open ? (
        <View className="mt-3">
          <TextField
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name, business, or email"
            autoCapitalize="none"
          />
          {rows.length === 0 ? (
            <Text className="py-2 text-xs text-muted">
              Nobody on the roster matches “{query.trim()}”. They may just be
              new — write the agreement as normal.
            </Text>
          ) : (
            <View className="gap-1.5">
              {rows.map((row) => (
                <RosterOption
                  key={row._id}
                  row={row}
                  onPress={() => {
                    onPick(row);
                    setOpen(false);
                    setQuery("");
                  }}
                />
              ))}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** One pickable person: who they are, what's on file, when we last paid them. */
function RosterOption({
  row,
  onPress,
}: {
  row: ContractorRosterRow;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Fill this agreement in for ${row.name}`}
      className="rounded-md border border-border bg-raised px-3 py-2.5 active:opacity-80 web:hover:border-border-strong"
    >
      <View className="flex-row items-start gap-2">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
            {row.name}
            {row.businessName ? (
              <Text className="font-normal text-muted"> · {row.businessName}</Text>
            ) : null}
          </Text>
          <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
            {onFileShortLine(row)}
          </Text>
        </View>
        <Text className="text-2xs text-faint">{lastPaidLine(row.lastPaidAt)}</Text>
      </View>
    </Pressable>
  );
}

/**
 * The picked contractor, and the reassurance that is the point of the whole
 * feature: what the org already holds, so nobody apologises for asking again.
 */
function PickedContractorCard({
  onFile,
  onChange,
  onClear,
  onUseUsualRate,
}: {
  onFile: ContractorOnFile | undefined;
  onChange: () => void;
  onClear: () => void;
  onUseUsualRate: (amountText: string) => void;
}) {
  if (onFile === undefined) {
    return (
      <View className="mb-4 rounded-lg border border-border bg-sunken px-4 py-3">
        <Text className="text-sm text-muted">Looking up what&apos;s on file…</Text>
      </View>
    );
  }

  const summary = onFileSummary(onFile);
  const rate = usualRateHint(onFile.usualRateUsd);

  return (
    <View className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-4 py-3">
      <View className="flex-row flex-wrap items-start gap-2">
        <Icon name="user-check" size={15} color={colors.accent} />
        <View className="min-w-[180px] flex-1">
          <Text className="text-sm font-semibold text-ink">
            It&apos;s {onFile.name} again
          </Text>
          {onFile.businessName ? (
            <Text className="text-xs text-muted">{onFile.businessName}</Text>
          ) : null}
        </View>
        <Button
          title="Someone else"
          variant="ghost"
          size="sm"
          icon="repeat"
          onPress={onChange}
        />
        <Button
          title="Not a returning contractor"
          variant="ghost"
          size="sm"
          icon="x"
          onPress={onClear}
        />
      </View>

      {/* What we already hold — the value of the roster, made visible. */}
      {summary.sentence ? (
        <View className="mt-2 flex-row items-start gap-2">
          <Icon name="check-circle" size={13} color={colors.success} />
          <Text className="flex-1 text-xs text-muted">{summary.sentence}</Text>
        </View>
      ) : (
        <Text className="mt-2 text-xs text-muted">
          Nothing on file for them yet — they&apos;ll add their tax form and
          bank details from the link, same as a first-timer.
        </Text>
      )}

      {/* A form we hold but cannot reuse. Said plainly, and NOT a blocker. */}
      {summary.reaskProblem ? (
        <View className="mt-2 flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2">
          <Icon name="alert-triangle" size={13} color={colors.warn} />
          <Text className="flex-1 text-xs text-warn">
            {summary.reaskProblem} They&apos;ll be asked for a current one when
            they open their link — the payment can still go out as normal.
          </Text>
        </View>
      ) : null}

      <View className="mt-2 flex-row flex-wrap items-center gap-2">
        <Badge
          label={taxClassificationLabel(onFile.taxClassification)}
          tone={
            taxClassificationMissing(onFile.taxClassification)
              ? "neutral"
              : "info"
          }
          icon="briefcase"
        />
        <Text className="text-2xs text-faint">
          {lastPaidLine(onFile.lastPaidAt)}
        </Text>
      </View>

      {/* THE HINT. Not a prefill: the Amount field stays empty until somebody
          presses this, and pressing it is a decision with a person behind it. */}
      {rate ? (
        <Pressable
          onPress={() => onUseUsualRate(rate.amountText)}
          accessibilityRole="button"
          accessibilityLabel={`Use their usual rate as this agreement's amount`}
          className="mt-2.5 flex-row items-center gap-1.5 self-start rounded-md border border-border-strong bg-raised px-3 py-1.5 active:opacity-80"
        >
          <Icon name="corner-down-left" size={13} color={colors.muted} />
          <Text className="text-xs font-semibold text-ink">{rate.label}</Text>
        </Pressable>
      ) : null}

      <Text className="mt-2 text-2xs text-faint">
        The work, the date and the amount are this job&apos;s terms — they stay
        empty until you write them.
      </Text>
    </View>
  );
}
