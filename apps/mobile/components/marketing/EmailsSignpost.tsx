/**
 * MARKETING · Emails — a signpost, not a desk.
 *
 * Bulk email left this app on 2026-08-19 (`docs/plans/email-desk-parked.md`):
 * the custom stack could not match Mailchimp on rendering fidelity, engagement
 * tracking, client testing, or deliverability, and the honest call was to stop
 * maintaining a worse one. The newsletter goes out through Mailchimp.
 *
 * ── Why this tab exists at all ──────────────────────────────────────────────
 * Because "email" is the first thing anyone opens a marketing desk looking for,
 * and the two alternatives are both worse. Leaving the tab out reads as "not
 * built yet" and invites someone to ask for it every few weeks. Wiring it to
 * the parked designer would hand a marketer a tool the org has decided not to
 * send with. A tab that says where the newsletter actually lives — and what the
 * OS still does for it — is the answer to the question people are really asking.
 *
 * What the OS DOES still own is the list (the tab next door) and the sync that
 * keeps Mailchimp's audience honest: an unsubscribe or a bounce over there
 * writes a suppression here, so event blasts stop too. That is worth saying on
 * this screen, because it is the part that would otherwise look like nothing.
 */
import { View, Text } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import {
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
} from "../ui";

export function MarketingEmailsSignpost() {
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const router = useRouter();

  if (access === undefined) return <Screen loading />;
  if (!access.canViewDesk) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Marketing desk access needed"
            message="Ask the Marketing Director or the ED for access."
          />
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen>
      <Narrow>
        <SectionHeader title="Emails" />
        <Card padding="lg" className="mb-4">
          <Text className="mb-2 text-base font-semibold text-ink">
            The newsletter goes out through Mailchimp
          </Text>
          <Text className="mb-3 text-sm text-muted">
            We built a full email tool in here and then stopped using it — it
            couldn't match Mailchimp on how designs render in real inboxes, on
            open and click tracking, or on catching a deliverability problem
            before recipients did. Composing and sending live over there.
          </Text>
          <Text className="text-sm text-muted">
            Coming back into the OS one day is possible, but it isn't scheduled,
            and nothing here is waiting on it.
          </Text>
        </Card>

        <Card padding="lg" className="mb-4">
          <Text className="mb-2 text-base font-semibold text-ink">
            What the OS still does for it
          </Text>
          <Text className="mb-1 text-sm text-muted">
            • Keeps the audience. The Mailing list tab is the list Mailchimp is
            synced from — add someone here and they get pushed across.
          </Text>
          <Text className="mb-1 text-sm text-muted">
            • Honors the unsubscribes. Someone who unsubscribes or bounces in
            Mailchimp is recorded here too, so our event texts and blasts stop
            as well. That only works in one direction on purpose: nothing in
            this app can put a person back on after they've taken themselves
            off.
          </Text>
          <Text className="text-sm text-muted">
            • Records consent. The sign-up link on the Mailing list tab stores
            who said yes and when.
          </Text>
        </Card>

        <View className="flex-row">
          <Button
            title="Open the mailing list"
            variant="secondary"
            onPress={() => router.navigate("/marketing/list" as never)}
          />
        </View>
      </Narrow>
    </Screen>
  );
}
