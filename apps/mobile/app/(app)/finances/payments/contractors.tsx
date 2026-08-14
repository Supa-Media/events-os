/**
 * FINANCES · PAYMENTS · CONTRACTORS — who we've paid, and what we still hold
 * for them.
 *
 * The payments queue is a list of TRANSACTIONS. This is the list of PEOPLE
 * behind them: the durable profiles that let a returning contractor skip the
 * W-9 and the bank form, and let a staffer skip re-typing their details. It is
 * the roster the composer's picker reads, shown plainly so "why wasn't Dana
 * asked for her W-9 again?" has an answer somebody can go and look at.
 *
 * A RUNG ABOVE THE QUEUE, deliberately. `contractorProfiles.list` demands
 * finance-manager rank rather than the queue's viewer floor — every row here is
 * one step from a tax document, and it is the object a curious member would
 * most like to browse and least need to. The refusal is a real, expected state,
 * so the screen wears a `FinanceBoundary` with its own lock copy instead of
 * rendering an empty list at somebody who was told no.
 *
 * THE ROSTER IS NOT THE TAX FORM. Rows carry METADATA only — which form, when
 * it arrived, whether it is still usable. Nothing here can open the file;
 * `requireContractorTaxDocView` still gates that on the payment detail screen,
 * because making a contractor easier to FIND must not make their W-9 easier to
 * OPEN.
 *
 * TWO WRITES LIVE HERE, and they are opposites:
 *
 *  · TAX CLASSIFICATION (`save`) — how the contractor is organised, which is
 *    the fact that decides whether their payments are 1099-reportable at all.
 *    `unknown` is a real value, not a failure: every contractor on file
 *    predates the question, so it renders as "Not recorded" and is nudged
 *    rather than flagged.
 *  · FORGET (`forget`) — the one irreversible thing on this surface, and the
 *    request a contractor is entitled to make. Its confirmation is written to
 *    be honest about the part people find surprising: the bank details ALWAYS
 *    go, and a tax form still inside its retention window STAYS, because it
 *    substantiates money that actually moved. The server reports
 *    `documentsKept`, and this screen says that number out loud rather than
 *    reporting a success the reader would hear as "all gone".
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  BackLink,
  Badge,
  Button,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  Select,
  TextField,
  ToastView,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import { confirmAction } from "../../../../lib/confirmAction";
import { useActionRunner } from "../../../../lib/useActionToast";
import { FinanceBoundary } from "../../../../components/finance/dashboard/parts";
import {
  FORGET_CONFIRM_TITLE,
  filterContractors,
  forgetConfirmMessage,
  forgetOutcomeMessage,
  lastPaidLine,
  onFileSummary,
  taxClassificationLabel,
  taxClassificationMissing,
  taxClassificationOptions,
  type ContractorRosterRow,
} from "../../../../components/finance/payments/contractorHelpers";

/** Mirrors the 200-row ceiling `api.contractorProfiles.list` clamps `limit` to,
 *  so the "showing the most recent N" notice can never quote a number the
 *  backend doesn't actually use. */
const ROSTER_READ_CAP = 200;

function ContractorRoster() {
  const router = useRouter();
  const roster = useQuery(api.contractorProfiles.list, {
    limit: ROSTER_READ_CAP,
  });
  const save = useMutation(api.contractorProfiles.save);
  const forget = useMutation(api.contractorProfiles.forget);
  const { run, toast, dismiss } = useActionRunner();

  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** What `forget` actually did, kept per person so the honest sentence sits
   *  on the row it belongs to rather than vanishing with a toast. */
  const [forgotten, setForgotten] = useState<Record<string, string>>({});

  if (roster === undefined) return <Screen loading />;

  const canManage = roster.canManage === true;
  const rows = filterContractors(roster.contractors, query);

  function handleClassify(row: ContractorRosterRow, value: string) {
    setBusy(`class:${row._id}`);
    void run(
      () =>
        save({
          personId: row.personId,
          taxClassification: value as ContractorRosterRow["taxClassification"],
        }),
      { errorTitle: "Couldn't save how they're organised" },
    ).then(() => setBusy(null));
  }

  function handleForget(row: ContractorRosterRow) {
    confirmAction({
      title: FORGET_CONFIRM_TITLE,
      message: forgetConfirmMessage(row.name),
      confirmLabel: "Forget them",
      destructive: true,
      onConfirm: () => {
        setBusy(`forget:${row._id}`);
        void run(() => forget({ personId: row.personId }), {
          errorTitle: "Couldn't forget them",
        }).then((result) => {
          setBusy(null);
          if (result === undefined) return;
          setForgotten((f) => ({
            ...f,
            [row._id]: forgetOutcomeMessage(result),
          }));
        });
      },
    });
  }

  return (
    <>
      <Screen maxWidth={1080}>
        <Narrow>
          <BackLink fallback="/finances/payments" label="Payments" />
          <View className="mb-1 flex-row flex-wrap items-center justify-between gap-2">
            <Text className="font-display text-2xl text-ink">Contractors</Text>
            <Button
              title="New agreement"
              size="sm"
              icon="plus"
              onPress={() => router.push("/finances/payments/new" as never)}
            />
          </View>
          <Text className="mb-4 text-sm text-muted">
            Everyone the chapter has paid as a contractor, and what we still
            hold for them. A person on this list doesn&apos;t get asked for
            their tax form or bank details again — pick them at the top of a new
            agreement.
          </Text>

          {roster.contractors.length === 0 ? (
            <EmptyState
              icon="users"
              title="No returning contractors yet"
              message="Someone joins this list the first time a payment to them actually pays out — not when the agreement is written. Until then there's nothing to remember."
            />
          ) : (
            <>
              <TextField
                value={query}
                onChangeText={setQuery}
                placeholder="Search by name, business, or email"
                autoCapitalize="none"
              />

              {rows.length === 0 ? (
                <EmptyState
                  icon="search"
                  title="Nobody matches that"
                  message="Try part of their name, their business name, or the email address we have on file."
                />
              ) : (
                <View className="gap-2">
                  {rows.map((row) => (
                    <ContractorCard
                      key={row._id}
                      row={row}
                      canManage={canManage}
                      expanded={expanded === row._id}
                      onToggle={() =>
                        setExpanded((e) => (e === row._id ? null : row._id))
                      }
                      busy={busy}
                      forgottenNote={forgotten[row._id] ?? null}
                      onClassify={(v) => handleClassify(row, v)}
                      onForget={() => handleForget(row)}
                    />
                  ))}
                  {roster.contractors.length >= ROSTER_READ_CAP ? (
                    <Text className="mt-2 text-xs text-muted">
                      Showing the most recent {ROSTER_READ_CAP} contractors.
                      Older ones aren&apos;t listed here yet.
                    </Text>
                  ) : null}
                </View>
              )}
            </>
          )}
        </Narrow>
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}

/** One person: who they are, what's on file, and — once opened — how they're
 *  organised and the door marked "forget them". */
function ContractorCard({
  row,
  canManage,
  expanded,
  onToggle,
  busy,
  forgottenNote,
  onClassify,
  onForget,
}: {
  row: ContractorRosterRow;
  canManage: boolean;
  expanded: boolean;
  onToggle: () => void;
  busy: string | null;
  forgottenNote: string | null;
  onClassify: (value: string) => void;
  onForget: () => void;
}) {
  const summary = onFileSummary(row);
  const unrecorded = taxClassificationMissing(row.taxClassification);

  return (
    <View className="rounded-lg border border-border bg-raised px-4 py-3">
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Hide" : "Show"} what's on file for ${row.name}`}
        className="flex-row items-start gap-3 active:opacity-80"
      >
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
            {row.name}
            {row.businessName ? (
              <Text className="font-normal text-muted"> · {row.businessName}</Text>
            ) : null}
          </Text>
          {row.email ? (
            <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
              {row.email}
            </Text>
          ) : null}
          <Text className="mt-1 text-2xs text-faint">
            {lastPaidLine(row.lastPaidAt)}
          </Text>
        </View>
        <View className="items-end gap-1.5">
          {/* METADATA ONLY. Nothing on this screen can open the file. */}
          {summary.taxLine ? (
            <Badge
              label={summary.taxLine}
              tone={summary.reaskProblem ? "warn" : "success"}
              icon={summary.reaskProblem ? "alert-triangle" : "file-text"}
            />
          ) : (
            <Badge label="No tax form" tone="neutral" icon="file-text" />
          )}
          {row.hasBankOnFile ? (
            <Badge
              label={
                row.bankAccountLast4
                  ? `Bank ····${row.bankAccountLast4}`
                  : "Bank on file"
              }
              tone="info"
              icon="credit-card"
            />
          ) : null}
          <Badge
            label={taxClassificationLabel(row.taxClassification)}
            tone={unrecorded ? "neutral" : "lavender"}
            icon="briefcase"
          />
        </View>
      </Pressable>

      {summary.reaskProblem ? (
        <View className="mt-2 flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2">
          <Icon name="alert-triangle" size={13} color={colors.warn} />
          <Text className="flex-1 text-xs text-warn">
            {summary.reaskProblem} They&apos;ll be asked for a current one on
            their next agreement — nothing is blocked.
          </Text>
        </View>
      ) : null}

      {forgottenNote ? (
        <View className="mt-2 flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
          <Icon name="check" size={13} color={colors.muted} />
          <Text className="flex-1 text-xs text-muted">{forgottenNote}</Text>
        </View>
      ) : null}

      {expanded ? (
        <View className="mt-3 border-t border-border pt-3">
          {/* ── How they're organised ─────────────────────────────────────── */}
          {canManage ? (
            <Select
              label="How are they organised?"
              hint="This is what decides whether their payments are 1099-reportable — payments to a C or S corporation generally aren't. Leave it as “Not recorded” if you don't know; a wrong answer is worse than a blank one."
              value={row.taxClassification}
              options={taxClassificationOptions()}
              onChange={onClassify}
              placeholder="Not recorded"
            />
          ) : (
            <Text className="mb-3 text-xs text-muted">
              Organised as: {taxClassificationLabel(row.taxClassification)}
            </Text>
          )}
          {busy === `class:${row._id}` ? (
            <Text className="mb-3 text-xs text-muted">Saving…</Text>
          ) : null}
          {unrecorded ? (
            <View className="mb-3 flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
              <Icon name="info" size={13} color={colors.muted} />
              <Text className="flex-1 text-xs text-muted">
                Not recorded yet. Everyone already on the roster predates this
                question, so this is normal — but the year-end 1099 view can
                only guess until somebody answers it.
              </Text>
            </View>
          ) : null}

          {/* ── Forgetting them ───────────────────────────────────────────── */}
          {canManage ? (
            <View className="items-start">
              <Button
                title="Forget this contractor"
                variant="ghost"
                size="sm"
                icon="trash-2"
                loading={busy === `forget:${row._id}`}
                onPress={onForget}
              />
              <Text className="mt-1 text-2xs text-faint">
                Deletes the bank details we remember. A tax form still inside
                its four-year retention window is KEPT — the chapter is required
                to hold it — and we&apos;ll tell you which happened. Their
                payment history is never deleted.
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function NoRosterAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Finance manager access needed"
      message="The contractor roster is a list of people we pay, each row one step from a tax document — so it sits a rung above the payments queue. Ask a finance manager if you need it."
    />
  );
}

export default function ContractorsScreen() {
  return (
    <FinanceBoundary fallback={<NoRosterAccess />}>
      <ContractorRoster />
    </FinanceBoundary>
  );
}
