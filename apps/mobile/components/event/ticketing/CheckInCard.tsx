/**
 * Door check-in — type/scan a ticket code, get an inline verdict. The
 * mutation is idempotent-safe server-side: "already" reports the prior
 * check-in time instead of double-admitting.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Card, TextField } from "../../ui";
import { formatTime } from "../../../lib/format";
import type { ActionRunner } from "../../../lib/useActionToast";

type CheckInResult =
  | { result: "ok"; attendeeName: string; ticketTypeName: string }
  | { result: "already"; attendeeName: string; checkedInAt: number | null }
  | { result: "not_found" }
  | { result: "void" };

export function CheckInCard({
  eventId,
  run,
}: {
  eventId: Id<"events">;
  run: ActionRunner["run"];
}) {
  const checkIn = useMutation(api.ticketing.checkInTicket);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CheckInResult | null>(null);

  async function handleCheckIn() {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    const res = (await run(() => checkIn({ eventId, code: trimmed }), {
      errorTitle: "Couldn't check in",
    })) as CheckInResult | undefined;
    setBusy(false);
    if (res === undefined) return; // error already surfaced
    setOutcome(res);
    if (res.result === "ok") setCode("");
  }

  return (
    <Card>
      <TextField
        label="Ticket code"
        value={code}
        onChangeText={(t) => setCode(t.toUpperCase())}
        placeholder="PW-XXXX-XXXX"
        autoCapitalize="characters"
        autoCorrect={false}
        onSubmitEditing={() => void handleCheckIn()}
      />
      <View className="flex-row items-center gap-3">
        <Button
          title="Check in"
          icon="check-circle"
          loading={busy}
          disabled={code.trim() === ""}
          onPress={() => void handleCheckIn()}
        />
      </View>
      {outcome ? <ResultLine outcome={outcome} /> : null}
    </Card>
  );
}

function ResultLine({ outcome }: { outcome: CheckInResult }) {
  if (outcome.result === "ok") {
    return (
      <Text className="mt-3 text-base font-semibold text-success">
        ✓ {outcome.attendeeName} checked in · {outcome.ticketTypeName}
      </Text>
    );
  }
  if (outcome.result === "already") {
    return (
      <Text className="mt-3 text-base font-semibold text-warn">
        {outcome.attendeeName} already checked in
        {outcome.checkedInAt != null ? ` at ${formatTime(outcome.checkedInAt)}` : ""}
      </Text>
    );
  }
  if (outcome.result === "void") {
    return (
      <Text className="mt-3 text-base font-semibold text-danger">
        This ticket was voided.
      </Text>
    );
  }
  return (
    <Text className="mt-3 text-base font-semibold text-danger">
      No such ticket for this event.
    </Text>
  );
}
