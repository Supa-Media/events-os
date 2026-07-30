/**
 * SSRF guard for `emailHtmlImport.ts`'s image re-hosting fetch — adversarial
 * review finding (2026-07-30): "No SSRF guard on the image fetch." Without
 * this, a pasted `<img src="http://169.254.169.254/latest/meta-data/...">`
 * (or any internal/loopback/link-local host) that happens to answer with an
 * `image/*` content-type gets its full response body stored to PUBLIC Convex
 * storage — a full-body exfil primitive dressed up as "importing a
 * newsletter image."
 *
 * `assertSafeImageUrl` rejects a URL whose host is (or DNS-resolves to) an
 * IP in a blocked range: loopback (127.0.0.0/8, ::1), private (10.0.0.0/8,
 * 172.16.0.0/12, 192.168.0.0/16), link-local (169.254.0.0/16, fe80::/10),
 * unique-local IPv6 (fc00::/7), and the unspecified/this-network address
 * (0.0.0.0/8). Both an IP-literal URL AND a hostname that RESOLVES into one
 * of those ranges are rejected — the latter closes the plain "just use a
 * hostname" bypass (`http://internal.corp.example/`) a literal-IP-only
 * check would miss.
 *
 * ── DNS-rebinding: documented residual risk, not fully closed ─────────────
 * This resolves the hostname ONCE, validates the result, and only THEN calls
 * `fetch(url)` — which re-resolves the SAME hostname independently. A DNS
 * server that answers a safe IP on the first lookup and an internal IP on
 * the second (within the same request's few-millisecond window) defeats this
 * check. Fully closing that gap means fetching via a PINNED IP (bypassing
 * `fetch`'s own resolution entirely), which for an `https://` URL breaks TLS
 * SNI/certificate validation against a raw IP without a custom
 * dispatcher/agent — meaningfully more machinery than this surface
 * currently carries. This is the documented trade-off: validate-then-fetch
 * (closes the overwhelming majority of real-world SSRF attempts — a
 * one-shot internal URL, a cloud metadata endpoint, a stale/static internal
 * hostname) rather than a fully rebinding-proof pinned fetch. Revisit if
 * this surface ever needs a stronger guarantee.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type SafeUrlCheck = { ok: true } | { ok: false; reason: string };

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

/** `[base, prefixBits]` CIDR blocks this guard refuses to fetch from. */
const BLOCKED_V4_RANGES: readonly [string, number][] = [
  ["127.0.0.0", 8], // loopback
  ["10.0.0.0", 8], // private
  ["172.16.0.0", 12], // private
  ["192.168.0.0", 16], // private
  ["169.254.0.0", 16], // link-local (also covers the cloud metadata IP)
  ["0.0.0.0", 8], // "this network" / unspecified
];

function isBlockedIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expand any valid IPv6 textual form (`::1`, `fe80::1`, fully written,
 *  `::ffff:1.2.3.4`, …) to its 8 sixteen-bit groups, or `null` if it doesn't
 *  parse — a caller that gets `null` back treats it as UNSAFE (fail closed),
 *  never as "not IPv6, so skip the check". */
function expandIpv6(ip: string): number[] | null {
  const addr = ip.split("%")[0]; // strip a zone id (`fe80::1%eth0`) if present
  const doubleColonParts = addr.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseGroups = (s: string): string[] => (s.length === 0 ? [] : s.split(":"));

  let groups: string[];
  if (doubleColonParts.length === 2) {
    const head = parseGroups(doubleColonParts[0]);
    const tail = parseGroups(doubleColonParts[1]);
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = addr.split(":");
  }
  if (groups.length !== 8) return null;

  const nums: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    nums.push(parseInt(g, 16));
  }
  return nums;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) return true; // unparseable — fail closed, never treat as safe
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  // ::1 — loopback.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true;
  }
  // fe80::/10 — link-local: top 10 bits are 1111111010, i.e. the first
  // group is in [0xFE80, 0xFEBF].
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true;
  // fc00::/7 — unique-local: top 7 bits are 1111110, i.e. the first group
  // is in [0xFC00, 0xFDFF].
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true;
  // ::ffff:a.b.c.d — an IPv4-mapped IPv6 address; a well-known SSRF-guard
  // bypass vector when only the "outer" address is ever checked. Extract
  // the embedded IPv4 and re-run the v4 check against it.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const mappedV4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isBlockedIpv4(mappedV4);
  }
  // :: — unspecified.
  if (groups.every((g) => g === 0)) return true;
  return false;
}

function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true; // not a recognizable IP literal at all — fail closed
}

/** Bound on how long a DNS lookup gets before this guard gives up and
 *  refuses the fetch — a hung/blackholed resolver must not hang the whole
 *  import the way an unbounded lookup would. */
const DNS_LOOKUP_TIMEOUT_MS = 3_000;

async function resolveAllIps(hostname: string): Promise<string[] | null> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("dns lookup timed out")), DNS_LOOKUP_TIMEOUT_MS),
    );
    const results = await Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]);
    return results.map((r) => r.address);
  } catch {
    return null;
  }
}

/**
 * Reject a URL that points (directly or via DNS) at a loopback/private/
 * link-local/reserved address. Called BEFORE every image fetch in
 * `emailHtmlImport.ts`. Fails CLOSED: any URL this can't confidently prove
 * safe (unparseable, a DNS lookup that fails/times out, a scheme other than
 * http/https) is rejected, never passed through on the assumption it's
 * probably fine.
 */
export async function assertSafeImageUrl(rawUrl: string): Promise<SafeUrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "unparseable URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `disallowed scheme ${parsed.protocol}` };
  }
  // `URL#hostname` brackets an IPv6 literal (`[::1]`) — strip that before
  // any IP-literal/DNS handling.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) {
    return { ok: false, reason: "no hostname" };
  }

  if (isIP(hostname)) {
    return isBlockedIp(hostname) ? { ok: false, reason: "blocked IP literal" } : { ok: true };
  }

  const ips = await resolveAllIps(hostname);
  if (!ips || ips.length === 0) {
    return { ok: false, reason: "DNS resolution failed" };
  }
  if (ips.some((ip) => isBlockedIp(ip))) {
    return { ok: false, reason: "hostname resolves to a blocked IP" };
  }
  return { ok: true };
}
