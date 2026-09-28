/**
 * Geradores e validadores de identificadores do arranjo Pix.
 *
 * Referencia: docs/reference/endtoendid-format.md e o Catalogo de Servicos
 * do SFN Volume VI.
 */

import crypto from "node:crypto";

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Recorta a data e a hora em UTC, que e o que o E2E usa (Catalogo SPI). */
function utcParts(at: Date = new Date()): { date: string; time: string } {
  const y = at.getUTCFullYear().toString();
  const mo = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  const h = String(at.getUTCHours()).padStart(2, "0");
  const mi = String(at.getUTCMinutes()).padStart(2, "0");
  return { date: `${y}${mo}${d}`, time: `${h}${mi}` };
}

function randomAlphanum(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHANUM[bytes[i] % ALPHANUM.length];
  return out;
}

/**
 * EndToEndId (prefixo E) ou RtrId de devolucao (prefixo D). O RtrId e campo
 * proprio do pacs.004; o OrgnlEndToEndId continua sendo o E original.
 */
export function generateEndToEndId(ispb: string, devolution = false): string {
  const { date, time } = utcParts();
  return `${devolution ? "D" : "E"}${ispb}${date}${time}${randomAlphanum(11)}`;
}

/** O ISPB aceita letra maiuscula: os participantes virtuais sao 99999A03/99999A04. */
export const E2E_PATTERN = /^[ED][0-9A-Z]{8}\d{8}\d{4}[A-Za-z0-9]{11}$/;

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
    return { valid: false, reason: "nao casa com o padrao [ED] + ISPB + AAAAMMDD + HHMM (UTC) + 11 alfanumericos" };
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

/** MsgId/BizMsgIdr do SPI: M + ISPB + 23 alfanumericos, 32 posicoes. */
export function generateBizMsgIdr(ispb: string): string {
  return `M${ispb}${randomAlphanum(23)}`;
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

/**
 * Data e hora no formato que o SPI e o DICT usam: ISO 8601 em UTC com
 * milissegundos, YYYY-MM-DDThh:mm:ss.sssZ.
 */
export function isoNow(at: Date = new Date()): string {
  return at.toISOString();
}
