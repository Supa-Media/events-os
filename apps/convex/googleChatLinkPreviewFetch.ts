"use node";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import type { OgMetadata } from "./lib/googleChatLinkPreview";

const USER_AGENT =
  "PublicWorshipChapterOSLinkPreview/1.0 (+https://publicworship.life)";
const TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 4;
const MAX_BYTES = 256 * 1024;

export const fetchOgMetadata = internalAction({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => fetchOg(url),
});

export async function fetchOg(url: string): Promise<OgMetadata> {
  let current = requireSafeUrl(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await assertPublicDestination(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": USER_AGENT,
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (isRedirect(response.status)) {
      if (redirects === MAX_REDIRECTS) {
        throw new Error("Too many redirects");
      }
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect missing Location header");
      current = requireSafeUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!isHtmlContentType(contentType)) {
      throw new Error("Response is not HTML");
    }
    const html = await readCappedText(response, MAX_BYTES);
    return parseOgMetadata(html, current.toString());
  }
  throw new Error("Too many redirects");
}

export function parseOgMetadata(html: string, finalUrl: string): OgMetadata {
  const url = new URL(finalUrl);
  const meta = collectMeta(html);
  const title =
    meta.get("og:title") ??
    textContent(firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i)) ??
    finalUrl;
  const description =
    meta.get("og:description") ?? meta.get("description") ?? "";
  const image = absolutize(meta.get("og:image") ?? "", url);
  const canonicalUrl = absolutize(meta.get("og:url") ?? "", url) || finalUrl;
  const siteName = meta.get("og:site_name") ?? url.hostname;
  return {
    title: decodeEntities(title).trim() || finalUrl,
    description: decodeEntities(description).trim(),
    image,
    url: canonicalUrl,
    siteName: decodeEntities(siteName).trim() || url.hostname,
  };
}

export function requireSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be previewed");
  }
  if (url.username || url.password) {
    throw new Error("Credentialed URLs cannot be previewed");
  }
  return url;
}

export async function assertPublicDestination(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0"
  ) {
    throw new Error("Local URLs cannot be previewed");
  }

  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new Error("Private IPs cannot be previewed");
    }
    return;
  }

  const records = await lookup(hostname, { all: true, verbatim: false });
  if (records.length === 0) throw new Error("Hostname did not resolve");
  for (const record of records) {
    if (!isPublicIp(record.address)) {
      throw new Error("Hostname resolves to a private IP");
    }
  }
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fe80:")) return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  return true;
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isHtmlContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return (
    value === "" ||
    value.includes("text/html") ||
    value.includes("application/xhtml+xml")
  );
}

async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Response body too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function collectMeta(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const tagPattern = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[0];
    const key =
      attr(tag, "property")?.toLowerCase() ?? attr(tag, "name")?.toLowerCase();
    const content = attr(tag, "content");
    if (key && content && !out.has(key)) out.set(key, content);
  }
  return out;
}

function attr(tag: string, name: string): string | null {
  const pattern = new RegExp(
    String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))`,
    "i",
  );
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function firstMatch(html: string, pattern: RegExp): string | null {
  return pattern.exec(html)?.[1] ?? null;
}

function textContent(value: string | null): string | null {
  if (value == null) return null;
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function absolutize(value: string, base: URL): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    );
}
