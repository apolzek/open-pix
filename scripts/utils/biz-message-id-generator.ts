/**
 * Business Message Identifier (BizMsgIdr) Generator.
 *
 * Format (Catalogo SPI, <BizMsgIdr>/<MsgId>):
 *   M + ISPB of the sender [0-9A-Z]{8} + 23 alphanumeric = 32 chars
 * Example: M99999010abcDEF01234567890123456
 *
 * The id is case sensitive and must never repeat in any message the
 * participant sends to the SPI. The SPI examples reuse it as <MsgId>.
 */

import crypto from "node:crypto";
import { assertIspb } from "./endtoendid-generator.js";

const ALPHANUMERIC = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const BIZ_MSG_IDR_PATTERN = /^M[0-9A-Z]{8}[a-zA-Z0-9]{23}$/;

function randomAlphanumeric(length: number): string {
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ALPHANUMERIC[bytes[i] % ALPHANUMERIC.length];
  }
  return result;
}

export function generateBizMsgIdr(ispb: string): string {
  // M (1) + ISPB (8) + random (23) = 32 chars
  const id = `M${assertIspb(ispb)}${randomAlphanumeric(23)}`;

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
