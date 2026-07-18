/**
 * FINANCES · REIMBURSEMENTS · New — the in-app member submission form.
 *
 * Thin wrapper around the shared `ReimbursementRequestForm` (see its doc
 * comment for the mutation/field details) — this screen just adds the
 * authenticated-app chrome (a back arrow that returns to the queue).
 */
import { useRouter } from "expo-router";
import { ReimbursementRequestForm } from "../../../../components/finance/reimbursements/RequestForm";

export default function NewReimbursementScreen() {
  const router = useRouter();
  return (
    <ReimbursementRequestForm
      onBack={() => router.back()}
      onSubmitted={() => router.back()}
    />
  );
}
