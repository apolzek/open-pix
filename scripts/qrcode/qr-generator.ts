/**
 * Pix QR Code Generator.
 *
 * Generates EMV-compatible QR code payloads for Pix:
 * - Static QR: Fixed amount, reusable (26.xx TLV)
 * - COB (Cobranca): Dynamic QR with unique URL (62.05 TLV)
 * - COBV (Cobranca com Vencimento): Dynamic QR with due date
 *
 * EMV QR Code Specification (based on BR Code / Pix):
 * - TLV (Tag-Length-Value) encoding
 * - CRC-16/CCITT-FALSE checksum (tag 63)
 * - Merchant Account Info (tag 26): GUI + key/URL
 *
 * Usage:
 *   npx tsx scripts/qrcode/qr-generator.ts static <pixKey> <amount>
 *   npx tsx scripts/qrcode/qr-generator.ts cob <pixUrl>
 *   npx tsx scripts/qrcode/qr-generator.ts cobv <pixUrl>
 */

// CRC-16/CCITT-FALSE lookup table
const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 8;
  for (let j = 0; j < 8; j++) {
    crc = (crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0);
  }
  CRC_TABLE[i] = crc & 0xffff;
}

function crc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ data.charCodeAt(i)) & 0xff];
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(tag: string, value: string): string {
  const len = value.length.toString().padStart(2, "0");
  return `${tag}${len}${value}`;
}

export type QrType = "static" | "cob" | "cobv";

export interface StaticQrParams {
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  amount?: number;
  description?: string;
  txId?: string;
}

export interface DynamicQrParams {
  pixUrl: string;
  merchantName: string;
  merchantCity: string;
}

const PIX_GUI = "br.gov.bcb.pix";

export function generateStaticQr(params: StaticQrParams): string {
  let payload = "";

  // 00 - Payload Format Indicator
  payload += tlv("00", "01");

  // 01 - Point of Initiation Method (11=static/reusable, 12=dynamic/single-use)
  payload += tlv("01", params.amount ? "12" : "11");

  // 26 - Merchant Account Information (Pix)
  let mai = "";
  mai += tlv("00", PIX_GUI);       // GUI
  mai += tlv("01", params.pixKey);  // Pix key
  if (params.description) {
    mai += tlv("02", params.description.slice(0, 72));
  }
  payload += tlv("26", mai);

  // 52 - Merchant Category Code
  payload += tlv("52", "0000");

  // 53 - Transaction Currency (986 = BRL)
  payload += tlv("53", "986");

  // 54 - Transaction Amount (optional for static)
  if (params.amount) {
    payload += tlv("54", params.amount.toFixed(2));
  }

  // 58 - Country Code
  payload += tlv("58", "BR");

  // 59 - Merchant Name
  payload += tlv("59", params.merchantName.slice(0, 25));

  // 60 - Merchant City
  payload += tlv("60", params.merchantCity.slice(0, 15));

  // 62 - Additional Data Field
  if (params.txId) {
    let adf = "";
    adf += tlv("05", params.txId.slice(0, 25)); // Reference Label (txId)
    payload += tlv("62", adf);
  } else {
    payload += tlv("62", tlv("05", "***")); // Default: any txId
  }

  // 63 - CRC16 (compute over entire payload including tag 63 header)
  const crcInput = payload + "6304";
  const checksum = crc16(crcInput);
  payload += `6304${checksum}`;

  return payload;
}

export function generateDynamicQr(params: DynamicQrParams, type: "cob" | "cobv" = "cob"): string {
  let payload = "";

  // 00 - Payload Format Indicator
  payload += tlv("00", "01");

  // 01 - Point of Initiation Method (12 = dynamic/single-use)
  payload += tlv("01", "12");

  // 26 - Merchant Account Information
  let mai = "";
  mai += tlv("00", PIX_GUI);
  mai += tlv("25", params.pixUrl); // URL for dynamic QR
  payload += tlv("26", mai);

  // 52 - Merchant Category Code
  payload += tlv("52", "0000");

  // 53 - Transaction Currency (986 = BRL)
  payload += tlv("53", "986");

  // 58 - Country Code
  payload += tlv("58", "BR");

  // 59 - Merchant Name
  payload += tlv("59", params.merchantName.slice(0, 25));

  // 60 - Merchant City
  payload += tlv("60", params.merchantCity.slice(0, 15));

  // 62 - Additional Data Field
  payload += tlv("62", tlv("05", "***"));

  // 63 - CRC16
  const crcInput = payload + "6304";
  const checksum = crc16(crcInput);
  payload += `6304${checksum}`;

  return payload;
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
