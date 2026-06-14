import { useState } from "react";
import { View, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useAuthActions } from "@convex-dev/auth/react";
import { Card, Button, TextField, Icon } from "../../components/ui";
import { colors } from "../../lib/theme";

const ALLOWED_DOMAIN = "publicworship.life";

/** True iff the trimmed email is on the allowed domain (case-insensitive). */
function isAllowedEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);
}

/**
 * OTP login for Events OS.
 *
 * Two steps: request a one-time code for the email, then verify it. Access is
 * limited to @publicworship.life accounts; we validate that client-side before
 * requesting a code (the backend enforces it on every data function too).
 */
export default function LoginScreen() {
  const { signIn } = useAuthActions();
  const router = useRouter();

  const [step, setStep] = useState<"request" | "verify">("request");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode() {
    const email = identifier.trim();
    if (!isAllowedEmail(email)) {
      setError("Only publicworship.life emails can access Events OS.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await signIn("email", { email });
      setStep("verify");
    } catch (e) {
      setError("Couldn't send your code. Check your email and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode() {
    setError(null);
    setSubmitting(true);
    try {
      await signIn("email", {
        email: identifier.trim(),
        code: code.trim(),
      });
      router.replace("/");
    } catch (e) {
      setError("That code didn't work. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <View className="flex-1 items-center justify-center px-6">
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

          <Card padding="lg">
            <Text className="font-display text-2xl text-ink">
              {step === "request" ? "Sign in" : "Check your email"}
            </Text>
            <Text className="mb-5 mt-1 text-sm text-muted">
              {step === "request"
                ? "We'll email you a one-time code."
                : `Enter the code sent to ${identifier.trim()}.`}
            </Text>

            {step === "request" ? (
              <TextField
                label="Email"
                hint={`Use your @${ALLOWED_DOMAIN} email.`}
                value={identifier}
                onChangeText={(t) => {
                  setIdentifier(t);
                  if (error) setError(null);
                }}
                placeholder={`you@${ALLOWED_DOMAIN}`}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete="email"
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
              disabled={step === "request" ? !identifier.trim() : !code.trim()}
              className="w-full"
            />

            {step === "verify" ? (
              <View className="mt-2 items-center">
                <Button
                  title="Use a different email"
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    setStep("request");
                    setCode("");
                    setError(null);
                  }}
                  disabled={submitting}
                />
              </View>
            ) : null}
          </Card>
        </View>
      </View>
    </SafeAreaView>
  );
}
