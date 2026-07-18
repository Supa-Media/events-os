/**
 * The reimbursement-request SHARE LINK page — reachable at `/reimburse-request`,
 * meant to be texted/emailed to a chapter member so they can request a
 * reimbursement without hunting through the app first (see the "Share request
 * link" button on the Reimbursements tab, `(app)/finances/reimbursements/index.tsx`).
 *
 * Lives under `app/` OUTSIDE the `(app)`/`(auth)` route groups (same placement
 * as `/share/<id>` and `/d/<shareId>` — the root layout just renders `<Slot/>`
 * inside the Convex provider, so nothing here is auto-gated). UNLIKE those two
 * routes, though, this page is NOT anonymous — owner decision 2026-07-18: a
 * reimbursement request must be attributable to a real chapter member, so this
 * page requires sign-in:
 *
 *   1. Signed out              → redirect to `/(auth)/login?redirect=/reimburse-request`
 *                                 (login.tsx bounces back here on success).
 *   2. Signed in, no access    → a plain "no access" message.
 *   3. Signed in, no chapter   → "ask your chapter director to add you" — this
 *                                 page deliberately does NOT offer the normal
 *                                 self-serve chapter picker (`OnboardingScreen`)
 *                                 a first-time (app) visitor gets; a reimbursement
 *                                 claimant must be a REAL, director-added member.
 *   4. Signed in, has a chapter → the bare request form, no sidebar/tab chrome —
 *                                 just `ReimbursementRequestForm` in a `Screen`.
 */
import { useEffect } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { Stack, useRouter } from "expo-router";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon, Screen, Narrow } from "../components/ui";
import { colors } from "../lib/theme";
import { ReimbursementRequestForm } from "../components/finance/reimbursements/RequestForm";

function BrandMark() {
  return (
    <View className="mb-6 flex-row items-center gap-2.5">
      <View className="h-9 w-9 items-center justify-center rounded-md bg-accent">
        <Icon name="calendar" size={18} color="#FFFFFF" />
      </View>
      <View className="flex-row items-baseline gap-1">
        <Text className="font-display text-xl text-ink">Chapter</Text>
        <Text className="font-display text-xl text-accent">OS</Text>
      </View>
    </View>
  );
}

function CenteredMessage({ icon, title, message }: { icon: string; title: string; message: string }) {
  return (
    <Screen>
      <Narrow width={520}>
        <BrandMark />
        <View className="items-center gap-3 rounded-lg border border-border bg-raised p-8">
          <Icon name={icon as never} size={28} color={colors.muted} />
          <Text className="text-center font-display text-xl text-ink">{title}</Text>
          <Text className="text-center text-sm text-muted">{message}</Text>
        </View>
      </Narrow>
    </Screen>
  );
}

export default function ReimburseRequestScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const me = useQuery(api.profiles.me, isAuthenticated ? {} : "skip");
  const reconcileMyPerson = useMutation(api.profiles.reconcileMyPerson);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/(auth)/login?redirect=/reimburse-request");
    }
  }, [isLoading, isAuthenticated, router]);

  // Make sure a member who's never opened the main app before still has a
  // People row before they hit Submit — mirrors `(app)/_layout.tsx`'s own
  // best-effort call. Never blocks rendering the form either way.
  useEffect(() => {
    if (me && me.allowed !== false && me.hasChapter) {
      reconcileMyPerson().catch(() => {});
    }
  }, [me, reconcileMyPerson]);

  if (isLoading || !isAuthenticated || me === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View className="flex-1 items-center justify-center bg-surface">
          <ActivityIndicator color={colors.accent} />
        </View>
      </>
    );
  }

  if (me === null || me.allowed === false) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <CenteredMessage
          icon="lock"
          title="No access"
          message="This account doesn't have access to Chapter OS. Ask an admin to add you."
        />
      </>
    );
  }

  if (!me.hasChapter) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <CenteredMessage
          icon="users"
          title="Ask your chapter director to add you"
          message="You're signed in, but you're not on a chapter roster yet — a reimbursement request needs to be tied to your chapter. Ask your director to add you, then try this link again."
        />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ReimbursementRequestForm />
    </>
  );
}
