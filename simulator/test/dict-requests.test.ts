import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { XMLParser } from "fast-xml-parser";

import type { DictClient, HttpResponse } from "../../scripts/utils/http-client.js";
import { generateDevolutionEndToEndId, generateEndToEndId } from "../../scripts/utils/endtoendid-generator.js";
import {
  DictValidationError,
  buildGetEntryRequest,
  detectKeyType,
  escapeXml,
  lookupKey,
  parseGetEntryResponse,
  type BrazilianAccount,
  type Person,
} from "../../scripts/dict/key-lookup.js";
import {
  buildCreateEntryRequest,
  buildDeleteEntryRequest,
  createEntry,
  deleteEntry,
  randomEntryParams,
} from "../../scripts/dict/key-bulk-creator.js";
import {
  acknowledgeClaim,
  buildAcknowledgeClaimRequest,
  buildCancelClaimRequest,
  buildCompleteClaimRequest,
  buildConfirmClaimRequest,
  buildCreateClaimRequest,
  cancelClaim,
  completeClaim,
  confirmClaim,
  createClaim,
  getClaim,
} from "../../scripts/dict/claims-helper.js";
import {
  acknowledgeInfractionReport,
  buildAcknowledgeInfractionReportRequest,
  buildCancelInfractionReportRequest,
  buildCloseInfractionReportRequest,
  buildCreateInfractionReportRequest,
  cancelInfractionReport,
  closeInfractionReport,
  createInfractionReport,
  getInfractionReport,
} from "../../scripts/dict/infraction-helper.js";
import {
  buildCancelRefundRequest,
  buildCloseRefundRequest,
  buildCreateRefundRequest,
  cancelRefund,
  closeRefund,
  createRefund,
  getRefund,
} from "../../scripts/dict/refund-helper.js";

// ---------------------------------------------------------------------------
// Spec access
// ---------------------------------------------------------------------------

const spec = JSON.parse(
  fs.readFileSync(new URL("../spec/dict-2.12.1/openapi.json", import.meta.url), "utf-8"),
);
const schemas: Record<string, any> = spec.components.schemas;

function refName(ref: string): string {
  return ref.split("/").pop()!;
}

/** Follows $ref and merges allOf; keeps oneOf for the caller. */
function resolve(schema: any): any {
  while (schema?.$ref) schema = schemas[refName(schema.$ref)];
  if (!schema?.allOf) return schema;
  const merged: any = { ...schema, allOf: undefined, properties: {}, required: [] };
  for (const part of schema.allOf.map(resolve)) {
    for (const [k, v] of Object.entries(part)) {
      if (k === "properties") Object.assign(merged.properties, v);
      else if (k === "required") merged.required.push(...(v as string[]));
      else if (k !== "description") merged[k] ??= v;
    }
  }
  if (Object.keys(merged.properties).length === 0) delete merged.properties;
  return merged;
}

interface Operation {
  method: string;
  path: string;
  requestSchema?: string;
}

function operation(operationId: string): Operation {
  for (const [path, ops] of Object.entries<any>(spec.paths)) {
    for (const [method, op] of Object.entries<any>(ops)) {
      if (op?.operationId === operationId) {
        const ref = op.requestBody?.content?.["application/xml"]?.schema?.$ref;
        return { method: method.toUpperCase(), path, requestSchema: ref && refName(ref) };
      }
    }
  }
  throw new Error(`operationId not in spec: ${operationId}`);
}

function pathMatches(template: string, path: string): boolean {
  const re = new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
  return re.test(path);
}

function specRegex(pattern: string): RegExp {
  let flags = "";
  let p = pattern;
  if (p.includes("(?i)")) {
    p = p.replace("(?i)", "");
    flags = "i";
  }
  if (!p.startsWith("^")) p = `^${p}`;
  if (!p.endsWith("$")) p = `${p}$`;
  return new RegExp(p, flags);
}

// ---------------------------------------------------------------------------
// XML vs schema
// ---------------------------------------------------------------------------

const orderedParser = new XMLParser({ preserveOrder: true, parseTagValue: false, ignoreAttributes: false });

type Ordered = Record<string, any>[];

function elementsOf(children: Ordered): Array<{ name: string; children: Ordered }> {
  return children
    .filter((c) => !("#text" in c))
    .map((c) => {
      const name = Object.keys(c).find((k) => k !== ":@")!;
      return { name, children: c[name] as Ordered };
    });
}

function textOf(children: Ordered): string {
  return children.filter((c) => "#text" in c).map((c) => String(c["#text"])).join("");
}

function checkLeaf(path: string, schema: any, text: string): void {
  if (schema.enum) assert.ok(schema.enum.includes(text), `${path}: "${text}" not in enum ${schema.enum}`);
  if (schema.pattern) assert.match(text, specRegex(schema.pattern), `${path}: pattern ${schema.pattern}`);
  if (schema.maxLength) assert.ok(text.length <= schema.maxLength, `${path}: longer than ${schema.maxLength}`);
  if (schema.format === "uuid") assert.match(text, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, `${path}: uuid v4`);
  if (schema.format === "date-time") assert.ok(!Number.isNaN(Date.parse(text)), `${path}: date-time`);
  if (schema.type === "number") assert.match(text, /^\d+(\.\d{1,2})?$/, `${path}: currency`);
}

function checkElement(path: string, schemaIn: any, children: Ordered): void {
  let schema = resolve(schemaIn);
  if (schema.oneOf) {
    const type = textOf(elementsOf(children).find((e) => e.name === "Type")?.children ?? []);
    schema = resolve(schema.oneOf.find((v: any) => v.title === type));
    assert.ok(schema, `${path}: no oneOf variant for Type=${type}`);
  }

  if (!schema.properties) {
    if (schema.type === "object") return; // Signature placeholder
    checkLeaf(path, schema, textOf(children));
    return;
  }

  const order = Object.keys(schema.properties);
  const elements = elementsOf(children);
  const names = elements.map((e) => e.name);
  for (const name of names) assert.ok(order.includes(name), `${path}: unknown element <${name}>`);
  assert.equal(new Set(names).size, names.length, `${path}: duplicated elements ${names}`);
  const indexes = names.map((n) => order.indexOf(n));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), `${path}: order ${names} vs schema ${order}`);
  for (const req of schema.required ?? []) assert.ok(names.includes(req), `${path}: missing required <${req}>`);
  for (const e of elements) checkElement(`${path}/${e.name}`, schema.properties[e.name], e.children);
}

/** Parses the request and checks it against the operation's request schema. Returns the root name. */
function assertMatchesSpec(xml: string, operationId: string): string {
  const op = operation(operationId);
  assert.ok(op.requestSchema, `${operationId} has no request body`);
  const doc = orderedParser.parse(xml) as Ordered;
  const roots = elementsOf(doc.filter((n) => !("?xml" in n)));
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.equal(root.name, op.requestSchema, `${operationId}: root element`);
  assert.doesNotMatch(xml, /xmlns/, "DICT requests carry no namespace");
  assert.equal(elementsOf(root.children)[0]?.name, "Signature", "Signature must be the first child");
  checkElement(root.name, { $ref: `#/components/schemas/${op.requestSchema}` }, root.children);
  return root.name;
}

// ---------------------------------------------------------------------------
// Fake client: records calls to check method + path per operationId
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  body?: string;
  opts?: any;
}

function fakeClient(response: Partial<HttpResponse> = {}): { client: DictClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async call(method: string, path: string, body?: string, opts?: any): Promise<HttpResponse> {
      calls.push({ method, path, body, opts });
      return { statusCode: 200, headers: {}, body: "<Empty/>", ...response };
    },
  } as unknown as DictClient;
  return { client, calls };
}

function assertCall(call: Call, operationId: string): void {
  const op = operation(operationId);
  assert.equal(call.method, op.method, `${operationId}: method`);
  assert.ok(pathMatches(op.path, call.path), `${operationId}: ${call.path} vs ${op.path}`);
  if (op.requestSchema) assertMatchesSpec(call.body!, operationId);
  else assert.equal(call.body, undefined, `${operationId}: no body`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISPB = "12345678";
const UUID = "123e4567-e89b-42d3-a456-426655440000";
const account: BrazilianAccount = {
  participant: ISPB,
  branch: "0001",
  accountNumber: "0007654321",
  accountType: "CACC",
  openingDate: "2010-01-10T03:00:00Z",
};
const natural: Person = { type: "NATURAL_PERSON", taxIdNumber: "11122233300", name: "João Silva" };
const legal: Person = {
  type: "LEGAL_PERSON",
  taxIdNumber: "11222333000150",
  name: "Padaria Tres Irmãos & Filhos <Ltda>",
  tradeName: "Padaria 3 Irmãos",
};

function rejects(fn: () => unknown, what: string): void {
  assert.throws(fn, DictValidationError, what);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

test("createEntry: matches CreateEntryRequest for every key type", () => {
  const keys = { CPF: "11122233300", CNPJ: "11222333000150", PHONE: "+5561988880000", EMAIL: "pix@bcb.gov.br" };
  for (const [keyType, key] of Object.entries(keys)) {
    const owner = keyType === "CNPJ" ? legal : natural;
    const xml = buildCreateEntryRequest({ keyType: keyType as any, key, account, owner, requestId: UUID });
    assertMatchesSpec(xml, "createEntry");
    assert.match(xml, new RegExp(`<RequestId>${UUID}</RequestId>`));
  }
});

test("createEntry: EVP is sent without Key (generated by the DICT)", () => {
  const xml = buildCreateEntryRequest({ keyType: "EVP", account, owner: natural });
  assertMatchesSpec(xml, "createEntry");
  assert.doesNotMatch(xml, /<Key>/);
  rejects(() => buildCreateEntryRequest({ keyType: "EVP", key: UUID, account, owner: natural }), "EVP with key");
});

test("createEntry: random entries from the generator are valid", () => {
  for (const t of ["CPF", "CNPJ", "PHONE", "EMAIL", "EVP"] as const) {
    for (let i = 0; i < 20; i++) assertMatchesSpec(buildCreateEntryRequest(randomEntryParams(ISPB, t)), "createEntry");
  }
});

test("createEntry: escapes XML text and optional Branch may be omitted", () => {
  const xml = buildCreateEntryRequest({
    keyType: "CNPJ",
    key: legal.taxIdNumber,
    account: { ...account, branch: undefined },
    owner: legal,
  });
  assertMatchesSpec(xml, "createEntry");
  assert.match(xml, /Irmãos &amp; Filhos &lt;Ltda&gt;/);
  assert.doesNotMatch(xml, /<Branch>/);
  const parsed = new XMLParser({ parseTagValue: false }).parse(xml);
  assert.equal(parsed.CreateEntryRequest.Entry.Owner.Name, legal.name);
  assert.equal(escapeXml(`a'b"c`), "a&apos;b&quot;c");
});

test("createEntry: rejects input outside the spec", () => {
  const base = { keyType: "PHONE" as const, key: "+5561988880000", account, owner: natural };
  rejects(() => buildCreateEntryRequest({ ...base, keyType: "CPF", key: "1112223330" }), "CPF 10 digits");
  rejects(() => buildCreateEntryRequest({ ...base, key: "5561988880000" }), "phone without +");
  rejects(() => buildCreateEntryRequest({ ...base, keyType: "EMAIL", key: "Pix@bcb.gov.br" }), "uppercase e-mail");
  rejects(() => buildCreateEntryRequest({ ...base, keyType: "EMAIL", key: `${"a".repeat(70)}@bcb.gov.br` }), "e-mail > 77");
  rejects(() => buildCreateEntryRequest({ ...base, keyType: "BANANA" as any }), "key type");
  rejects(() => buildCreateEntryRequest({ ...base, account: { ...account, participant: "1234567" } }), "ISPB 7");
  rejects(() => buildCreateEntryRequest({ ...base, account: { ...account, participant: "9999a03x" } }), "ISPB lowercase");
  rejects(() => buildCreateEntryRequest({ ...base, account: { ...account, branch: "00001" } }), "branch 5 digits");
  rejects(() => buildCreateEntryRequest({ ...base, account: { ...account, accountNumber: "123-4" } }), "account number");
  rejects(() => buildCreateEntryRequest({ ...base, account: { ...account, accountType: "CHCK" as any } }), "account type");
  rejects(() => buildCreateEntryRequest({ ...base, account: { ...account, openingDate: "yesterday" } }), "opening date");
  rejects(() => buildCreateEntryRequest({ ...base, owner: { ...natural, taxIdNumber: "11222333000150" } }), "CPF 14");
  rejects(() => buildCreateEntryRequest({ ...base, owner: { ...legal, taxIdNumber: "11122233300" } }), "CNPJ 11");
  rejects(() => buildCreateEntryRequest({ ...base, owner: { ...natural, name: "João 2" } }), "digits in name");
  rejects(() => buildCreateEntryRequest({ ...base, owner: { ...natural, tradeName: "X" } }), "trade name for PF");
  rejects(() => buildCreateEntryRequest({ ...base, owner: { ...legal, tradeName: "***" } }), "trade name only *");
  rejects(() => buildCreateEntryRequest({ ...base, reason: "ACCOUNT_CLOSURE" as any }), "create reason");
  rejects(() => buildCreateEntryRequest({ ...base, requestId: "not-a-uuid" }), "request id");
});

test("deleteEntry: matches DeleteEntryRequest and validates Reason", () => {
  for (const reason of ["USER_REQUESTED", "ACCOUNT_CLOSURE", "RECONCILIATION", "FRAUD", "RFB_VALIDATION"] as const) {
    assertMatchesSpec(buildDeleteEntryRequest({ key: "+5561988887777", participant: ISPB, reason }), "deleteEntry");
  }
  rejects(() => buildDeleteEntryRequest({ key: "+5561988887777", participant: ISPB, reason: "BRANCH_TRANSFER" as any }), "reason");
  rejects(() => buildDeleteEntryRequest({ key: "not a key", participant: ISPB, reason: "USER_REQUESTED" }), "key");
});

test("entries: calls use the spec method and path", async () => {
  const { client, calls } = fakeClient({ statusCode: 201 });
  await createEntry(client, { keyType: "PHONE", key: "+5561988880000", account, owner: natural });
  await deleteEntry(client, { key: "+5561988880000", participant: ISPB, reason: "USER_REQUESTED" });
  assertCall(calls[0], "createEntry");
  assertCall(calls[1], "deleteEntry");
  assert.equal(calls[0].path, "/entries/");
  assert.equal(calls[1].path, "/entries/%2B5561988880000/delete");
});

test("getEntry: GET /entries/{Key} with the three PI-* headers", async () => {
  const e2e = generateEndToEndId(ISPB);
  const req = buildGetEntryRequest({ key: "+5561988880000", payerId: "11122233300", endToEndId: e2e });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/entries/%2B5561988880000");
  assert.ok(pathMatches(operation("getEntry").path, req.path));
  assert.equal(req.body, undefined);
  assert.equal(req.payerId, "11122233300");
  assert.equal(req.endToEndId, e2e);

  const headers = spec.paths["/entries/{Key}"].get.parameters.filter((p: any) => p.in === "header");
  assert.deepEqual(headers.map((h: any) => h.name).sort(), ["PI-EndToEndId", "PI-PayerId", "PI-RequestingParticipant"]);
  assert.ok(headers.every((h: any) => h.required));

  assert.equal(
    buildGetEntryRequest({ key: "pix@bcb.gov.br", payerId: "11222333000150", endToEndId: e2e, includeStatistics: true })
      .query?.IncludeStatistics,
    true,
  );
  rejects(() => buildGetEntryRequest({ key: "+5561988880000", payerId: "123", endToEndId: e2e }), "payer id");
  rejects(() => buildGetEntryRequest({ key: "+5561988880000", payerId: "11122233300", endToEndId: "" }), "e2e");
  rejects(() => buildGetEntryRequest({ key: "Nope", payerId: "11122233300", endToEndId: e2e }), "key");
  rejects(() => buildGetEntryRequest({ keyType: "CPF", key: "pix@bcb.gov.br", payerId: "11122233300", endToEndId: e2e }), "type");
});

test("getEntry: parses the spec's 200 example and treats 404 as not found", async () => {
  const example = Object.values<any>(
    spec.paths["/entries/{Key}"].get.responses["200"].content["application/xml"].examples,
  )[0].value;
  const parsed = parseGetEntryResponse(example);
  assert.equal(parsed.entry?.key, "11122233300");
  assert.equal(parsed.entry?.account.branch, "0001");
  assert.equal(parsed.entry?.owner.type, "NATURAL_PERSON");

  const ok = fakeClient({ statusCode: 200, body: example });
  const found = await lookupKey(ok.client, { key: "11122233300", payerId: "11122233300", endToEndId: generateEndToEndId(ISPB) });
  assert.equal(found.found, true);
  assert.deepEqual(ok.calls[0].opts.okStatus, [404]);
  assertCall(ok.calls[0], "getEntry");

  const notFound = fakeClient({ statusCode: 404, body: spec.components.responses.NotFound.content["application/problem+xml"].examples.example.value });
  const nf = await lookupKey(notFound.client, { key: "11122233300", payerId: "11122233300", endToEndId: generateEndToEndId(ISPB) });
  assert.equal(nf.found, false);
  assert.match(nf.error ?? "", /does not exist/);
});

test("detectKeyType follows the key table", () => {
  assert.equal(detectKeyType("11122233300"), "CPF");
  assert.equal(detectKeyType("11222333000150"), "CNPJ");
  assert.equal(detectKeyType("12ABC34501DE35"), "CNPJ");
  assert.equal(detectKeyType("+5561988880000"), "PHONE");
  assert.equal(detectKeyType("pix@bcb.gov.br"), "EMAIL");
  assert.equal(detectKeyType(UUID), "EVP");
  assert.equal(detectKeyType("foo"), undefined);
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

test("claims: builders match the request schemas", () => {
  const create = { claimerAccount: account, claimer: natural };
  assertMatchesSpec(buildCreateClaimRequest({ ...create, claimType: "OWNERSHIP", keyType: "PHONE", key: "+5561988887777" }), "createClaim");
  assertMatchesSpec(buildCreateClaimRequest({ ...create, claimType: "PORTABILITY", keyType: "EMAIL", key: "pix@bcb.gov.br" }), "createClaim");
  assertMatchesSpec(
    buildCreateClaimRequest({ claimerAccount: account, claimer: legal, claimType: "PORTABILITY", keyType: "CNPJ", key: legal.taxIdNumber }),
    "createClaim",
  );
  const op = { claimId: UUID, participant: ISPB };
  assertMatchesSpec(buildAcknowledgeClaimRequest(op), "acknowledgeClaim");
  for (const reason of ["USER_REQUESTED", "ACCOUNT_CLOSURE", "DEFAULT_OPERATION"] as const) {
    assertMatchesSpec(buildConfirmClaimRequest({ ...op, reason }), "confirmClaim");
  }
  for (const reason of ["USER_REQUESTED", "ACCOUNT_CLOSURE", "DEFAULT_OPERATION", "FRAUD", "RECONCILIATION", "RFB_VALIDATION"] as const) {
    assertMatchesSpec(buildCancelClaimRequest({ ...op, reason }), "cancelClaim");
  }
  assertMatchesSpec(buildCompleteClaimRequest(op), "completeClaim");
});

test("claims: rejects incompatible key types and reasons", () => {
  const create = { claimerAccount: account, claimer: natural };
  rejects(() => buildCreateClaimRequest({ ...create, claimType: "OWNERSHIP", keyType: "EMAIL", key: "pix@bcb.gov.br" }), "ownership email");
  rejects(() => buildCreateClaimRequest({ ...create, claimType: "OWNERSHIP", keyType: "CPF", key: "11122233300" }), "ownership cpf");
  rejects(() => buildCreateClaimRequest({ ...create, claimType: "PORTABILITY", keyType: "EVP", key: UUID }), "portability evp");
  rejects(() => buildCreateClaimRequest({ ...create, claimType: "TRANSFER" as any, keyType: "PHONE", key: "+5561988887777" }), "type");
  rejects(() => buildCreateClaimRequest({ ...create, claimType: "OWNERSHIP", keyType: "PHONE", key: "61988887777" }), "phone");
  const op = { claimId: UUID, participant: ISPB };
  rejects(() => buildConfirmClaimRequest({ ...op, reason: "FRAUD" as any }), "confirm FRAUD");
  rejects(() => buildCancelClaimRequest({ ...op, reason: "PARTICIPANT_EXCLUSION" as any }), "internal reason");
  rejects(() => buildAcknowledgeClaimRequest({ claimId: "CLAIM-ID-HERE", participant: ISPB }), "claim id");
  rejects(() => buildCompleteClaimRequest({ ...op, participant: "123" }), "participant");
  rejects(() => buildCompleteClaimRequest({ ...op, requestId: "x" }), "request id");
});

test("claims: calls use the spec method and path", async () => {
  const { client, calls } = fakeClient();
  const op = { claimId: UUID, participant: ISPB };
  await createClaim(client, { claimType: "OWNERSHIP", keyType: "PHONE", key: "+5561988887777", claimerAccount: account, claimer: natural });
  await getClaim(client, UUID);
  await acknowledgeClaim(client, op);
  await confirmClaim(client, { ...op, reason: "USER_REQUESTED" });
  await cancelClaim(client, { ...op, reason: "FRAUD" });
  await completeClaim(client, op);
  ["createClaim", "getClaim", "acknowledgeClaim", "confirmClaim", "cancelClaim", "completeClaim"]
    .forEach((id, i) => assertCall(calls[i], id));
});

// ---------------------------------------------------------------------------
// Infraction reports
// ---------------------------------------------------------------------------

test("infraction reports: builders match the request schemas", () => {
  const e2e = generateEndToEndId(ISPB);
  assertMatchesSpec(
    buildCreateInfractionReportRequest({ participant: ISPB, transactionId: e2e, reason: "REFUND_REQUEST", situationType: "SCAM" }),
    "createInfractionReport",
  );
  assertMatchesSpec(
    buildCreateInfractionReportRequest({
      participant: ISPB,
      transactionId: e2e,
      reason: "REFUND_CANCELLED",
      situationType: "OTHER",
      reportDetails: "Refund cancelled <after> analysis & review",
      contactInformation: { email: "abc@pix.br", phone: "+5561988887777" },
    }),
    "createInfractionReport",
  );
  const op = { infractionReportId: UUID, participant: ISPB };
  assertMatchesSpec(buildAcknowledgeInfractionReportRequest(op), "acknowledgeInfractionReport");
  assertMatchesSpec(buildCancelInfractionReportRequest(op), "cancelInfractionReport");
  assertMatchesSpec(
    buildCloseInfractionReportRequest({ ...op, analysisResult: "AGREED", fraudType: "OTHER", analysisDetails: "Blocked" }),
    "closeInfractionReport",
  );
  assertMatchesSpec(buildCloseInfractionReportRequest({ ...op, analysisResult: "DISAGREED" }), "closeInfractionReport");
});

test("infraction reports: rejects input outside the spec", () => {
  const base = { participant: ISPB, transactionId: generateEndToEndId(ISPB), reason: "REFUND_REQUEST" as const, situationType: "SCAM" as const };
  rejects(() => buildCreateInfractionReportRequest({ ...base, reason: "REFUND_CANCELLED" }), "cancel needs OTHER");
  rejects(() => buildCreateInfractionReportRequest({ ...base, situationType: "OTHER" }), "OTHER needs details");
  rejects(() => buildCreateInfractionReportRequest({ ...base, situationType: "UNKNOWN" as any }), "UNKNOWN is v1");
  rejects(() => buildCreateInfractionReportRequest({ ...base, reason: "FRAUD" as any }), "v1 FRAUD reason");
  rejects(() => buildCreateInfractionReportRequest({ ...base, transactionId: "E123" }), "transaction id");
  rejects(() => buildCreateInfractionReportRequest({ ...base, reportDetails: "x".repeat(2001) }), "details > 2000");
  rejects(() => buildCreateInfractionReportRequest({ ...base, contactInformation: { email: "abc@pix.br", phone: "61988887777" } }), "phone");
  const op = { infractionReportId: UUID, participant: ISPB };
  rejects(() => buildCloseInfractionReportRequest({ ...op, analysisResult: "AGREED" }), "AGREED needs FraudType");
  rejects(() => buildCloseInfractionReportRequest({ ...op, analysisResult: "AGREED", fraudType: "UNKNOWN" as any }), "UNKNOWN");
  rejects(() => buildCloseInfractionReportRequest({ ...op, analysisResult: "AGREED", fraudType: "OTHER" }), "OTHER needs details");
  rejects(() => buildCloseInfractionReportRequest({ ...op, analysisResult: "ACCEPTED" as any }), "result");
  rejects(() => buildAcknowledgeInfractionReportRequest({ ...op, infractionReportId: "INFRACTION-ID-HERE" }), "id");
});

test("infraction reports: calls use the spec method and path", async () => {
  const { client, calls } = fakeClient();
  const op = { infractionReportId: UUID, participant: ISPB };
  await createInfractionReport(client, { participant: ISPB, transactionId: generateEndToEndId(ISPB), reason: "REFUND_REQUEST", situationType: "COERCION" });
  await getInfractionReport(client, UUID);
  await acknowledgeInfractionReport(client, op);
  await closeInfractionReport(client, { ...op, analysisResult: "AGREED", fraudType: "MULE_ACCOUNT" });
  await cancelInfractionReport(client, op);
  ["createInfractionReport", "getInfractionReport", "acknowledgeInfractionReport", "closeInfractionReport", "cancelInfractionReport"]
    .forEach((id, i) => assertCall(calls[i], id));
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

test("refunds: builders match the request schemas", () => {
  const e2e = generateEndToEndId(ISPB);
  assertMatchesSpec(
    buildCreateRefundRequest({ participant: ISPB, transactionId: e2e, refundReason: "FRAUD", refundAmount: 100 }),
    "createRefund",
  );
  const xml = buildCreateRefundRequest({
    participant: ISPB,
    transactionId: e2e,
    refundReason: "OPERATIONAL_FLAW",
    refundAmount: 0.1,
    refundDetails: "Duplicated payment",
  });
  assertMatchesSpec(xml, "createRefund");
  assert.match(xml, /<RefundAmount>0.10<\/RefundAmount>/);
  const op = { refundId: UUID, participant: ISPB };
  assertMatchesSpec(buildCancelRefundRequest(op), "cancelRefund");
  assertMatchesSpec(
    buildCloseRefundRequest({
      ...op,
      refundAnalysisResult: "PARTIALLY_ACCEPTED",
      refundAnalysisDetails: "Partial balance",
      refundTransactionId: generateDevolutionEndToEndId(ISPB),
      effectiveRefundedAmount: 50.5,
    }),
    "closeRefund",
  );
  assertMatchesSpec(
    buildCloseRefundRequest({ ...op, refundAnalysisResult: "REJECTED", refundRejectionReason: "INVALID_REQUEST", refundAnalysisDetails: "No flaw found" }),
    "closeRefund",
  );
});

test("refunds: rejects input outside the spec", () => {
  const base = { participant: ISPB, transactionId: generateEndToEndId(ISPB), refundReason: "FRAUD" as const, refundAmount: 10 };
  rejects(() => buildCreateRefundRequest({ ...base, refundReason: "REFUND_CANCELLED (DEPRECATED)" as any }), "deprecated");
  rejects(() => buildCreateRefundRequest({ ...base, refundReason: "OPERATIONAL_FLAW" }), "flaw needs details");
  rejects(() => buildCreateRefundRequest({ ...base, refundAmount: 0 }), "zero");
  rejects(() => buildCreateRefundRequest({ ...base, refundAmount: 1.234 }), "3 decimals");
  rejects(() => buildCreateRefundRequest({ ...base, transactionId: "E1234" }), "transaction id");
  rejects(() => buildCreateRefundRequest({ ...base, participant: "abc" }), "participant");
  const op = { refundId: UUID, participant: ISPB };
  rejects(() => buildCloseRefundRequest({ ...op, refundAnalysisResult: "TOTALLY_ACCEPTED", refundRejectionReason: "OTHER" }), "reason w/o REJECTED");
  rejects(() => buildCloseRefundRequest({ ...op, refundAnalysisResult: "REJECTED", refundRejectionReason: "INVALID_REQUEST" }), "needs details");
  rejects(() => buildCloseRefundRequest({ ...op, refundAnalysisResult: "REJECTED", refundRejectionReason: "PARTICIPANT_EXCLUSION" as any }), "internal");
  rejects(() => buildCloseRefundRequest({ ...op, refundAnalysisResult: "ACCEPTED" as any }), "result");
  rejects(() => buildCloseRefundRequest({ ...op, refundAnalysisResult: "TOTALLY_ACCEPTED", refundTransactionId: "D1" }), "rtr id");
  rejects(() => buildCancelRefundRequest({ refundId: "REFUND-ID-HERE", participant: ISPB }), "refund id");
});

test("refunds: calls use the spec method and path", async () => {
  const { client, calls } = fakeClient();
  const op = { refundId: UUID, participant: ISPB };
  await createRefund(client, { participant: ISPB, transactionId: generateEndToEndId(ISPB), refundReason: "FRAUD", refundAmount: 1 });
  await getRefund(client, UUID);
  await cancelRefund(client, op);
  await closeRefund(client, { ...op, refundAnalysisResult: "REJECTED", refundRejectionReason: "NO_BALANCE" });
  ["createRefund", "getRefund", "cancelRefund", "closeRefund"].forEach((id, i) => assertCall(calls[i], id));
});

// ---------------------------------------------------------------------------
// The checker itself agrees with the spec's own examples
// ---------------------------------------------------------------------------

test("schema checker accepts every request example in the spec for the operations used", () => {
  const ids = [
    "createEntry", "deleteEntry", "createClaim", "acknowledgeClaim", "confirmClaim", "cancelClaim", "completeClaim",
    "createInfractionReport", "acknowledgeInfractionReport", "cancelInfractionReport", "closeInfractionReport",
    "createRefund", "cancelRefund", "closeRefund",
  ];
  for (const id of ids) {
    const op = operation(id);
    const examples = spec.paths[op.path][op.method.toLowerCase()].requestBody.content["application/xml"].examples;
    for (const ex of Object.values<any>(examples)) {
      // Spec examples use non-v4 UUIDs and free-text with line breaks; only structure matters here.
      const xml = String(ex.value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, UUID);
      assertMatchesSpec(xml, id);
    }
  }
});

test("schema checker rejects wrong order, unknown, missing elements and bad values", () => {
  const good = buildDeleteEntryRequest({ key: "+5561988887777", participant: ISPB, reason: "FRAUD" });
  assertMatchesSpec(good, "deleteEntry");
  const swap = good.replace(
    /(<Key>.*<\/Key>)(\s*)(<Participant>.*<\/Participant>)/,
    "$3$2$1",
  );
  assert.throws(() => assertMatchesSpec(swap, "deleteEntry"), /order/);
  assert.throws(() => assertMatchesSpec(good.replace("<Reason>", "<Extra>x</Extra><Reason>"), "deleteEntry"), /unknown element/);
  assert.throws(() => assertMatchesSpec(good.replace(/<Reason>.*<\/Reason>/, ""), "deleteEntry"), /missing required/);
  assert.throws(() => assertMatchesSpec(good.replace("FRAUD", "OOPS"), "deleteEntry"), /enum/);
  assert.throws(() => assertMatchesSpec(good.replace("<Signature></Signature>", ""), "deleteEntry"), /Signature/);
  assert.throws(() => assertMatchesSpec(good.replace("DeleteEntryRequest>", "DeleteKeyRequest>").replace("<DeleteEntryRequest>", "<DeleteKeyRequest>"), "deleteEntry"), /root element/);
  const entry = buildCreateEntryRequest({ keyType: "PHONE", key: "+5561988880000", account, owner: natural });
  assert.throws(() => assertMatchesSpec(entry.replace("<Branch>0001</Branch>", "<Branch>00001</Branch>"), "createEntry"), /pattern/);
  assert.throws(() => assertMatchesSpec(entry.replace(/<OpeningDate>.*<\/OpeningDate>/, ""), "createEntry"), /missing required <OpeningDate>/);
});
