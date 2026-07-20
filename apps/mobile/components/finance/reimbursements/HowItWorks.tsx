import { Text, View } from "react-native";
import { Card } from "../../ui";

type Step = { title: string; detail: string };

/** The prototype's reimbursement "How it works" 3-step explainer. Static copy. */
const STEPS: Step[] = [
  {
    title: "Submit with receipts",
    detail: "Line items tagged to a category, with receipts attached.",
  },
  {
    title: "Finance manager approves",
    detail: "They review each receipt and check it lands in an approved budget line before any money moves.",
  },
  {
    title: "ACH payout",
    detail: "Approval auto-sends the ACH from the chapter's Increase account straight to your bank.",
  },
];

export function HowItWorks() {
  return (
    <Card>
      <Text className="text-xs font-bold uppercase tracking-wider text-muted">
        How it works
      </Text>
      <View className="mt-3 gap-3">
        {STEPS.map((step, i) => (
          <View key={step.title} className="flex-row items-start gap-3">
            <View className="h-7 w-7 items-center justify-center rounded-pill bg-accent-soft">
              <Text className="text-xs font-bold text-accent">{i + 1}</Text>
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-ink">
                {step.title}
              </Text>
              <Text className="text-xs text-muted">{step.detail}</Text>
            </View>
          </View>
        ))}
      </View>
      <Text className="mt-4 text-xs text-muted">
        <Text className="font-semibold text-ink">Prior approval matters.</Text>{" "}
        Buying something not already in the budget? Ask for pre-approval first —
        unapproved surprises can be declined.
      </Text>
    </Card>
  );
}
