/**
 * Pix QR Code Parser / Debugger.
 *
 * Parses BR Code payloads (Manual de Padroes para Iniciacao do Pix 2.10.0)
 * and displays all TLV fields. Useful for debugging QR codes that fail
 * validation during homologation.
 *
 * - Validates the CRC16 (ID 63).
 * - Finds the Pix template among IDs 26..51 by its GUI br.gov.bcb.pix.
 * - Static QR: has the Pix key (template 01). Dynamic QR: has the payload
 *   URL (template 25). ID 01 = "12" only means "do not pay twice".
 * - Flags rule violations: txid charset/size, template over 99 chars,
 *   https:// in the URL, missing mandatory fields.
 *
 * Usage:
 *   npx tsx scripts/qrcode/qr-parser.ts "<payload>"
 */

import { crc16, parseTlv, findPixTemplate, type TlvField as EmvField } from "./emv.js";

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
  "52": "Merchant Category Code",
  "53": "Transaction Currency",
  "54": "Transaction Amount",
  "58": "Country Code",
  "59": "Merchant Name",
  "60": "Merchant City",
  "61": "Postal Code",
  "62": "Additional Data Field",
  "63": "CRC16",
};

const MAI_LABELS: Record<string, string> = {
  "00": "GUI (Globally Unique Identifier)",
  "01": "Pix Key",
  "02": "infoAdicional",
  "03": "fss (withdrawal facilitator ISPB)",
  "25": "URL (Dynamic QR)",
};

const ADF_LABELS: Record<string, string> = {
  "05": "Reference Label (txid)",
};

function label(field: EmvField, pixTemplateId?: string): TlvField {
  const n = Number(field.id);
  const isTemplate = (n >= 26 && n <= 51) || (n >= 80 && n <= 99) || field.id === "62";
  const base: TlvField = {
    tag: field.id,
    length: field.length,
    value: field.value,
    label:
      field.id === pixTemplateId
        ? "Merchant Account Information (Pix)"
        : n >= 26 && n <= 51
          ? "Merchant Account Information"
          : n >= 80 && n <= 99
            ? "Unreserved Template"
            : TAG_LABELS[field.id] ?? `Unknown (${field.id})`,
  };
  if (isTemplate) {
    const labels = field.id === "62" ? ADF_LABELS : MAI_LABELS;
    try {
      base.children = parseTlv(field.value).map((c) => ({
        tag: c.id,
        length: c.length,
        value: c.value,
        label: labels[c.id] ?? `Field ${c.id}`,
      }));
    } catch {
      // Leave the raw value; the issue list reports the template.
    }
  }
  return base;
}

export function parseQrPayload(payload: string): {
  fields: TlvField[];
  crcValid: boolean;
  crcExpected: string;
  crcActual: string;
  isStatic: boolean;
  isDynamic: boolean;
  singleUse: boolean;
  pixKey?: string;
  pixUrl?: string;
  amount?: string;
  txId?: string;
  merchantName?: string;
  merchantCity?: string;
  issues: string[];
} {
  const issues: string[] = [];

  let raw: EmvField[];
  try {
    raw = parseTlv(payload);
  } catch (err) {
    raw = [];
    issues.push((err as Error).message);
  }

  const pix = findPixTemplate(raw);
  const fields = raw.map((f) => label(f, pix?.id));
  const get = (id: string) => raw.find((f) => f.id === id)?.value;

  // CRC covers everything up to and including "6304".
  const crcActual = get("63") ?? "NONE";
  const crcExpected = payload.length >= 4 ? crc16(payload.slice(0, -4)) : "NONE";
  const crcValid = crcActual === crcExpected && payload.slice(-8, -4) === "6304";
  if (!crcValid) issues.push(`CRC mismatch: expected ${crcExpected}, got ${crcActual}`);
  if (raw.length && raw[raw.length - 1].id !== "63") issues.push("CRC (ID 63) must be the last field");

  if (raw[0]?.id !== "00" || raw[0]?.value !== "01") {
    issues.push("Payload Format Indicator (ID 00 = 01) must be the first field");
  }

  const singleUse = get("01") === "12";
  if (get("01") !== undefined && get("01") !== "11" && get("01") !== "12") {
    issues.push(`Invalid Point of Initiation Method: ${get("01")}`);
  }

  let pixKey: string | undefined;
  let pixUrl: string | undefined;
  if (!pix) {
    issues.push('No Merchant Account Information (IDs 26..51) with GUI "br.gov.bcb.pix"');
  } else {
    const sub = parseTlv(pix.value);
    pixKey = sub.find((c) => c.id === "01")?.value;
    pixUrl = sub.find((c) => c.id === "25")?.value;
    if (pix.length > 99) issues.push("Pix template exceeds 99 chars");
    if (pixKey && pixUrl) issues.push("Pix template has both key (01) and URL (25)");
    if (!pixKey && !pixUrl) issues.push("Pix template has neither key (01) nor URL (25)");
    if (pixUrl && /^https?:\/\//i.test(pixUrl)) issues.push('URL (25) must not include "https://"');
  }

  const amount = get("54");
  if (amount !== undefined && !/^\d{1,10}\.\d{2}$/.test(amount)) {
    issues.push(`Amount (54) must use dot and two decimals, got "${amount}"`);
  }

  const txId = parseTlv(get("62") ?? "").find((c) => c.id === "05")?.value;
  if (txId === undefined) {
    issues.push('Missing txid (62-05); use "***" when there is none');
  } else if (txId !== "***" && !/^[a-zA-Z0-9]{1,25}$/.test(txId)) {
    issues.push(`txid must have up to 25 chars [a-zA-Z0-9], got "${txId}"`);
  }
  if (pixUrl && txId !== undefined && txId !== "***") {
    issues.push("Dynamic QR: txid comes from the URL payload; 62-05 is ignored by the payer");
  }

  if (get("52") === undefined) issues.push("Missing Merchant Category Code (ID 52)");
  if (get("53") !== "986") issues.push(`Invalid currency: expected "986" (BRL), got "${get("53")}"`);
  if (get("58") !== "BR") issues.push(`Invalid country: expected "BR", got "${get("58")}"`);

  const merchantName = get("59");
  const merchantCity = get("60");
  if (!merchantName) issues.push("Missing Merchant Name (ID 59)");
  else if (merchantName.length > 25) issues.push("Merchant Name (59) exceeds 25 chars");
  if (!merchantCity) issues.push("Missing Merchant City (ID 60)");
  else if (merchantCity.length > 15) issues.push("Merchant City (60) exceeds 15 chars");

  return {
    fields,
    crcValid,
    crcExpected,
    crcActual,
    isStatic: pixKey !== undefined,
    isDynamic: pixUrl !== undefined,
    singleUse,
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
  console.log(`Type:          ${result.isStatic ? "Static" : result.isDynamic ? "Dynamic" : "Unknown"}${result.singleUse ? " (single use)" : ""}`);
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
