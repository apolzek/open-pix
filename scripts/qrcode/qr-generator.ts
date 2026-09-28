/**
 * Pix QR Code Generator (BR Code).
 *
 * Follows the Manual de Padroes para Iniciacao do Pix 2.10.0, section 2:
 * - Static QR: Pix key in 26-01, optional amount (54), optional free text
 *   (infoAdicional, 26-02), optional withdrawal facilitator (fss, 26-03) and
 *   txid in 62-05 ("***" when there is none). Reusable.
 * - Dynamic QR: payload URL in 26-25 (no "https://"), amount and txid come
 *   from the JSON behind the URL. 62-05 carries "***".
 *   COB (immediate) and COBV (with due date) differ only in the URL payload.
 * - ID 01 = "12" is optional and means the QR must not be paid more than
 *   once. Having an amount does not make a QR single-use.
 * - The key, infoAdicional and fss share the 99 chars of template 26.
 *
 * Usage:
 *   npx tsx scripts/qrcode/qr-generator.ts static <pixKey> [amount]
 *   npx tsx scripts/qrcode/qr-generator.ts cob <pixUrl>
 *   npx tsx scripts/qrcode/qr-generator.ts cobv <pixUrl>
 */

import { PIX_GUI, MAX_TEMPLATE_LENGTH, tlv, withCrc } from "./emv.js";

export type QrType = "static" | "cob" | "cobv";

export interface StaticQrParams {
  pixKey: string;
  /** Shown only as fallback: the payer app displays the name from the DICT. */
  merchantName: string;
  merchantCity: string;
  amount?: number;
  /** infoAdicional (26-02). Throws if key + text exceed the template size. */
  description?: string;
  /** ISPB of the withdrawal facilitator (Pix Saque). */
  fss?: string;
  /** txid: up to 25 chars [a-zA-Z0-9]. */
  txId?: string;
  /** Adds ID 01 = "12" (do not pay more than once). */
  singleUse?: boolean;
}

export interface DynamicQrParams {
  /** URL of the payload, without "https://". */
  pixUrl: string;
  merchantName: string;
  merchantCity: string;
  /** Adds ID 01 = "12". Recommended for immediate charges. */
  singleUse?: boolean;
}

const TXID_PATTERN = /^[a-zA-Z0-9]{1,25}$/;

function header(singleUse?: boolean): string {
  // 00 - Payload Format Indicator
  return tlv("00", "01") + (singleUse ? tlv("01", "12") : "");
}

/** IDs 52..62 in order; the amount (54) sits between currency and country. */
function merchantFields(merchantName: string, merchantCity: string, txId: string, amount?: number): string {
  return (
    tlv("52", "0000") + // Merchant Category Code, "0000" = not informed
    tlv("53", "986") + // BRL
    (amount !== undefined ? tlv("54", amount.toFixed(2)) : "") +
    tlv("58", "BR") +
    tlv("59", merchantName.slice(0, 25)) +
    tlv("60", merchantCity.slice(0, 15)) +
    tlv("62", tlv("05", txId))
  );
}

export function generateStaticQr(params: StaticQrParams): string {
  if (params.txId !== undefined && !TXID_PATTERN.test(params.txId)) {
    throw new Error("txid must have up to 25 chars [a-zA-Z0-9]");
  }
  if (params.fss !== undefined && !/^[0-9A-Z]{8}$/.test(params.fss)) {
    throw new Error("fss must be an ISPB [0-9A-Z]{8}");
  }

  let mai = tlv("00", PIX_GUI) + tlv("01", params.pixKey);
  if (params.description) mai += tlv("02", params.description);
  if (params.fss) mai += tlv("03", params.fss);
  if (mai.length > MAX_TEMPLATE_LENGTH) {
    throw new Error(
      `Template 26 has ${mai.length} chars (max 99): shorten the description, the key and description share the space`,
    );
  }

  return withCrc(
    header(params.singleUse) +
      tlv("26", mai) +
      merchantFields(params.merchantName, params.merchantCity, params.txId ?? "***", params.amount),
  );
}

export function generateDynamicQr(params: DynamicQrParams, _type: "cob" | "cobv" = "cob"): string {
  if (/^https?:\/\//i.test(params.pixUrl)) {
    throw new Error('pixUrl goes without "https://"');
  }
  const mai = tlv("00", PIX_GUI) + tlv("25", params.pixUrl);
  return withCrc(header(params.singleUse) + tlv("26", mai) + merchantFields(params.merchantName, params.merchantCity, "***"));
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const type = (process.argv[2] as QrType) || "static";
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  console.log(`=== Pix QR Code Generator ===`);
  console.log(`Type: ${type}\n`);

  switch (type) {
    case "static": {
      const pixKey = arg1 || "12345678901"; // CPF as default key
      const amount = arg2 ? parseFloat(arg2) : undefined;
      const payload = generateStaticQr({
        pixKey,
        merchantName: "FULANO DE TAL",
        merchantCity: "SAO PAULO",
        amount,
        description: "Pix test",
        txId: "TXID" + Date.now(),
      });
      console.log("Payload:");
      console.log(payload);
      console.log(`\nLength: ${payload.length} chars`);
      break;
    }
    case "cob": {
      const pixUrl = arg1 || "qr-h.example.com/v2/cobv/abc123";
      const payload = generateDynamicQr({
        pixUrl,
        merchantName: "EMPRESA SA",
        merchantCity: "SAO PAULO",
        singleUse: true,
      }, "cob");
      console.log("Payload:");
      console.log(payload);
      console.log(`\nLength: ${payload.length} chars`);
      break;
    }
    case "cobv": {
      const pixUrl = arg1 || "qr-h.example.com/v2/cobv/def456";
      const payload = generateDynamicQr({
        pixUrl,
        merchantName: "EMPRESA SA",
        merchantCity: "SAO PAULO",
      }, "cobv");
      console.log("Payload:");
      console.log(payload);
      console.log(`\nLength: ${payload.length} chars`);
      break;
    }
  }
}
