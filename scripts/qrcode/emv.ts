/**
 * EMV MPM / BR Code primitives shared by the Pix QR generator and parser.
 *
 * Reference: Manual de Padroes para Iniciacao do Pix 2.10.0, section 2.
 * - TLV: 2-digit ID + 2-digit length + value.
 * - CRC16 (ID 63): polynomial 0x1021, initial value 0xFFFF, computed over the
 *   whole payload including "6304".
 * - Pix Merchant Account Information may use any ID from 26 to 51 and is the
 *   template whose GUI (sub-ID 00) is "br.gov.bcb.pix" (case insensitive).
 *   Templates are limited to 99 chars.
 */

export const PIX_GUI = "br.gov.bcb.pix";
export const MAX_TEMPLATE_LENGTH = 99;

const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 8;
  for (let j = 0; j < 8; j++) {
    crc = (crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0);
  }
  CRC_TABLE[i] = crc & 0xffff;
}

/** CRC-16/CCITT-FALSE over the UTF-8 bytes, as 4 uppercase hex digits. */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(data, "utf8")) {
    crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ byte) & 0xff];
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function tlv(id: string, value: string): string {
  if (value.length < 1 || value.length > MAX_TEMPLATE_LENGTH) {
    throw new Error(`EMV field ${id} must have 1 to 99 chars, got ${value.length}`);
  }
  return `${id}${value.length.toString().padStart(2, "0")}${value}`;
}

/** Appends ID 63 with the CRC of the payload. */
export function withCrc(payload: string): string {
  const input = `${payload}6304`;
  return input + crc16(input);
}

export interface TlvField {
  id: string;
  length: number;
  value: string;
}

/** Splits a TLV string. Throws on truncated or malformed input. */
export function parseTlv(data: string): TlvField[] {
  const fields: TlvField[] = [];
  let pos = 0;
  while (pos < data.length) {
    const id = data.substring(pos, pos + 2);
    const rawLength = data.substring(pos + 2, pos + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(rawLength)) {
      throw new Error(`Malformed TLV at position ${pos}`);
    }
    const length = Number(rawLength);
    const value = data.substring(pos + 4, pos + 4 + length);
    if (value.length !== length) {
      throw new Error(`Field ${id} declares ${length} chars but only ${value.length} remain`);
    }
    fields.push({ id, length, value });
    pos += 4 + length;
  }
  return fields;
}

/** Finds the Pix Merchant Account Information template among IDs 26..51. */
export function findPixTemplate(fields: TlvField[]): TlvField | undefined {
  return fields.find((f) => {
    const id = Number(f.id);
    if (id < 26 || id > 51) return false;
    try {
      const gui = parseTlv(f.value).find((c) => c.id === "00")?.value;
      return gui?.toLowerCase() === PIX_GUI;
    } catch {
      return false;
    }
  });
}
