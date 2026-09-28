import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { validateSpiMessage, hasXmllint } from "../src/core/xsd.js";
import { generatePacs008, type Pacs008Params } from "../../scripts/spi/pacs008-generator.js";
import { generatePacs002 } from "../../scripts/spi/pacs002-generator.js";
import { generatePacs004 } from "../../scripts/spi/pacs004-generator.js";
import { SPI_ISPB, spiNamespace, spiMsgDefIdr } from "../../scripts/spi/spi-envelope.js";
import { readPacs002 } from "../../scripts/spi/send-pix.js";
import {
  generateEndToEndId,
  generateDevolutionEndToEndId,
  END_TO_END_ID_PATTERN,
  RETURN_ID_PATTERN,
} from "../../scripts/utils/endtoendid-generator.js";
import { generateBizMsgIdr, BIZ_MSG_IDR_PATTERN } from "../../scripts/utils/biz-message-id-generator.js";
import { buildMultipart, parseMultipart } from "../../scripts/utils/http-client.js";

const EXAMPLES = new URL("../spec/spi-5.13.1/exemplos/", import.meta.url);
const skipXsd = !hasXmllint() && "xmllint nao instalado";

function base(overrides: Partial<Pacs008Params> = {}): Pacs008Params {
  return {
    senderIspb: "12345678",
    receiverIspb: "99999A04",
    amount: 10.5,
    debitParty: { name: "Fulano", document: "11111111111", branch: "1", accountNumber: "1", accountType: "CACC" },
    creditParty: { document: "11111111111", branch: "1", accountNumber: "1", accountType: "CACC" },
    ...overrides,
  };
}

function assertValid(xml: string): void {
  const result = validateSpiMessage(xml);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
}

test("xsd: exemplos oficiais do catalogo 5.13 validam", { skip: skipXsd }, () => {
  const files = fs.readdirSync(EXAMPLES);
  assert.ok(files.length >= 7);
  for (const f of files) {
    assertValid(fs.readFileSync(new URL(f, EXAMPLES), "utf8"));
  }
});

test("xsd: versao nao habilitada e recusada", { skip: skipXsd }, () => {
  const old = generatePacs008(base()).replace(spiNamespace("pacs.008"), "https://www.bcb.gov.br/pi/pacs.008/1.13");
  const result = validateSpiMessage(old);
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /Schema desconhecido/);
});

test("xsd: sem assinatura so passa com allowUnsigned", { skip: skipXsd }, () => {
  const xml = generatePacs008(base());
  assert.equal(validateSpiMessage(xml, { allowUnsigned: false }).valid, false);
  assert.equal(validateSpiMessage(xml).valid, true);
});

test("pacs.008: variacoes validam no XSD oficial", { skip: skipXsd }, () => {
  assertValid(generatePacs008(base()));
  assertValid(generatePacs008(base({ localInstrument: "DICT", proxy: "+5561988880000", description: "a & <b>" })));
  assertValid(generatePacs008(base({ localInstrument: "QRDN", proxy: "fulano@x.com", txId: "a".repeat(30) })));
  assertValid(generatePacs008(base({ priority: "NORM", serviceLevel: "PAGAGD" })));
  assertValid(generatePacs008(base({ localInstrument: "INIC", proxy: "11111111111", txId: "abc", initiatingPartyCnpj: "12345678000195" })));
  assertValid(generatePacs008(base({
    creditParty: { document: "12ABC34501DE35", accountNumber: "ABC123", accountType: "TRAN" },
  })));
});

test("pacs.008: envelope vai do PSP para o SPI e o recebedor fica no CdtrAgt", () => {
  const xml = generatePacs008(base());
  assert.ok(xml.includes(`<Envelope xmlns="${spiNamespace("pacs.008")}">`));
  assert.ok(xml.includes(`<MsgDefIdr>${spiMsgDefIdr("pacs.008")}</MsgDefIdr>`));
  assert.match(xml, /<To>[\s\S]*?<Id>00038166<\/Id>[\s\S]*?<\/To>/);
  assert.match(xml, /<CdtrAgt>[\s\S]*?<MmbId>99999A04<\/MmbId>/);
  assert.match(xml, /<CreDt>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z<\/CreDt>/);
  assert.equal(SPI_ISPB, "00038166");
});

test("pacs.008: regras do catalogo sao aplicadas", () => {
  assert.throws(() => generatePacs008(base({ priority: "HIGH", serviceLevel: "PAGAGD" })), /PAGPRI/);
  assert.throws(() => generatePacs008(base({ priority: "NORM", serviceLevel: "PAGPRI" })), /NORM/);
  assert.throws(() => generatePacs008(base({ localInstrument: "MANU", proxy: "x@y.com" })), /must not carry Prxy/);
  assert.throws(() => generatePacs008(base({ localInstrument: "DICT" })), /requires the Pix key/);
  assert.throws(() => generatePacs008(base({ creditParty: { document: "1", accountNumber: "1", accountType: "CACC" } })), /document/);
  assert.throws(() => generatePacs008(base({ creditParty: { document: "11111111111", accountNumber: "1", accountType: "SLRY" } })), /SLRY/);
  assert.throws(() => generatePacs008(base({ debitParty: { document: "11111111111", accountNumber: "1", accountType: "CACC" } })), /name/);
  assert.throws(() => generatePacs008(base({ senderIspb: "123" })), /ISPB/);
  assert.throws(() => generatePacs008(base({ amount: -1 })), /amount/);
});

test("pacs.002: ACSP e RJCT validam e exigem motivo", { skip: skipXsd }, () => {
  const e2e = generateEndToEndId("99999A03");
  assertValid(generatePacs002({ senderIspb: "12345678", originalEndToEndId: e2e, status: "ACSP" }));
  assertValid(generatePacs002({ senderIspb: "12345678", originalEndToEndId: e2e, status: "RJCT", rejectReasonCode: "AC03", additionalInfo: "conta inexistente" }));
  assert.throws(() => generatePacs002({ senderIspb: "12345678", originalEndToEndId: e2e, status: "RJCT" }), /reason/i);
  assert.throws(() => generatePacs002({ senderIspb: "12345678", originalEndToEndId: "E123", status: "ACSP" }), /OrgnlEndToEndId/);
});

test("pacs.004: devolucao valida, com RtrId D e agentes originais", { skip: skipXsd }, () => {
  const e2e = generateEndToEndId("99999A03");
  const xml = generatePacs004({
    senderIspb: "12345678",
    originalPayerIspb: "99999A03",
    originalEndToEndId: e2e,
    amount: 10.5,
    returnReasonCode: "FR01",
    description: "devolucao MED",
  });
  assertValid(xml);
  assert.match(xml, /<RtrId>D12345678\d{12}[A-Za-z0-9]{11}<\/RtrId>/);
  assert.match(xml, /<DbtrAgt>[\s\S]*?<MmbId>99999A03<\/MmbId>[\s\S]*?<CdtrAgt>[\s\S]*?<MmbId>12345678<\/MmbId>/);
});

test("ids: formatos oficiais", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-28T23:59:00Z").getTime() });
  const e2e = generateEndToEndId("99999A04");
  assert.match(e2e, END_TO_END_ID_PATTERN);
  assert.equal(e2e.slice(9, 21), "202609282359");
  assert.match(generateDevolutionEndToEndId("99999A04"), RETURN_ID_PATTERN);
  assert.match(generateBizMsgIdr("99999A04"), BIZ_MSG_IDR_PATTERN);
  assert.throws(() => generateEndToEndId("9999a04"));
});

test("multipart: ida e volta preserva mensagens e PI-ResourceId", () => {
  const { contentType, body } = buildMultipart(["<a/>", "<b>2</b>"], "simple boundary");
  assert.equal(contentType, 'multipart/mixed; boundary="simple boundary"');
  assert.deepEqual(parseMultipart(body, contentType).map((m) => m.xml), ["<a/>", "<b>2</b>"]);

  const fromManual = [
    "--simple boundary",
    "Content-type: application/xml; charset=utf-8",
    "PI-ResourceId: UEkBbgR78VqKK/uvuq9O0r9bqXyBH9Ur",
    "",
    "<xml1/>",
    "--simple boundary",
    "Content-type: application/xml; charset=utf-8",
    "PI-ResourceId: dTkENva+UQ6gnwMrojr1NLxC/3Ot32bd",
    "",
    "<xml2/>",
    "--simple boundary--",
  ].join("\r\n");
  assert.deepEqual(parseMultipart(fromManual, 'multipart/mixed; boundary="simple boundary"'), [
    { resourceId: "UEkBbgR78VqKK/uvuq9O0r9bqXyBH9Ur", xml: "<xml1/>" },
    { resourceId: "dTkENva+UQ6gnwMrojr1NLxC/3Ot32bd", xml: "<xml2/>" },
  ]);
});

test("send-pix: identifica o pacs.002 da propria transacao", () => {
  const e2e = generateEndToEndId("12345678");
  const other = generateEndToEndId("12345678");
  const rjct = generatePacs002({ senderIspb: SPI_ISPB, receiverIspb: "12345678", originalEndToEndId: e2e, status: "RJCT", rejectReasonCode: "AB03" });
  assert.deepEqual(
    { ...readPacs002(rjct, e2e), xml: undefined },
    { status: "RJCT", reason: "AB03", xml: undefined },
  );
  assert.equal(readPacs002(rjct, other), undefined);
  assert.equal(readPacs002(generatePacs008(base()), e2e), undefined);
});
