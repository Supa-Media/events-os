/**
 * Pure scan-lock/normalize logic for `TicketScanner`. `onBarcodeScanned`
 * fires repeatedly while a QR stays in frame — without a lock the same code
 * would submit `checkInTicket` many times in a row. `shouldProcessScan`
 * decides whether a freshly-decoded code should actually be processed,
 * given the last code the caller locked on; the lock's cooldown (not a UI
 * button) governs re-scan timing, so an intentional re-scan of the SAME
 * ticket (e.g. after "Scan next") isn't blocked forever.
 */

/** The last code processed, and when — or `null` if nothing has been
 *  processed yet this session. */
export type ScanLock = { code: string; at: number } | null;

/** Ticket codes are `PW-XXXX-XXXX`; the QR encodes the same plain code the
 *  manual-entry field accepts. Trim + uppercase so a scan and a hand-typed
 *  entry normalize identically (mirrors `checkInTicket`'s own
 *  `code.trim().toUpperCase()`). */
export function normalizeScannedCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** How long a just-processed code stays locked out from re-processing. */
const DEFAULT_COOLDOWN_MS = 2000;

/**
 * True iff `code` should be processed now, given the last processed `lock`.
 * A different code is never blocked by another code's lock — only a repeat
 * of the SAME code within `cooldownMs` is suppressed.
 */
export function shouldProcessScan(
  lock: ScanLock,
  code: string,
  now: number,
  cooldownMs = DEFAULT_COOLDOWN_MS,
): boolean {
  if (!lock) return true;
  if (lock.code !== code) return true;
  return now - lock.at >= cooldownMs;
}
