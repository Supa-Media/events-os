/**
 * The receipt-reminder timeline shown in the Reconcile detail pane: a vertical
 * four-step schedule (Purchased → End-of-day flag → Day-3 escalate → Day-7
 * auto-lock) with a dot-and-connector rail. Step states come from
 * `receiptTimeline` — done (red dot), active (amber dot), pending (hollow dot).
 */
import { View, Text } from "react-native";
import { receiptTimeline, type ReceiptState, type TimelineStepState } from "./helpers";

const DOT: Record<TimelineStepState, string> = {
  done: "border-accent bg-accent",
  active: "border-warn bg-warn",
  pending: "border-border-strong bg-raised",
};

export function ReceiptTimeline({
  postedAt,
  receipt,
}: {
  postedAt: number;
  receipt: ReceiptState;
}) {
  const steps = receiptTimeline(postedAt, receipt);
  return (
    <View>
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        return (
          <View key={i} className="flex-row gap-3">
            {/* Dot + connector rail. */}
            <View className="items-center pt-1">
              <View
                className={`h-3 w-3 rounded-pill border-2 ${DOT[step.state]}`}
              />
              {!last ? (
                <View className="my-1 w-0.5 flex-1 bg-border-strong" />
              ) : null}
            </View>
            <View className={`flex-1 ${last ? "" : "pb-4"}`}>
              <Text className="text-sm font-semibold text-ink">
                {step.title}
              </Text>
              <Text className="mt-0.5 text-xs text-muted">{step.sub}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
