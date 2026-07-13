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
    vault: "EventsOS",
    easProjectId: "YOUR_EAS_PROJECT_ID",
    expoOwner: "supa-media",
  },
});
