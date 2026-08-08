import { Text, View } from "react-native";
import { Card } from "../../ui";

type Step = { title: string; detail: string };

/** The prototype's reimbursement "How it works" explainer. Static copy —
 *  kept truthful about the review loop: a reviewer's send-back ("almost — fix
 *  this one thing") is a normal outcome, not a rejection, and a claimant who
 *  expects that reads the email very differently. */
const STEPS: Step[] = [
  {
    title: "Submit with receipts and details",
    detail:
      "Every line needs a receipt, the date you paid, and what it was for — a travel route, or who was at a meal. The IRS requires those details, and they're what our public ledger shows.",
  },
  {
    title: "Finance manager reviews",
    detail:
      "They check each receipt and that it lands in an approved budget line before any money moves. If something's missing they send it back with a note — you fix it and resubmit; nothing is lost.",
  },
  {
    title: "ACH payout",
    detail: "Approval auto-sends the ACH straight to your bank (or the Treasurer pays it manually if the chapter's account isn't set up).",
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
