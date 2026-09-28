/**
 * DICT Key Lookup (getEntry) + shared DICT helpers.
 *
 * Source of truth: Bacen's DICT API v2.12.1 (simulator/spec/dict-2.12.1/openapi.json,
 * extracted from https://www.bcb.gov.br/content/estabilidadefinanceira/pix/API-DICT.html).
 *
 * Base URL (the DictClient appends /api/v2):
 *   homologation  https://dict-h.pi.rsfn.net.br:16522/api/v2/
 *   production    https://dict.pi.rsfn.net.br:16422/api/v2/
 *
 * getEntry:  GET /entries/{Key}[?IncludeStatistics=true]
 *   Headers (all required by the spec, for every key type):
 *     PI-RequestingParticipant  ISPB of the requester (set by DictClient from config.ispb)
 *     PI-PayerId                CPF (11 digits) or CNPJ (14 digits) of the paying end user
 *     PI-EndToEndId             EndToEndId of the payment being prepared (pacs.008 <EndToEndId>)
 *   200 -> GetEntryResponse, 404 -> key not found, 429 -> rate limited.
 *   No request body and no signature: read operations are not signed.
 *
 * Rate limiting (token bucket, spec "Limitacao de requisicoes"):
 *   - ENTRIES_READ_USER_ANTISCAN (EMAIL/PHONE) and _V2 (CPF/CNPJ/EVP), scope = PI-PayerId:
 *     200 costs 1, 404 costs 20. PF: 2/min refill, bucket 100. PJ: 20/min, bucket 1000.
 *   - ENTRIES_READ_PARTICIPANT_ANTISCAN, scope = PSP: 200 costs 1, 404 costs 3; bucket
 *     depends on the participant category (A..H).
 *   Lookups for a single PayerId run dry fast, especially on 404s.
 *
 * Responses may be cached following Cache-Control; the DICT accepts gzip on
 * responses (Accept-Encoding: gzip) but NOT compressed request bodies.
 *
 * This module also exports the helpers shared by the other scripts in
 * scripts/dict/ (validation, XML building, env/client setup).
 *
 * Usage:
 *   npx tsx scripts/dict/key-lookup.ts <keyType> <key> [payerId]
 *   npx tsx scripts/dict/key-lookup.ts EMAIL cliente-000000@pix.bcb.gov.br
 *   npx tsx scripts/dict/key-lookup.ts PHONE +5561900000000 11122233300
 *   npx tsx scripts/dict/key-lookup.ts CPF 12345678901
 *
 * Env: PSP_ISPB, MTLS_CERT_PATH, MTLS_KEY_PATH, MTLS_CA_PATH, [MTLS_PASSPHRASE],
 *      [DICT_BASE_URL], [DICT_PAYER_ID]. Without them it runs in demo mode and
 *      prints the request it would send.
 */

import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { DictClient, HttpError, type HttpResponse } from "../utils/http-client.js";
import { generateEndToEndId } from "../utils/endtoendid-generator.js";

// ---------------------------------------------------------------------------
// Shared constants and types (spec components.schemas)
// ---------------------------------------------------------------------------

/** Server roots; DictClient adds /api/v2. */
export const DICT_HOMOLOG_BASE_URL = "https://dict-h.pi.rsfn.net.br:16522";
export const DICT_PROD_BASE_URL = "https://dict.pi.rsfn.net.br:16422";

export const KEY_TYPES = ["CPF", "CNPJ", "PHONE", "EMAIL", "EVP"] as const;
export type KeyType = (typeof KEY_TYPES)[number];

export const ACCOUNT_TYPES = ["CACC", "TRAN", "SLRY", "SVGS", "OTHR"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const PERSON_TYPES = ["NATURAL_PERSON", "LEGAL_PERSON"] as const;
export type PersonType = (typeof PERSON_TYPES)[number];

/** Key formats from the spec's "Chave" table (tag Entry). */
export const KEY_PATTERNS: Record<KeyType, RegExp> = {
  CPF: /^[0-9]{11}$/,
  CNPJ: /^[a-zA-Z0-9]{14}$/, // spec: ^(?i)[a-z0-9]{14}$ (alphanumeric CNPJ)
  PHONE: /^\+[1-9]\d{1,14}$/,
  EMAIL: /^[a-z0-9.!#$'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
  EVP: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};
/** Key maxLength (schema Key) and the e-mail limit in the key table. */
export const KEY_MAX_LENGTH = 77;

/**
 * The spec's ISPB pattern is ^(?i)[a-z0-9]{8}; ISPBs are issued in uppercase
 * (e.g. 99999A03), so this toolkit requires [0-9A-Z]{8}.
 */
export const PARTICIPANT_PATTERN = /^[0-9A-Z]{8}$/;
export const BRANCH_PATTERN = /^[0-9]{1,4}$/;
export const ACCOUNT_NUMBER_PATTERN = /^[a-zA-Z0-9]{1,20}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PAYER_ID_PATTERN = /^([0-9]{11}|[0-9]{14})$/;
export const NATURAL_NAME_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ' -]+$/;
export const LEGAL_NAME_PATTERN = /^[ -~¡-ÿ]+$/;
export const TRADE_NAME_PATTERN = /^(?!\*+$)[ -~¡-ÿ]+$/;

export interface BrazilianAccount {
  /** ISPB of the account provider. */
  participant: string;
  /** Branch without check digit, 1-4 digits. Optional in the spec. */
  branch?: string;
  /** Account number including check digit (a letter digit becomes 0). */
  accountNumber: string;
  accountType: AccountType;
  /** Opening date; if the time is unknown, use the start of the day in BRT (03:00Z). */
  openingDate: string | Date;
}

export interface Person {
  type: PersonType;
  /** CPF (11 digits) for NATURAL_PERSON, CNPJ (14 digits) for LEGAL_PERSON. */
  taxIdNumber: string;
  name: string;
  /** LEGAL_PERSON only. */
  tradeName?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class DictValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DictValidationError";
  }
}

function fail(message: string): never {
  throw new DictValidationError(message);
}

export function assertPattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${field} must match ${pattern}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${field} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

export function assertMaxLength(value: string, max: number, field: string): string {
  if (value.length > max) fail(`${field} must have at most ${max} characters, got ${value.length}`);
  return value;
}

export function assertParticipant(value: unknown, field = "Participant"): string {
  return assertPattern(value, PARTICIPANT_PATTERN, field);
}

export function assertUuid(value: unknown, field: string): string {
  return assertPattern(value, UUID_PATTERN, field);
}

export function assertKeyType(value: unknown): KeyType {
  return assertEnum(value, KEY_TYPES, "KeyType");
}

export function assertKey(keyType: KeyType, key: unknown): string {
  assertKeyType(keyType);
  const k = assertPattern(key, KEY_PATTERNS[keyType], `Key (${keyType})`);
  return assertMaxLength(k, KEY_MAX_LENGTH, "Key");
}

export function assertPayerId(value: unknown): string {
  return assertPattern(value, PAYER_ID_PATTERN, "PI-PayerId");
}

/** Guesses the key type from its format (EVP before CPF/CNPJ, which are all digits). */
export function detectKeyType(key: string): KeyType | undefined {
  for (const t of ["EVP", "EMAIL", "PHONE", "CPF", "CNPJ"] as KeyType[]) {
    if (KEY_PATTERNS[t].test(key)) return t;
  }
  return undefined;
}

export function formatDateTime(value: string | Date, field: string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    fail(`${field} must be a valid date-time, got ${JSON.stringify(value)}`);
  }
  return typeof value === "string" ? value : d.toISOString();
}

/** Start of today in BRT (UTC-3), the convention when the opening time is unknown. */
export function startOfDayBrt(d = new Date()): string {
  const brt = new Date(d.getTime() - 3 * 3600_000);
  return `${brt.toISOString().slice(0, 10)}T03:00:00Z`;
}

export function validateAccount(account: BrazilianAccount, field = "Account"): void {
  assertParticipant(account.participant, `${field}.Participant`);
  if (account.branch !== undefined) assertPattern(account.branch, BRANCH_PATTERN, `${field}.Branch`);
  assertPattern(account.accountNumber, ACCOUNT_NUMBER_PATTERN, `${field}.AccountNumber`);
  assertEnum(account.accountType, ACCOUNT_TYPES, `${field}.AccountType`);
  formatDateTime(account.openingDate, `${field}.OpeningDate`);
}

export function validatePerson(person: Person, field = "Owner"): void {
  assertEnum(person.type, PERSON_TYPES, `${field}.Type`);
  if (person.type === "NATURAL_PERSON") {
    assertPattern(person.taxIdNumber, /^[0-9]{11}$/, `${field}.TaxIdNumber (CPF)`);
    assertPattern(person.name, NATURAL_NAME_PATTERN, `${field}.Name`);
    if (person.tradeName !== undefined) fail(`${field}.TradeName is only valid for LEGAL_PERSON`);
  } else {
    assertPattern(person.taxIdNumber, /^[0-9]{14}$/, `${field}.TaxIdNumber (CNPJ)`);
    assertPattern(person.name, LEGAL_NAME_PATTERN, `${field}.Name`);
    if (person.tradeName !== undefined) {
      assertPattern(person.tradeName, TRADE_NAME_PATTERN, `${field}.TradeName`);
      assertMaxLength(person.tradeName, 100, `${field}.TradeName`);
    }
  }
  assertMaxLength(person.name, 150, `${field}.Name`);
}

// ---------------------------------------------------------------------------
// XML building
// ---------------------------------------------------------------------------

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** [element name, text | children]; undefined values are omitted. */
export type XmlNode = [string, string | XmlNode[] | undefined];

function render(nodes: XmlNode[], depth: number): string[] {
  const pad = "    ".repeat(depth);
  const lines: string[] = [];
  for (const [name, value] of nodes) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${pad}<${name}>`, ...render(value, depth + 1), `${pad}</${name}>`);
    } else {
      lines.push(`${pad}<${name}>${escapeXml(value)}</${name}>`);
    }
  }
  return lines;
}

/**
 * Builds a DICT request document: no namespace, <Signature></Signature> as the
 * first child (placeholder for the enveloped XMLDSig), as in the spec examples.
 */
export function dictDocument(root: string, children: XmlNode[]): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<${root}>`,
    ...render([["Signature", ""], ...children], 1),
    `</${root}>`,
  ].join("\n");
}

export function accountNodes(account: BrazilianAccount): XmlNode[] {
  return [
    ["Participant", account.participant],
    ["Branch", account.branch],
    ["AccountNumber", account.accountNumber],
    ["AccountType", account.accountType],
    ["OpeningDate", formatDateTime(account.openingDate, "OpeningDate")],
  ];
}

export function personNodes(person: Person): XmlNode[] {
  return [
    ["Type", person.type],
    ["TaxIdNumber", person.taxIdNumber],
    ["Name", person.name],
    ["TradeName", person.type === "LEGAL_PERSON" ? person.tradeName : undefined],
  ];
}

export function newRequestId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Responses and errors
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false, // keep "0001", "00123" etc. as strings
  removeNSPrefix: true,
});

/** Parses a DICT XML response into a plain object (root element included). */
export function parseDictXml(xml: string): Record<string, any> {
  return parser.parse(xml);
}

export interface DictProblem {
  type?: string;
  title?: string;
  status?: string;
  detail?: string;
}

/** Extracts the RFC 7807 problem (application/problem+xml) from an error body. */
export function parseProblem(body: string): DictProblem | undefined {
  try {
    const p = parseDictXml(body).problem;
    return p && typeof p === "object" ? p : undefined;
  } catch {
    return undefined;
  }
}

/** One-line description of an error thrown by DictClient.call. */
export function describeDictError(err: unknown): string {
  if (err instanceof HttpError) {
    const p = parseProblem(err.body);
    const code = p?.type?.split("/").pop();
    return p ? `HTTP ${err.statusCode} ${code ?? ""}: ${p.detail ?? p.title ?? ""}`.trim() : err.message;
  }
  return (err as Error).message;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export const REQUIRED_ENV = ["PSP_ISPB", "MTLS_CERT_PATH", "MTLS_KEY_PATH", "MTLS_CA_PATH"];

export function missingEnv(): string[] {
  return REQUIRED_ENV.filter((v) => !process.env[v]);
}

export function dictClientFromEnv(): DictClient {
  return new DictClient({
    baseUrl: process.env.DICT_BASE_URL || DICT_HOMOLOG_BASE_URL,
    ispb: assertParticipant(process.env.PSP_ISPB, "PSP_ISPB"),
    certPath: process.env.MTLS_CERT_PATH!,
    keyPath: process.env.MTLS_KEY_PATH!,
    caPath: process.env.MTLS_CA_PATH!,
    passphrase: process.env.MTLS_PASSPHRASE,
  });
}

/** Prints validation errors as one line instead of a stack trace. */
export function installCliErrorHandler(): void {
  process.on("uncaughtException", (err) => {
    console.error(err instanceof DictValidationError ? `Invalid input: ${err.message}` : err);
    process.exit(1);
  });
}

/** Header note shared by every script that sends a write operation. */
export const SIGNATURE_WARNING =
  "NOTE: DICT write requests must carry an enveloped XMLDSig in <Signature> " +
  "(Manual de Seguranca do Pix). This toolkit does not sign yet; unsigned requests are refused.";

// ---------------------------------------------------------------------------
// getEntry
// ---------------------------------------------------------------------------

export interface GetEntryParams {
  key: string;
  /** Optional: validates the key format when given (the API infers the type). */
  keyType?: KeyType;
  /** PI-PayerId: CPF/CNPJ of the paying end user, digits only. */
  payerId: string;
  /** PI-EndToEndId of the payment being prepared. */
  endToEndId: string;
  includeStatistics?: boolean;
}

export interface DictHttpRequest {
  method: "GET" | "POST" | "PUT";
  /** Relative to /api/v2. */
  path: string;
  body?: string;
  payerId?: string;
  endToEndId?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

/** Pure description of a getEntry call (no body, three PI-* headers). */
export function buildGetEntryRequest(params: GetEntryParams): DictHttpRequest {
  if (params.keyType) assertKey(params.keyType, params.key);
  else if (!detectKeyType(params.key)) fail(`Key has no known format: ${JSON.stringify(params.key)}`);
  assertPayerId(params.payerId);
  if (!params.endToEndId) fail("PI-EndToEndId is required on getEntry");
  return {
    method: "GET",
    path: `/entries/${encodeURIComponent(params.key)}`,
    payerId: params.payerId,
    endToEndId: params.endToEndId,
    query: params.includeStatistics ? { IncludeStatistics: true } : undefined,
  };
}

export async function sendDictRequest(
  client: DictClient,
  req: DictHttpRequest,
  okStatus?: number[],
): Promise<HttpResponse> {
  return client.call(req.method, req.path, req.body, {
    payerId: req.payerId,
    endToEndId: req.endToEndId,
    query: req.query,
    okStatus,
  });
}

export interface LookupResult {
  key: string;
  found: boolean;
  statusCode?: number;
  correlationId?: string;
  entry?: {
    key?: string;
    keyType: string;
    account: { participant: string; branch?: string; accountNumber: string; accountType: string; openingDate: string };
    owner: { type: string; taxIdNumber: string; name: string; tradeName?: string };
    creationDate?: string;
    keyOwnershipDate?: string;
    openClaimCreationDate?: string;
  };
  error?: string;
}

export function parseGetEntryResponse(xml: string): Omit<LookupResult, "key" | "found" | "statusCode"> {
  const res = parseDictXml(xml).GetEntryResponse;
  if (!res?.Entry) return { error: "Unexpected response: no GetEntryResponse/Entry" };
  const e = res.Entry;
  return {
    correlationId: res.CorrelationId,
    entry: {
      key: e.Key,
      keyType: e.KeyType,
      account: {
        participant: e.Account?.Participant,
        branch: e.Account?.Branch,
        accountNumber: e.Account?.AccountNumber,
        accountType: e.Account?.AccountType,
        openingDate: e.Account?.OpeningDate,
      },
      owner: {
        type: e.Owner?.Type,
        taxIdNumber: e.Owner?.TaxIdNumber,
        name: e.Owner?.Name,
        tradeName: e.Owner?.TradeName,
      },
      creationDate: e.CreationDate,
      keyOwnershipDate: e.KeyOwnershipDate,
      openClaimCreationDate: e.OpenClaimCreationDate,
    },
  };
}

export async function lookupKey(client: DictClient, params: GetEntryParams): Promise<LookupResult> {
  const res = await sendDictRequest(client, buildGetEntryRequest(params), [404]);
  if (res.statusCode === 404) {
    return { key: params.key, found: false, statusCode: 404, error: parseProblem(res.body)?.detail };
  }
  return { key: params.key, found: true, statusCode: res.statusCode, ...parseGetEntryResponse(res.body) };
}

/**
 * Looks up many keys. Each lookup gets its own EndToEndId. Mind the per-payer
 * antiscan bucket: use a different payerId per key (payerIdFor) in bulk runs.
 */
export async function batchLookup(
  client: DictClient,
  ispb: string,
  keys: string[],
  payerIdFor: (key: string, index: number) => string,
  concurrency = 10,
): Promise<LookupResult[]> {
  const results: LookupResult[] = [];

  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((key, j) =>
        lookupKey(client, { key, payerId: payerIdFor(key, i + j), endToEndId: generateEndToEndId(ispb) })
          .catch((err): LookupResult => ({ key, found: false, error: describeDictError(err) })),
      ),
    );
    results.push(...batchResults);

    const done = Math.min(i + concurrency, keys.length);
    if (done % 100 === 0 || done === keys.length) {
      console.log(`  Lookup progress: ${done}/${keys.length}`);
    }
  }

  return results;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  installCliErrorHandler();
  const keyType = assertKeyType(process.argv[2] || "EMAIL");
  const key = process.argv[3] || "cliente-000000@pix.bcb.gov.br";
  const payerId = process.argv[4] || process.env.DICT_PAYER_ID || "11122233300";
  const ispb = process.env.PSP_ISPB || "12345678";

  console.log(`=== DICT Key Lookup (getEntry) ===`);
  console.log(`Key type: ${keyType}`);
  console.log(`Key: ${key}\n`);

  const req = buildGetEntryRequest({ keyType, key, payerId, endToEndId: generateEndToEndId(ispb) });
  const missing = missingEnv();

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("Copy config/homolog.env.example to .env and configure.\n");

    console.log("--- Demo Mode (request that would be sent) ---\n");
    console.log(`${req.method} ${DICT_HOMOLOG_BASE_URL}/api/v2${req.path}`);
    console.log(`PI-RequestingParticipant: ${ispb}`);
    console.log(`PI-PayerId: ${req.payerId}`);
    console.log(`PI-EndToEndId: ${req.endToEndId}`);
    console.log("Accept: application/xml");
    console.log("Accept-Encoding: gzip");
    process.exit(0);
  }

  const client = dictClientFromEnv();
  sendDictRequest(client, req, [404])
    .then((res) => {
      const result: LookupResult = res.statusCode === 404
        ? { key, found: false, statusCode: 404, error: parseProblem(res.body)?.detail }
        : { key, found: true, statusCode: res.statusCode, ...parseGetEntryResponse(res.body) };
      console.log("Result:", JSON.stringify(result, null, 2));
      client.destroy();
    })
    .catch((err) => {
      console.error("Lookup failed:", describeDictError(err));
      client.destroy();
      process.exit(1);
    });
}
