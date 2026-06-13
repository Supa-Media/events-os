import { createSupaAuth } from "@supa-media/convex/auth";

/**
 * Auth setup for Events OS.
 *
 * `createSupaAuth` wires up @convex-dev/auth with OTP providers. The enabled
 * methods and their transports (Resend for email, Twilio Verify for phone)
 * are configured here. See @supa-media/convex/auth for all options.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = createSupaAuth({
  appName: "Events OS",
  methods: ["email"],
  resend: {
    fromAddress: process.env.AUTH_EMAIL_FROM ?? "auth@events-os.com",
    emailSubject: (code) => `${code} is your Events OS code`,
  },
});
