/**
 * Turn a raw Convex client error message into something a person can read.
 *
 * A plain `Error` thrown on the server reaches the client as
 * "[CONVEX A(auth:signIn)] [Request ID: ce88…] Server Error\n  Called by client"
 * in prod (the reason is redacted), or with "Uncaught Error: <reason>" and a
 * stack in dev. Neither should be shown verbatim. Returns the reason when one
 * survived, `null` when it was redacted, and any other message unchanged.
 * Kept free of react-native so it can be unit-tested in node.
 */
export function cleanConvexMessage(message: string): string | null {
  if (!message.startsWith("[CONVEX ")) return message;
  const body = message
    .replace(/^\[CONVEX [^\]]*\]\s*/, "")
    .replace(/^\[Request ID: [^\]]*\]\s*/, "")
    .split("\n")[0]
    .trim();
  if (!body || body === "Server Error") return null;
  return body.replace(/^Uncaught \w*Error:\s*/, "").trim() || null;
}
