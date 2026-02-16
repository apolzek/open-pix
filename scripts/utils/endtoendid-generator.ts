/**
 * EndToEndId (E2E ID) Generator for Pix transactions.
 *
 * Format: E{ISPB 8 digits}{YYYYMMDD}{HHMM}{random alphanumeric} = 32 chars total
 * Example: E1234567820240115143500000000001A
 *
 * The E2E ID uniquely identifies each Pix transaction across the entire SPI network.
 * Must be exactly 32 characters, starting with 'E'.
 */

const ALPHANUMERIC = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomAlphanumeric(length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ALPHANUMERIC[Math.floor(Math.random() * ALPHANUMERIC.length)];
  }
  return result;
}

function padZero(n: number, len: number): string {
  return String(n).padStart(len, "0");
}

export function generateEndToEndId(ispb: string, date?: Date): string {
  const d = date || new Date();
  const ispbPadded = ispb.padStart(8, "0");

  const dateStr =
    `${d.getFullYear()}` +
    padZero(d.getMonth() + 1, 2) +
    padZero(d.getDate(), 2);

  const timeStr = padZero(d.getHours(), 2) + padZero(d.getMinutes(), 2);

  // E (1) + ISPB (8) + date (8) + time (4) = 21 chars, need 11 more random
  const randomPart = randomAlphanumeric(11);

  const e2eid = `E${ispbPadded}${dateStr}${timeStr}${randomPart}`;

  if (e2eid.length !== 32) {
    throw new Error(`E2E ID must be 32 chars, got ${e2eid.length}: ${e2eid}`);
  }

  return e2eid;
}

/**
 * Generate a devolution E2E ID (starts with 'D' instead of 'E').
 * Used for pacs.004 devolution messages.
 */
export function generateDevolutionEndToEndId(ispb: string, date?: Date): string {
  const e2eid = generateEndToEndId(ispb, date);
  return "D" + e2eid.slice(1);
}

export function parseEndToEndId(e2eid: string): {
  prefix: string;
  ispb: string;
  date: string;
  time: string;
  random: string;
} {
  if (e2eid.length !== 32) {
    throw new Error(`E2E ID must be 32 chars, got ${e2eid.length}`);
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

  console.log(`=== E2E ID Generator (ISPB: ${ispb}) ===\n`);

  console.log("Payment E2E IDs:");
  for (let i = 0; i < count; i++) {
    const id = generateEndToEndId(ispb);
    const parsed = parseEndToEndId(id);
    console.log(`  ${id} (ISPB: ${parsed.ispb}, date: ${parsed.date}, time: ${parsed.time})`);
  }

  console.log("\nDevolution E2E IDs:");
  for (let i = 0; i < count; i++) {
    const id = generateDevolutionEndToEndId(ispb);
    console.log(`  ${id}`);
  }
}
