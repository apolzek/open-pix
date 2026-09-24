/**
 * Geradores e validadores de identificadores do arranjo Pix.
 *
 * Referencia: docs/reference/endtoendid-format.md e o Catalogo de Servicos
 * do SFN Volume VI.
 */

import crypto from "node:crypto";

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Recorta a data e a hora no fuso de Brasilia, que e o que o E2E usa. */
function brtParts(at: Date = new Date()): { date: string; time: string } {
  const brt = new Date(at.getTime() - 3 * 60 * 60 * 1000);
  const y = brt.getUTCFullYear().toString();
  const mo = String(brt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(brt.getUTCDate()).padStart(2, "0");
  const h = String(brt.getUTCHours()).padStart(2, "0");
  const mi = String(brt.getUTCMinutes()).padStart(2, "0");
  return { date: `${y}${mo}${d}`, time: `${h}${mi}` };
}

function randomAlphanum(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHANUM[bytes[i] % ALPHANUM.length];
  return out;
}

export function generateEndToEndId(ispb: string, devolution = false): string {
  const { date, time } = brtParts();
  return `${devolution ? "D" : "E"}${ispb}${date}${time}${randomAlphanum(11)}`;
}

export const E2E_PATTERN = /^[ED]\d{8}\d{8}\d{4}[A-Za-z0-9]{11}$/;

export interface E2eCheck {
  valid: boolean;
  reason?: string;
  ispb?: string;
  devolution?: boolean;
}

/** Valida formato, tamanho, data e hora do EndToEndId. */
export function checkEndToEndId(value: string): E2eCheck {
  if (typeof value !== "string" || value.length !== 32) {
    return { valid: false, reason: `tamanho deve ser 32, recebido ${value?.length ?? 0}` };
  }
  if (!E2E_PATTERN.test(value)) {
    return { valid: false, reason: "nao casa com o padrao [ED] + ISPB + AAAAMMDD + HHMM + 11 alfanumericos" };
  }
  const month = Number(value.slice(13, 15));
  const day = Number(value.slice(15, 17));
  const hour = Number(value.slice(17, 19));
  const minute = Number(value.slice(19, 21));
  if (month < 1 || month > 12) return { valid: false, reason: `mes invalido: ${month}` };
  if (day < 1 || day > 31) return { valid: false, reason: `dia invalido: ${day}` };
  if (hour > 23) return { valid: false, reason: `hora invalida: ${hour}` };
  if (minute > 59) return { valid: false, reason: `minuto invalido: ${minute}` };
  return { valid: true, ispb: value.slice(1, 9), devolution: value[0] === "D" };
}

export function generateBizMsgIdr(ispb: string): string {
  return `M${ispb}${brtParts().date}${randomAlphanum(15)}`;
}

export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * CID de um vinculo do DICT: 256 bits que identificam unicamente o vinculo.
 * O Bacen define a composicao exata no manual; aqui usamos um SHA-256 sobre
 * os mesmos campos de entrada, que preserva a propriedade de identidade.
 */
export function computeCid(input: {
  key: string;
  keyType: string;
  participant: string;
  branch: string;
  accountNumber: string;
  accountType: string;
  taxIdNumber: string;
  requestId: string;
}): string {
  const canonical = [
    input.key,
    input.keyType,
    input.participant,
    input.branch,
    input.accountNumber,
    input.accountType,
    input.taxIdNumber,
    input.requestId,
  ].join("|");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Correlacao devolvida pelo DICT em cada resposta. */
export function correlationId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Data no formato que o DICT usa: ISO 8601 UTC com milissegundos. */
export function isoNow(at: Date = new Date()): string {
  return at.toISOString().replace(/\.(\d{3})Z$/, ".$1Z");
}

/** Data e hora no formato que o SPI usa: ISO 8601 com offset de Brasilia. */
export function isoBrt(at: Date = new Date()): string {
  const brt = new Date(at.getTime() - 3 * 60 * 60 * 1000);
  const base = brt.toISOString().replace("Z", "");
  return `${base}-03:00`;
}
