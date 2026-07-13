import { useState } from "react";
import { useConvex } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@events-os/convex/_generated/api";
import { useActionRunner } from "../../lib/useActionToast";
import { Mode, isValidEmail, toEmail } from "./login.helpers";

type Step = "request" | "verify";

const NO_ACCESS_MESSAGE =
  "This account doesn't have access to Events OS. Ask an admin to add you.";

/**
 * Email-OTP login flow. Owns all form state so the screen stays pure
 * presentation: request a code for a member username or an invited guest email,
 * then verify it. The guest pre-flight (`checkEmail`) blocks an unapproved email
 * before any code is sent; the server still gates every data call afterward.
 */
export function useEmailOtpLogin() {
  const { signIn } = useAuthActions();
  const convex = useConvex();
  const { run, toast, dismiss } = useActionRunner();

  const [step, setStep] = useState<Step>("request");
  const [mode, setMode] = useState<Mode>("member");
  const [username, setUsername] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email =
    mode === "guest" ? guestEmail.trim().toLowerCase() : toEmail(username);
  const canSubmitRequest =
    mode === "guest" ? isValidEmail(guestEmail) : !!username.trim();

  function clearError() {
    if (error) setError(null);
  }

  function toggleMode() {
    setMode(mode === "guest" ? "member" : "guest");
    backToRequest();
  }

  function backToRequest() {
    setStep("request");
    setCode("");
    setError(null);
  }

  /** Validation message for the current identifier, or null when it's usable. */
  function identifierError(): string | null {
    if (mode === "guest") {
      if (!guestEmail.trim()) return "Enter your email to get a code.";
      if (!isValidEmail(guestEmail)) return "Enter a valid email address.";
      return null;
    }
    return username.trim() ? null : "Enter your username to get a code.";
  }

  /** True unless the server says this email definitively lacks access. */
  async function hasServerAccess(): Promise<boolean> {
    try {
      const { allowed } = await convex.query(api.accessAllowlist.checkEmail, { email });
      return allowed;
    } catch {
      return true; // fail-open — the server still gates every data call
    }
  }

  /** Validate, pre-flight access, then send the code. Returns true if sent. */
  async function deliverCode(
    setBusy: (busy: boolean) => void,
    errorTitle: string,
  ): Promise<boolean> {
    const invalid = identifierError();
    if (invalid) {
      setError(invalid);
      return false;
    }
    setError(null);
    setBusy(true);
    if (!(await hasServerAccess())) {
      setError(NO_ACCESS_MESSAGE);
      setBusy(false);
      return false;
    }
    const ok = await run(() => signIn("email", { email }), { errorTitle });
    setBusy(false);
    return ok !== undefined;
  }

  async function requestCode() {
    const sent = await deliverCode(setSubmitting, "Couldn't send your code");
    if (sent) setStep("verify");
  }

  function resendCode() {
    return deliverCode(setResending, "Couldn't resend your code");
  }

  async function verifyCode() {
    setError(null);
    setSubmitting(true);
    const ok = await run(() => signIn("email", { email, code: code.trim() }), {
      errorTitle: "That code didn't work",
    });
    // Navigation happens once `isAuthenticated` flips (see the screen effect);
    // keep the spinner until then, and only clear it when verification failed.
    if (ok === undefined) setSubmitting(false);
  }

  function changeUsername(next: string) {
    setUsername(next);
    clearError();
  }

  function changeGuestEmail(next: string) {
    setGuestEmail(next);
    clearError();
  }

  function changeCode(next: string) {
    setCode(next);
    clearError();
  }

  return {
    step,
    mode,
    email,
    username,
    guestEmail,
    code,
    submitting,
    resending,
    error,
    canSubmitRequest,
    toast,
    dismiss,
    changeUsername,
    changeGuestEmail,
    changeCode,
    requestCode,
    resendCode,
    verifyCode,
    toggleMode,
    backToRequest,
  };
}
