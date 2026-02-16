/**
 * Pix QR Code Parser / Debugger.
 *
 * Parses EMV QR code payloads (BR Code) and displays all TLV fields.
 * Useful for debugging QR codes that fail validation during homologation.
 *
 * Features:
 * - Decodes all TLV fields with human-readable labels
 * - Validates CRC-16 checksum
 * - Identifies Pix-specific fields (key, URL, txId)
 * - Flags common issues
 *
 * Usage:
 *   npx tsx scripts/qrcode/qr-parser.ts "<payload>"
 */

// CRC-16/CCITT-FALSE
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

interface TlvField {
  tag: string;
  length: number;
  value: string;
  label: string;
  children?: TlvField[];
}

const TAG_LABELS: Record<string, string> = {
  "00": "Payload Format Indicator",
  "01": "Point of Initiation Method",
  "26": "Merchant Account Information (Pix)",
  "27": "Merchant Account Information (Alt)",
  "52": "Merchant Category Code",
  "53": "Transaction Currency",
  "54": "Transaction Amount",
  "58": "Country Code",
  "59": "Merchant Name",
  "60": "Merchant City",
  "61": "Postal Code",
  "62": "Additional Data Field",
  "63": "CRC16",
  "80": "Unreserved Templates",
};

const MAI_LABELS: Record<string, string> = {
  "00": "GUI (Global Unique Identifier)",
  "01": "Pix Key",
  "02": "Description",
  "03": "FSS (Optional)",
  "25": "URL (Dynamic QR)",
};

const ADF_LABELS: Record<string, string> = {
  "05": "Reference Label (txId)",
  "50": "Payment Setup (Pix)",
};

function parseTlv(data: string): TlvField[] {
  const fields: TlvField[] = [];
  let pos = 0;

  while (pos < data.length) {
    if (pos + 4 > data.length) break;

    const tag = data.substring(pos, pos + 2);
    const length = parseInt(data.substring(pos + 2, pos + 4), 10);
    const value = data.substring(pos + 4, pos + 4 + length);

    const label = TAG_LABELS[tag] || `Unknown (${tag})`;

    const field: TlvField = { tag, length, value, label };

    // Parse nested TLV for known compound fields
    if (tag === "26" || tag === "27") {
      field.children = parseTlvWithLabels(value, MAI_LABELS);
    } else if (tag === "62") {
      field.children = parseTlvWithLabels(value, ADF_LABELS);
    }

    fields.push(field);
    pos += 4 + length;
  }

  return fields;
}

function parseTlvWithLabels(data: string, labels: Record<string, string>): TlvField[] {
  const fields: TlvField[] = [];
  let pos = 0;

  while (pos < data.length) {
    if (pos + 4 > data.length) break;

    const tag = data.substring(pos, pos + 2);
    const length = parseInt(data.substring(pos + 2, pos + 4), 10);
    const value = data.substring(pos + 4, pos + 4 + length);

    fields.push({
      tag,
      length,
      value,
      label: labels[tag] || `Field ${tag}`,
    });

    pos += 4 + length;
  }

  return fields;
}

export function parseQrPayload(payload: string): {
  fields: TlvField[];
  crcValid: boolean;
  crcExpected: string;
  crcActual: string;
  isStatic: boolean;
  isDynamic: boolean;
  pixKey?: string;
  pixUrl?: string;
  amount?: string;
  txId?: string;
  merchantName?: string;
  merchantCity?: string;
  issues: string[];
} {
  const fields = parseTlv(payload);
  const issues: string[] = [];

  // Validate CRC
  const crcField = fields.find((f) => f.tag === "63");
  const crcActual = crcField ? crcField.value : "NONE";
  const payloadWithoutCrc = payload.substring(0, payload.length - 4);
  const crcExpected = crc16(payloadWithoutCrc);
  const crcValid = crcActual === crcExpected;

  if (!crcValid) {
    issues.push(`CRC mismatch: expected ${crcExpected}, got ${crcActual}`);
  }

  // Extract key info
  const initiationMethod = fields.find((f) => f.tag === "01")?.value;
  const isStatic = initiationMethod === "11";
  const isDynamic = initiationMethod === "12";

  const maiField = fields.find((f) => f.tag === "26");
  let pixKey: string | undefined;
  let pixUrl: string | undefined;

  if (maiField?.children) {
    pixKey = maiField.children.find((c) => c.tag === "01")?.value;
    pixUrl = maiField.children.find((c) => c.tag === "25")?.value;
    const gui = maiField.children.find((c) => c.tag === "00")?.value;
    if (gui !== "br.gov.bcb.pix") {
      issues.push(`Invalid GUI: expected "br.gov.bcb.pix", got "${gui}"`);
    }
  }

  const amount = fields.find((f) => f.tag === "54")?.value;
  const merchantName = fields.find((f) => f.tag === "59")?.value;
  const merchantCity = fields.find((f) => f.tag === "60")?.value;

  const adfField = fields.find((f) => f.tag === "62");
  const txId = adfField?.children?.find((c) => c.tag === "05")?.value;

  // Validation checks
  const formatIndicator = fields.find((f) => f.tag === "00");
  if (!formatIndicator || formatIndicator.value !== "01") {
    issues.push("Missing or invalid Payload Format Indicator (tag 00)");
  }

  const currency = fields.find((f) => f.tag === "53");
  if (!currency || currency.value !== "986") {
    issues.push(`Invalid currency: expected "986" (BRL), got "${currency?.value}"`);
  }

  const country = fields.find((f) => f.tag === "58");
  if (!country || country.value !== "BR") {
    issues.push(`Invalid country: expected "BR", got "${country?.value}"`);
  }

  if (!merchantName) issues.push("Missing Merchant Name (tag 59)");
  if (!merchantCity) issues.push("Missing Merchant City (tag 60)");

  return {
    fields,
    crcValid,
    crcExpected,
    crcActual,
    isStatic,
    isDynamic,
    pixKey,
    pixUrl,
    amount,
    txId,
    merchantName,
    merchantCity,
    issues,
  };
}

function printField(field: TlvField, indent = ""): void {
  console.log(`${indent}[${field.tag}] ${field.label} (len=${field.length})`);
  console.log(`${indent}     Value: ${field.value}`);
  if (field.children) {
    for (const child of field.children) {
      printField(child, indent + "  ");
    }
  }
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const payload = process.argv[2];

  if (!payload) {
    console.log("=== Pix QR Code Parser ===\n");
    console.log("Usage: npx tsx scripts/qrcode/qr-parser.ts <payload>\n");
    console.log("Example:");
    console.log('  npx tsx scripts/qrcode/qr-parser.ts "00020101021126..."');
    process.exit(0);
  }

  console.log("=== Pix QR Code Parser ===\n");
  console.log(`Payload (${payload.length} chars):`);
  console.log(`${payload}\n`);

  const result = parseQrPayload(payload);

  console.log("--- TLV Fields ---\n");
  for (const field of result.fields) {
    printField(field);
  }

  console.log("\n--- Summary ---\n");
  console.log(`Type:          ${result.isStatic ? "Static" : result.isDynamic ? "Dynamic" : "Unknown"}`);
  console.log(`CRC Valid:     ${result.crcValid ? "YES" : "NO"} (expected: ${result.crcExpected}, got: ${result.crcActual})`);
  if (result.pixKey) console.log(`Pix Key:       ${result.pixKey}`);
  if (result.pixUrl) console.log(`Pix URL:       ${result.pixUrl}`);
  if (result.amount) console.log(`Amount:        R$ ${result.amount}`);
  if (result.txId) console.log(`Transaction ID: ${result.txId}`);
  if (result.merchantName) console.log(`Merchant:      ${result.merchantName}`);
  if (result.merchantCity) console.log(`City:          ${result.merchantCity}`);

  if (result.issues.length > 0) {
    console.log("\n--- Issues Found ---\n");
    result.issues.forEach((issue) => console.log(`  - ${issue}`));
  } else {
    console.log("\n  No issues found.");
  }
}
