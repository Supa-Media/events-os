/**
 * FINANCES · REIMBURSEMENTS — Phase-1 SHELL.
 *
 * The public request form (accountless submission via a secret link) + the
 * receipts/approval/ACH-payout backend land in Phase 3, so there is no
 * `api.finances.reimbursements` yet and no mutations are wired here. This screen
 * renders the prototype's manager approval-queue layout as an empty shell: the
 * queue header + filter pills (derived from the shared REIMBURSEMENT_STATUSES),
 * an empty state, the separation-of-duties note, and the "How it works" 3-step
 * explainer (Submit with receipts → Finance manager approves → ACH payout).
 *
 * Guarded admin-or-lead in-screen (mirrors the nav gate). Matches
 * `finances.html` (§ Reimbursements approval queue) and `docs/plans/finance.md`
 * (§ Reimbursements).
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  REIMBURSEMENT_STATUS_LABELS,
  type ReimbursementStatus,
} from "@events-os/shared";
import {
  EmptyState,
  Icon,
  Narrow,
  Pill,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { HowItWorks } from "../../../components/finance/reimbursements/HowItWorks";

// The queue filters shown in the prototype (All + the live-transition states).
// Labels come from the shared enum so the shell can't drift from the backend.
const QUEUE_FILTER_STATUSES: ReimbursementStatus[] = [
  "pending_preapproval",
  "submitted",
  "paying",
];

export default function ReimbursementsScreen() {
  const org = useQuery(api.org.nav);

  // In-screen guard: approving reimbursements is a finance-manager action
  // (admin or lead for now, mirroring the nav gate).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Reimbursements are restricted"
            message="Only chapter admins and finance managers can review reimbursement requests."
          />
        </Narrow>
      </Screen>
    );
  }

  if (org === undefined) return <Screen loading />;

  return (
    <Screen>
      <Narrow>
        <View className="mb-1 flex-row items-center gap-2">
          <Text className="font-display text-2xl text-ink">Reimbursements</Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Coming soon
          </Text>
        </View>
        <Text className="mb-4 text-sm text-muted">
          Approve what volunteers and card-less team members spent, then pay them
          by ACH from the chapter's Increase account.
        </Text>

        {/* Approval queue — header + illustrative filter pills. */}
        <SectionHeader title="Approval queue" count="0 open" />
        <View className="mb-4 flex-row flex-wrap gap-2">
          <Pill label="All" />
          {QUEUE_FILTER_STATUSES.map((s) => (
            <Pill key={s} label={REIMBURSEMENT_STATUS_LABELS[s]} />
          ))}
        </View>

        <EmptyState
          icon="inbox"
          title="No reimbursement requests yet"
          message="The public request form ships in Phase 3. Submitted requests will appear here for a finance manager to approve and pay by ACH."
        />

        {/* Separation-of-duties note (prototype's warn strip). */}
        <View className="mt-4 flex-row gap-3 rounded-lg border border-warn bg-warn-bg px-4 py-3">
          <Icon name="alert-triangle" size={16} color={colors.warn} />
          <Text className="flex-1 text-sm text-ink">
            <Text className="font-bold">Separation of duties.</Text> Nobody can
            approve their own request, and large payouts can require a second
            approver.
          </Text>
        </View>

        {/* How it works — the 3-step submit → approve → payout explainer. */}
        <SectionHeader title="How reimbursements work" />
        <HowItWorks />
      </Narrow>
    </Screen>
  );
}
