export default {
  providers: [
    {
      // The local/cloud Convex deployment's site URL is the JWT issuer.
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
