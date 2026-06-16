import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Card, Button, TextField, Icon, ToastView } from "../../components/ui";
import { colors } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";

const ALLOWED_DOMAIN = "publicworship.life";

/**
 * Turn a username into the full email on the allowed domain.
 *
 * Accepts either a bare username ("jane") or a full address ("jane@…"); we
 * strip everything from the "@" on so a pasted full email still works, then
 * append the allowed domain.
 */
function toEmail(username: string): string {
  const local = username.trim().split("@")[0].toLowerCase();
  return `${local}@${ALLOWED_DOMAIN}`;
}

/**
 * OTP login for Events OS.
 *
 * Two steps: request a one-time code for the email, then verify it. Access is
 * limited to @publicworship.life accounts, so people enter just their username
 * (the part before @publicworship.life) and we build the full address.
 */
export default function LoginScreen() {
  const { signIn } = useAuthActions();
  const { isAuthenticated } = useConvexAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Navigate only once Convex reports the session is live. `signIn` resolves a
  // render or two BEFORE `isAuthenticated` flips, so replacing the route inside
  // verifyCode raced the (app) auth guard — it saw `!isAuthenticated` and
  // bounced straight back to a fresh login (the "log in twice" bug). Driving the
  // redirect off auth state instead means we leave /login exactly once, after
  // the guard will let us through.
  useEffect(() => {
    if (isAuthenticated) router.replace("/");
  }, [isAuthenticated, router]);

  const [step, setStep] = useState<"request" | "verify">("request");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, toast, dismiss } = useActionRunner();

  const email = toEmail(username);

  // Send (or re-send) the one-time code. `resend` keeps us on the verify step
  // and uses a separate spinner so the primary button isn't blocked.
  async function sendCode(resend = false) {
    if (!username.trim()) {
      setError("Enter your username to get a code.");
      return;
    }
    setError(null);
    if (resend) setResending(true);
    else setSubmitting(true);
    const ok = await run(() => signIn("email", { email }), {
      errorTitle: resend ? "Couldn't resend your code" : "Couldn't send your code",
    });
    if (resend) setResending(false);
    else setSubmitting(false);
    if (ok !== undefined && !resend) setStep("verify");
  }

  async function requestCode() {
    await sendCode(false);
  }

  async function verifyCode() {
    setError(null);
    setSubmitting(true);
    const ok = await run(() => signIn("email", { email, code: code.trim() }), {
      errorTitle: "That code didn't work",
    });
    // On success, navigation happens in the effect above once `isAuthenticated`
    // flips — replacing here would race the (app) guard, so we keep the spinner
    // until the redirect fires. Only clear it when verification failed.
    if (ok === undefined) setSubmitting(false);
  }

  return (
    <View className="flex-1 bg-surface">
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          alignItems: "center",
          paddingHorizontal: 24,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <View className="w-full max-w-md">
          {/* Brand mark */}
          <View className="mb-6 flex-row items-center gap-2.5">
            <View className="h-9 w-9 items-center justify-center rounded-md bg-accent">
              <Icon name="calendar" size={18} color="#FFFFFF" />
            </View>
            <View className="flex-row items-baseline gap-1">
              <Text className="font-display text-xl text-ink">Events</Text>
              <Text className="font-display text-xl text-accent">OS</Text>
            </View>
          </View>

          {toast ? (
            <View className="mb-3">
              <ToastView toast={toast} onDismiss={dismiss} />
            </View>
          ) : null}

          <Card padding="lg">
            <Text className="font-display text-2xl text-ink">
              {step === "request" ? "Sign in" : "Check your email"}
            </Text>
            <Text className="mb-5 mt-1 text-sm text-muted">
              {step === "request"
                ? "We'll email you a one-time code."
                : `Enter the code sent to ${email}.`}
            </Text>

            {step === "request" ? (
              <TextField
                label="Username"
                hint={`Your username is the first part of your @${ALLOWED_DOMAIN} email.`}
                value={username}
                onChangeText={(t) => {
                  setUsername(t);
                  if (error) setError(null);
                }}
                placeholder="you"
                suffix={`@${ALLOWED_DOMAIN}`}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete="username"
                editable={!submitting}
                onSubmitEditing={requestCode}
                returnKeyType="go"
              />
            ) : (
              <TextField
                label="Verification code"
                value={code}
                onChangeText={(t) => {
                  setCode(t);
                  if (error) setError(null);
                }}
                placeholder="123456"
                keyboardType="number-pad"
                autoComplete="one-time-code"
                editable={!submitting}
                onSubmitEditing={verifyCode}
                returnKeyType="go"
              />
            )}

            {error ? (
              <View className="mb-3 flex-row items-center gap-1.5">
                <Icon name="alert-circle" size={14} color={colors.danger} />
                <Text className="flex-1 text-sm text-danger">{error}</Text>
              </View>
            ) : null}

            <Button
              title={step === "request" ? "Send code" : "Verify"}
              onPress={step === "request" ? requestCode : verifyCode}
              loading={submitting}
              disabled={step === "request" ? !username.trim() : !code.trim()}
              className="w-full"
            />

            {step === "verify" ? (
              <View className="mt-2 items-center gap-0.5">
                <Button
                  title="Resend code"
                  variant="ghost"
                  size="sm"
                  icon="refresh-cw"
                  loading={resending}
                  onPress={() => sendCode(true)}
                  disabled={submitting || resending}
                />
                <Button
                  title="Use a different username"
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    setStep("request");
                    setCode("");
                    setError(null);
                  }}
                  disabled={submitting || resending}
                />
              </View>
            ) : null}
          </Card>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}
