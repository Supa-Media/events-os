import { useEffect } from "react";
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import { Card, Button, TextField, Icon, ToastView } from "../../components/ui";
import { colors } from "../../lib/theme";
import { ALLOWED_DOMAIN } from "./login.helpers";
import { useEmailOtpLogin } from "./useEmailOtpLogin";

/**
 * OTP login for Events OS.
 *
 * Members sign in with just their username (we build the @publicworship.life
 * address). Invited guests — emails seeded into Convex's allowlist — switch to
 * guest mode and enter their full email; the OTP flow is otherwise identical.
 * All form state and logic live in `useEmailOtpLogin`; this screen just renders.
 */
export default function LoginScreen() {
  const { isAuthenticated } = useConvexAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const login = useEmailOtpLogin();
  const { step, mode } = login;

  // Navigate only once Convex reports the session is live. `signIn` resolves a
  // render or two BEFORE `isAuthenticated` flips, so replacing the route inside
  // verifyCode raced the (app) auth guard — it saw `!isAuthenticated` and
  // bounced straight back to a fresh login (the "log in twice" bug). Driving the
  // redirect off auth state instead means we leave /login exactly once, after
  // the guard will let us through.
  useEffect(() => {
    if (isAuthenticated) router.replace("/");
  }, [isAuthenticated, router]);

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

          {login.toast ? (
            <View className="mb-3">
              <ToastView toast={login.toast} onDismiss={login.dismiss} />
            </View>
          ) : null}

          <Card padding="lg">
            <Text className="font-display text-2xl text-ink">
              {step === "request" ? "Sign in" : "Check your email"}
            </Text>
            <Text className="mb-5 mt-1 text-sm text-muted">
              {step === "request"
                ? "We'll email you a one-time code."
                : `Enter the code sent to ${login.email}.`}
            </Text>

            {step === "request" ? (
              mode === "guest" ? (
                <TextField
                  label="Email"
                  hint="Use the email you were invited with."
                  value={login.guestEmail}
                  onChangeText={login.changeGuestEmail}
                  placeholder="you@example.com"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  autoComplete="email"
                  editable={!login.submitting}
                  onSubmitEditing={login.requestCode}
                  returnKeyType="go"
                />
              ) : (
                <TextField
                  label="Username"
                  hint={`Your username is the first part of your @${ALLOWED_DOMAIN} email.`}
                  value={login.username}
                  onChangeText={login.changeUsername}
                  placeholder="you"
                  suffix={`@${ALLOWED_DOMAIN}`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  autoComplete="username"
                  editable={!login.submitting}
                  onSubmitEditing={login.requestCode}
                  returnKeyType="go"
                />
              )
            ) : (
              <TextField
                label="Verification code"
                value={login.code}
                onChangeText={login.changeCode}
                placeholder="123456"
                keyboardType="number-pad"
                autoComplete="one-time-code"
                editable={!login.submitting}
                onSubmitEditing={login.verifyCode}
                returnKeyType="go"
              />
            )}

            {login.error ? (
              <View className="mb-3 flex-row items-center gap-1.5">
                <Icon name="alert-circle" size={14} color={colors.danger} />
                <Text className="flex-1 text-sm text-danger">{login.error}</Text>
              </View>
            ) : null}

            <Button
              title={step === "request" ? "Send code" : "Verify"}
              onPress={step === "request" ? login.requestCode : login.verifyCode}
              loading={login.submitting}
              disabled={
                step === "request" ? !login.canSubmitRequest : !login.code.trim()
              }
              className="w-full"
            />

            {step === "request" ? (
              <View className="mt-2 items-center">
                <Button
                  title={
                    mode === "guest"
                      ? `Sign in with a @${ALLOWED_DOMAIN} account`
                      : "Not a member? Sign in as a guest"
                  }
                  variant="ghost"
                  size="sm"
                  onPress={login.toggleMode}
                  disabled={login.submitting}
                />
              </View>
            ) : null}

            {step === "verify" ? (
              <View className="mt-2 items-center gap-0.5">
                <Button
                  title="Resend code"
                  variant="ghost"
                  size="sm"
                  icon="refresh-cw"
                  loading={login.resending}
                  onPress={login.resendCode}
                  disabled={login.submitting || login.resending}
                />
                <Button
                  title={
                    mode === "guest"
                      ? "Use a different email"
                      : "Use a different username"
                  }
                  variant="ghost"
                  size="sm"
                  onPress={login.backToRequest}
                  disabled={login.submitting || login.resending}
                />
              </View>
            ) : null}
          </Card>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}
