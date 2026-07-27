import { sha256Hex } from "./sha256";

function normalizedEmailLower(email?: string | null): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || undefined;
}

function normalizedPhoneDigits(phone?: string | null): string | undefined {
  const digits = phone?.replace(/\D/g, "");
  return digits && digits.length >= 7 ? digits : undefined;
}

/**
 * Fingerprints what was KNOWN about a candidate (and, for a merge, the
 * subject too) at the moment a human made an identity-review decision.
 * Mirrors campaigns.ts#computeCampaignSnapshotHash: sort-before-hash,
 * omit absent optional fields rather than writing null (so old rows don't
 * retroactively drift when this code changes), and build the payload fresh
 * with the same key order every call.
 *
 * A "different" verdict is fingerprinted on THIN evidence (e.g. name only)
 * and must not bind forever: if the candidate later gains an email or
 * phone, the hash changes and the pair resurfaces in the review queue.
 */
export function computeIdentityEvidenceHash(input: {
  candidateName: string;
  candidateEmail?: string | null;
  candidatePhone?: string | null;
  subjectName?: string;
  subjectEmail?: string | null;
  subjectPhone?: string | null;
}): string {
  const payload: Record<string, unknown> = {
    candidateName: input.candidateName.trim(),
  };
  const candidateEmail = normalizedEmailLower(input.candidateEmail);
  if (candidateEmail) payload.candidateEmail = candidateEmail;
  const candidatePhone = normalizedPhoneDigits(input.candidatePhone);
  if (candidatePhone) payload.candidatePhone = candidatePhone;
  if (input.subjectName) payload.subjectName = input.subjectName.trim();
  const subjectEmail = normalizedEmailLower(input.subjectEmail);
  if (subjectEmail) payload.subjectEmail = subjectEmail;
  const subjectPhone = normalizedPhoneDigits(input.subjectPhone);
  if (subjectPhone) payload.subjectPhone = subjectPhone;
  return sha256Hex(JSON.stringify(payload));
}
