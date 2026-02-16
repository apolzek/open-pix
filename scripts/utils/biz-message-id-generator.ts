/**
 * Business Message Identifier (BizMsgIdr) Generator.
 *
 * Format: M{ISPB 8 digits}{random alphanumeric} = 32 chars total
 * Example: M12345678abcDEF01234567890123456
 *
 * The BizMsgIdr uniquely identifies each ISO 20022 business message envelope.
 * Each message sent to ICOM must have a unique BizMsgIdr.
 */

const ALPHANUMERIC = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomAlphanumeric(length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ALPHANUMERIC[Math.floor(Math.random() * ALPHANUMERIC.length)];
  }
  return result;
}

export function generateBizMsgIdr(ispb: string): string {
  const ispbPadded = ispb.padStart(8, "0");
  // M (1) + ISPB (8) + random (23) = 32 chars
  const randomPart = randomAlphanumeric(23);
  const id = `M${ispbPadded}${randomPart}`;

  if (id.length !== 32) {
    throw new Error(`BizMsgIdr must be 32 chars, got ${id.length}: ${id}`);
  }

  return id;
}

export function parseBizMsgIdr(id: string): {
  prefix: string;
  ispb: string;
  random: string;
} {
  if (id.length !== 32) {
    throw new Error(`BizMsgIdr must be 32 chars, got ${id.length}`);
  }

  return {
    prefix: id[0],
    ispb: id.slice(1, 9),
    random: id.slice(9),
  };
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const ispb = process.argv[2] || "12345678";
  const count = parseInt(process.argv[3] || "5", 10);

  console.log(`=== BizMsgIdr Generator (ISPB: ${ispb}) ===\n`);

  for (let i = 0; i < count; i++) {
    const id = generateBizMsgIdr(ispb);
    console.log(`  ${id}`);
  }
}
