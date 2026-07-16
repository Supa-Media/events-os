import { defineConfig } from "@supa-media/core/config";

export default defineConfig({
  app: {
    name: "Chapter OS",
    slug: "events-os",
    scheme: "eventsos",
    bundleId: {
      production: "com.eventsos.mobile",
      staging: "com.eventsos.staging",
    },
  },

  multiTenant: true,
  tenantName: "chapters",

  auth: {
    providers: ["email"],
  },

  features: {
    phoneOtp: false,
    emailOtp: true,
    pushNotifications: true,
    chat: false,
    payments: false,
  },

  deployment: {
    strictness: "standard",
  },

  infrastructure: {
    vault: "Events",
    easProjectId: "4d2f4932-3e26-433f-a8db-6da4571dff18",
    expoOwner: "supa-media",
  },
});
