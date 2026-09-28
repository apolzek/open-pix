/**
 * EndToEndId (E2E ID) Generator for Pix transactions.
 *
 * Format (Catalogo de Mensagens do SPI, pacs.008 <EndToEndId>):
 *   E + ISPB [0-9A-Z]{8} + yyyyMMddHHmm (UTC) + 11 alphanumeric = 32 chars
 * Example: E9999901020260928143512345678900
 *
 * - The timestamp is in UTC, not Brasilia time. The SPI accepts a tolerance
 *   of 12 hours to the past or future relative to its processing time.
 * - The ISPB part accepts uppercase letters (e.g. Bacen's virtual participants
 *   99999A03 and 99999A04 in homologation).
 * - The 11-char suffix must be unique within each yyyyMMddHHmm.
 *
 * The return identifier of a pacs.004 (<RtrId>) uses the same layout with a
 * 'D' prefix. It is a separate field; <OrgnlEndToEndId> keeps the original 'E' id.
 */

import crypto from "node:crypto";

const ALPHANUMERIC = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const ISPB_PATTERN = /^[0-9A-Z]{8}$/;
export const END_TO_END_ID_PATTERN = /^E[0-9A-Z]{8}\d{4}[01]\d[0-3]\d[0-2]\d[0-5]\d[a-zA-Z0-9]{11}$/;
export const RETURN_ID_PATTERN = /^D[0-9A-Z]{8}\d{4}[01]\d[0-3]\d[0-2]\d[0-5]\d[a-zA-Z0-9]{11}$/;

function randomAlphanumeric(length: number): string {
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ALPHANUMERIC[bytes[i] % ALPHANUMERIC.length];
  }
  return result;
}

function padZero(n: number, len: number): string {
  return String(n).padStart(len, "0");
}

export function assertIspb(ispb: string): string {
  if (!ISPB_PATTERN.test(ispb)) {
    throw new Error(`ISPB must match [0-9A-Z]{8}, got "${ispb}"`);
  }
  return ispb;
}

/** yyyyMMddHHmm in UTC. */
export function utcStamp(d: Date = new Date()): string {
  return (
    `${d.getUTCFullYear()}` +
    padZero(d.getUTCMonth() + 1, 2) +
    padZero(d.getUTCDate(), 2) +
    padZero(d.getUTCHours(), 2) +
    padZero(d.getUTCMinutes(), 2)
  );
}

function build(prefix: "E" | "D", ispb: string, date?: Date): string {
  const id = `${prefix}${assertIspb(ispb)}${utcStamp(date)}${randomAlphanumeric(11)}`;
  if (id.length !== 32) {
    throw new Error(`Id must be 32 chars, got ${id.length}: ${id}`);
  }
  return id;
}

export function generateEndToEndId(ispb: string, date?: Date): string {
  return build("E", ispb, date);
}

/**
 * Generate a return identifier (<RtrId>) for a pacs.004, prefixed with 'D'.
 * The ISPB is the one of the participant that sends the return.
 */
export function generateDevolutionEndToEndId(ispb: string, date?: Date): string {
  return build("D", ispb, date);
}

export function parseEndToEndId(e2eid: string): {
  prefix: string;
  ispb: string;
  date: string;
  time: string;
  random: string;
} {
  if (!END_TO_END_ID_PATTERN.test(e2eid) && !RETURN_ID_PATTERN.test(e2eid)) {
    throw new Error(`Invalid EndToEndId/RtrId: ${e2eid}`);
  }

  return {
    prefix: e2eid[0],
    ispb: e2eid.slice(1, 9),
    date: e2eid.slice(9, 17),
    time: e2eid.slice(17, 21),
    random: e2eid.slice(21),
  };
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const ispb = process.argv[2] || "12345678";
  const count = parseInt(process.argv[3] || "5", 10);

  console.log(`=== E2E ID Generator (ISPB: ${ispb}, UTC) ===\n`);

  console.log("Payment E2E IDs:");
  for (let i = 0; i < count; i++) {
    const id = generateEndToEndId(ispb);
    const parsed = parseEndToEndId(id);
    console.log(`  ${id} (ISPB: ${parsed.ispb}, date: ${parsed.date}, time: ${parsed.time} UTC)`);
  }

  console.log("\nReturn ids (pacs.004 RtrId):");
  for (let i = 0; i < count; i++) {
    const id = generateDevolutionEndToEndId(ispb);
    console.log(`  ${id}`);
  }
}
