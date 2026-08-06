#!/usr/bin/env node
/**
 * One-time uploader for the 2024 gear receipt documents.
 *
 * The receipt files are screenshots on the owner's machine, and nothing inside a
 * Convex deployment can read a local disk — so this script is the bridge: for each
 * row in `GEAR_2024_ORDER_ROWS` it mints an upload URL, POSTs the file, and collects
 * the resulting `storageId`. It does NOT write to the database; it prints (and
 * optionally applies) the `uploads` payload for
 * `gear2024Split:attachGear2024Receipts`, which is the only thing that creates
 * `receipts` rows.
 *
 * Usage — from the repo root, with the receipts folder as the only required arg:
 *
 *   node scripts/upload-gear2024-receipts.mjs --dir "$HOME/Desktop/2024 Equipment"
 *   node scripts/upload-gear2024-receipts.mjs --dir ... --prod          # target prod
 *   node scripts/upload-gear2024-receipts.mjs --dir ... --prod --apply  # + attach
 *
 * Without `--apply` it uploads the files and prints the payload, leaving the attach
 * step to you (the attach runner is itself dry-run-by-default, so the safe sequence
 * is: run this, eyeball the payload, then call the runner with `execute: true`).
 *
 * Re-running is safe but WASTEFUL: it uploads fresh copies of each file. The attach
 * runner skips any transaction that already has a receipt, so the orphaned blobs are
 * inert — still, prefer resuming with the printed payload over re-uploading.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The dataset is TypeScript inside apps/convex; rather than pull in a transpiler for
// a one-shot script, the (orderRef → file) mapping is duplicated here. It is asserted
// against the real dataset by `tests/gear2024Split.test.ts`, which fails if the two
// ever drift.
const RECEIPT_FILES = [
  ["114-9890645-7982630", "Screenshot 2026-08-05 at 9.11.28 PM.png"],
  ["114-5352971-4525852", "Screenshot 2026-08-05 at 9.10.25 PM.png"],
  ["113-9783604-6351443", "Screenshot 2026-08-05 at 9.09.42 PM.png"],
  ["114-9720035-4663454", "Screenshot 2026-08-05 at 9.05.19 PM.png"],
  ["114-2921193-5253036", "Screenshot 2026-08-05 at 9.07.25 PM.png"],
  ["SW-42245906", "Screenshot 2026-08-05 at 9.14.57 PM.png"],
  ["113-0050781-0511435", "Screenshot 2026-08-05 at 8.57.45 PM.png"],
  ["113-8295064-4780255", "Screenshot 2026-08-05 at 8.57.11 PM.png"],
  ["113-8870418-2398600", "Screenshot 2026-08-05 at 8.57.22 PM.png"],
  ["113-3344077-9105060", "Screenshot 2026-08-05 at 8.57.33 PM.png"],
  ["114-0656524-2178659", "Screenshot 2026-08-05 at 8.56.06 PM.png"],
  ["113-8159100-9204204", "Screenshot 2026-08-05 at 8.55.21 PM.png"],
  ["113-3535920-5449002", "Screenshot 2026-08-05 at 8.54.56 PM.png"],
  ["113-5055024-2268266", "Screenshot 2026-08-05 at 8.54.40 PM.png"],
  ["114-3211256-5253822", "Screenshot 2026-08-05 at 8.54.20 PM.png"],
  ["114-2172407-9957842", "Screenshot 2026-08-05 at 8.53.10 PM.png"],
  ["113-3096883-7982617", "Screenshot 2026-08-05 at 8.53.38 PM.png"],
  ["113-7023722-7963431", "Screenshot 2026-08-05 at 8.54.03 PM.png"],
];

/**
 * Fold a filename to a comparison key: Unicode-normalized, with every kind of
 * space collapsed to a plain one, lowercased.
 *
 * macOS names its screenshots with a NARROW NO-BREAK SPACE (U+202F) before AM/PM —
 * visually identical to a normal space, so the names in `RECEIPT_FILES` (typed with
 * ordinary spaces) miss by one byte and `readFile` throws ENOENT on a file that is
 * plainly sitting right there. Matching on this key instead of the raw string makes
 * the lookup immune to that and to NFC/NFD differences, which HFS+/APFS also
 * introduce.
 */
function fileKey(name) {
  return name.normalize("NFC").replace(/\s/gu, " ").toLowerCase();
}

function parseArgs(argv) {
  const args = { dir: null, prod: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") args.dir = argv[++i];
    else if (argv[i] === "--prod") args.prod = true;
    else if (argv[i] === "--apply") args.apply = true;
  }
  if (!args.dir) {
    console.error('Missing --dir. Example: --dir "$HOME/Desktop/2024 Equipment"');
    process.exit(1);
  }
  return args;
}

/** Run a Convex function through the CLI and parse its JSON result. The CLI carries
 *  the deployment admin key, which is what lets a script reach an internal function. */
async function convexRun(name, payload, prod) {
  const argv = ["convex", "run", name];
  if (payload !== undefined) argv.push(JSON.stringify(payload));
  if (prod) argv.push("--prod");
  const { stdout } = await execFileAsync("npx", argv, {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    // `convex run` echoes a bare quoted string for a string return.
    return text.replace(/^"|"$/g, "");
  }
}

async function main() {
  const { dir, prod, apply } = parseArgs(process.argv.slice(2));
  console.log(
    `Uploading ${RECEIPT_FILES.length} receipts from ${dir} to ${prod ? "PROD" : "dev"}…`,
  );

  // Resolve each wanted name against what's actually on disk (see `fileKey`).
  const onDisk = new Map(
    (await readdir(dir)).map((name) => [fileKey(name), name]),
  );
  const missing = RECEIPT_FILES.filter(([, f]) => !onDisk.has(fileKey(f)));
  if (missing.length) {
    console.error(`Missing ${missing.length} receipt file(s) in ${dir}:`);
    for (const [orderRef, f] of missing) console.error(`  ${orderRef}: ${f}`);
    process.exit(1);
  }

  const uploads = [];
  for (const [orderRef, file] of RECEIPT_FILES) {
    const path = join(dir, onDisk.get(fileKey(file)));
    const bytes = await readFile(path);
    const uploadUrl = await convexRun(
      "gear2024Split:generateGear2024UploadUrl",
      undefined,
      prod,
    );
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: bytes,
    });
    if (!res.ok) {
      throw new Error(`Upload failed for ${orderRef} (${res.status} ${res.statusText})`);
    }
    const { storageId } = await res.json();
    uploads.push({ orderRef, storageId, filename: basename(path) });
    console.log(`  ✓ ${orderRef} → ${storageId}`);
  }

  console.log(`\nPayload for gear2024Split:attachGear2024Receipts:\n`);
  console.log(JSON.stringify({ uploads, execute: true }, null, 2));

  if (apply) {
    const result = await convexRun(
      "gear2024Split:attachGear2024Receipts",
      { uploads, execute: true },
      prod,
    );
    console.log(`\nAttached:`, result);
  } else {
    console.log(
      `\nNot applied (no --apply). Attach with the payload above once it looks right.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
