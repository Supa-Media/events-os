#!/usr/bin/env node
/**
 * One-time uploader for the genesis cleanup's source documents.
 *
 * The documents are scattered across the owner's Desktop, Documents and Downloads,
 * and nothing inside a Convex deployment can read a local disk — so this script is
 * the bridge. For each row it mints an upload URL, POSTs the file, and collects the
 * `storageId`. It writes nothing to the database; `genesisCleanup:attachCleanupDocuments`
 * does that, and decides per row whether the file is a RECEIPT or exception EVIDENCE.
 *
 * Usage — from the repo root:
 *   node scripts/upload-cleanup-docs.mjs --prod           # upload, print the payload
 *   node scripts/upload-cleanup-docs.mjs --prod --apply   # …and attach
 *
 * Folders are searched in order, so a basename need only be unique across them. Pass
 * `--dir <path>` (repeatable) to override the defaults.
 *
 * Re-running is safe but WASTEFUL: it uploads fresh copies. The attach runner skips
 * rows that already have their document, so orphaned blobs are inert — prefer
 * resuming from the printed payload.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DIRS = [
  join(homedir(), "Desktop", "2024 Equipment"),
  join(homedir(), "Desktop", "2025 Amazon"),
  join(homedir(), "Documents", "Ubers"),
  join(homedir(), "Documents", "Apple Cashes"),
  join(homedir(), "Documents", "Chick-fil-a"),
  join(homedir(), "Downloads"),
];

/**
 * key → source filename. `key` is the transaction's `externalId`.
 *
 * The dataset lives in TypeScript under apps/convex and this script can't import it,
 * so the mapping is duplicated here. `tests/genesisCleanup.test.ts` asserts the two
 * agree and fails if they ever drift.
 */
const DOCS = [
  // New transactions this cleanup creates.
  ["genesis-cleanup:amz:113-2546312-7227436", "Screenshot 2026-08-05 at 11.20.46 PM.png"],
  ["genesis-cleanup:amz:113-8488100-7337862", "Screenshot 2026-08-05 at 11.45.30 PM.png"],
  ["genesis-cleanup:amz:114-5812487-2917020", "Screenshot 2026-08-05 at 11.44.30 PM.png"],
  ["genesis-cleanup:amz:113-7755495-5208264", "Screenshot 2026-08-05 at 11.44.10 PM.png"],
  ["genesis-cleanup:amz:113-5878480-0532267", "Screenshot 2026-08-05 at 11.42.23 PM.png"],
  ["genesis-cleanup:amz:113-2826417-4777857", "Screenshot 2026-08-05 at 11.42.06 PM.png"],
  ["genesis-cleanup:amz:112-1015391-5033821", "Screenshot 2026-08-05 at 11.35.46 PM.png"],
  ["genesis-cleanup:amz:111-6636873-5273804", "Screenshot 2026-08-05 at 11.33.52 PM.png"],
  ["genesis-cleanup:uber:2024-11-02:out", "IMG_1428.png"],
  ["genesis-cleanup:uber:2024-11-02:back", "IMG_1429.png"],
  ["genesis-cleanup:uber:2025-02-05:out", "IMG_1426.png"],
  ["genesis-cleanup:uber:2025-02-05:back", "IMG_1427.png"],
  ["genesis-cleanup:uber:2025-06-14:out", "IMG_1423.png"],
  ["genesis-cleanup:uber:2025-06-14:back", "IMG_1422.png"],
  ["genesis-cleanup:uber:2025-09-20:out", "IMG_1431.png"],
  ["genesis-cleanup:uber:2025-09-20:back", "IMG_1432.png"],
  // Corrected rows.
  ["genesis-inkind-exp:buy25:3", "Screenshot 2026-08-05 at 11.46.08 PM.png"],
  ["genesis-inkind-exp:buy25:22", "Screenshot 2026-08-05 at 11.45.19 PM.png"],
  ["genesis-inkind-exp:buy25:2", "Screenshot 2026-08-05 at 11.36.24 PM.png"],
  ["genesis-inkind-exp:buy25:25", "Screenshot 2026-08-05 at 11.44.52 PM.png"],
  // Rows that only needed the document.
  ["genesis-inkind-exp:buy25:9", "Screenshot 2026-08-05 at 9.48.48 PM.png"],
  ["genesis-inkind-exp:buy25:0", "Screenshot 2026-08-05 at 11.46.36 PM.png"],
  ["genesis-inkind-exp:buy25:1", "Screenshot 2026-08-05 at 11.46.20 PM.png"],
  ["genesis-inkind-exp:buy25:24", "Screenshot 2026-08-05 at 11.34.10 PM.png"],
  ["genesis-inkind-exp:buy25:19", "IMG_1424.png"],
  ["genesis-inkind-exp:buy25:20", "IMG_1425.png"],
  ["genesis-inkind-exp:buy25:12", "IMG_1430.png"],
  ["genesis-inkind-exp:buy25:30", "Instacart Receipt for Order #061317202447354413288.pdf"],
  ["genesis-inkind-exp:buy25:23", "IMG_1436.png"],
  // EVIDENCE, not receipts — Apple Cash screenshots. The attach runner routes these
  // onto the receipt exception instead of the transaction.
  ["genesis-inkind-exp:buy25:21", "IMG_1418.png"],
  ["genesis-inkind-exp:buy25:28", "IMG_1421.jpeg"],
];

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

/**
 * Fold a filename to a comparison key: NFC-normalized, every kind of space collapsed
 * to a plain one, lowercased. macOS names screenshots with a NARROW NO-BREAK SPACE
 * (U+202F) before AM/PM — visually identical to a normal space, so a literal typed
 * with an ordinary space misses by one byte and `readFile` throws ENOENT on a file
 * that is plainly there. This also absorbs the NFC/NFD difference APFS introduces.
 */
function fileKey(name) {
  return name.normalize("NFC").replace(/\s/gu, " ").toLowerCase();
}

function parseArgs(argv) {
  const args = { dirs: [], prod: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") args.dirs.push(argv[++i]);
    else if (argv[i] === "--prod") args.prod = true;
    else if (argv[i] === "--apply") args.apply = true;
  }
  if (!args.dirs.length) args.dirs = DEFAULT_DIRS;
  return args;
}

/** Run a Convex function through the CLI, which carries the deployment admin key —
 *  what lets a script reach an internal function. */
async function convexRun(name, payload, prod) {
  const argv = ["convex", "run", name];
  if (payload !== undefined) argv.push(JSON.stringify(payload));
  if (prod) argv.push("--prod");
  const { stdout } = await execFileAsync("npx", argv, {
    cwd: process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
  });
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    return text.replace(/^"|"$/g, "");
  }
}

async function main() {
  const { dirs, prod, apply } = parseArgs(process.argv.slice(2));

  // Index every candidate folder once, first match wins.
  const onDisk = new Map();
  for (const dir of dirs) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue; // a folder that isn't there is not an error; the file may be elsewhere
    }
    for (const name of names) {
      const k = fileKey(name);
      if (!onDisk.has(k)) onDisk.set(k, join(dir, name));
    }
  }

  const missing = DOCS.filter(([, f]) => !onDisk.has(fileKey(f)));
  if (missing.length) {
    console.error(`Missing ${missing.length} document(s). Searched:`);
    for (const d of dirs) console.error(`  ${d}`);
    for (const [key, f] of missing) console.error(`  ✗ ${key}: ${f}`);
    process.exit(1);
  }

  console.log(`Uploading ${DOCS.length} documents to ${prod ? "PROD" : "dev"}…`);
  const uploads = [];
  for (const [key, file] of DOCS) {
    const path = onDisk.get(fileKey(file));
    const bytes = await readFile(path);
    const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const uploadUrl = await convexRun(
      "genesisCleanup:generateCleanupUploadUrl",
      undefined,
      prod,
    );
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    if (!res.ok) {
      throw new Error(`Upload failed for ${key} (${res.status} ${res.statusText})`);
    }
    const { storageId } = await res.json();
    uploads.push({ key, storageId, filename: basename(path) });
    console.log(`  ✓ ${key}`);
  }

  console.log(`\nPayload for genesisCleanup:attachCleanupDocuments:\n`);
  console.log(JSON.stringify({ uploads, execute: true }, null, 2));

  if (apply) {
    const result = await convexRun(
      "genesisCleanup:attachCleanupDocuments",
      { uploads, execute: true },
      prod,
    );
    console.log(`\nAttached:`, result);
  } else {
    console.log(`\nNot applied (no --apply).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
