/**
 * Jornada completa contra o simulador: dois PSPs (10000001 e 20000002) falam
 * com o ICOM e o DICT simulados por mTLS, usando os clientes do toolkit.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";

import { createSimulator, type Simulator } from "../src/index.js";
import { generateCerts } from "../tools/gen-certs.js";
import { IcomClient, DictClient, HttpError, type ReceivedMessage } from "../../scripts/utils/http-client.js";
import { generatePacs008, type Pacs008Params } from "../../scripts/spi/pacs008-generator.js";
import { generatePacs002 } from "../../scripts/spi/pacs002-generator.js";
import { generatePacs004 } from "../../scripts/spi/pacs004-generator.js";
import { validateSpiMessage, hasXmllint } from "../src/core/xsd.js";
import { buildCreateEntryRequest } from "../../scripts/dict/key-bulk-creator.js";
import { lookupKey } from "../../scripts/dict/key-lookup.js";
import { generateEndToEndId } from "../../scripts/utils/endtoendid-generator.js";

const A = "10000001";
const B = "20000002";
const skip = (spawnSync("openssl", ["version"]).status !== 0 || !hasXmllint()) && "precisa de openssl e xmllint";

let dir = "";
let sim: Simulator;
const clients: Record<string, IcomClient> = {};

function icom(ispb: string): IcomClient {
  return (clients[ispb] ??= new IcomClient({
    baseUrl: sim.urls.icom,
    ispb,
    certPath: path.join(dir, `${ispb}.pem`),
    keyPath: path.join(dir, `${ispb}.key`),
    caPath: path.join(dir, "ca.pem"),
    maxRetries: 0,
  }));
}

function dict(ispb: string): DictClient {
  return new DictClient({
    baseUrl: sim.urls.dict,
    ispb,
    certPath: path.join(dir, `${ispb}.pem`),
    keyPath: path.join(dir, `${ispb}.key`),
    caPath: path.join(dir, "ca.pem"),
    maxRetries: 0,
  });
}

function pix(overrides: Partial<Pacs008Params> = {}): { xml: string; e2e: string } {
  const e2e = generateEndToEndId(overrides.senderIspb ?? A);
  const xml = generatePacs008({
    senderIspb: A,
    receiverIspb: B,
    amount: 100,
    endToEndId: e2e,
    debitParty: { name: "Ana", document: "12345678909", branch: "1", accountNumber: "111", accountType: "CACC" },
    creditParty: { document: "98765432100", branch: "1", accountNumber: "222", accountType: "CACC" },
    ...overrides,
  });
  return { xml, e2e };
}

const has = (id: string, what: RegExp) => (m: ReceivedMessage) => m.xml.includes(id) && what.test(m.xml);

async function waitFor(ispb: string, id: string, what: RegExp, ms = 3_000): Promise<string> {
  const msgs = await icom(ispb).readUntil(has(id, what), ms);
  const found = msgs.find(has(id, what));
  assert.ok(found, `${ispb} nao recebeu ${what} para ${id}; recebeu: ${msgs.map((m) => m.xml.slice(0, 80)).join(" | ")}`);
  return found.xml;
}

const balance = (ispb: string) => sim.participants.get(ispb)!.balanceCents;

before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-"));
  generateCerts(dir, [A, B, "30000003"]);
  sim = createSimulator({
    certDir: dir,
    icomPort: 0,
    dictPort: 0,
    ctlPort: 0,
    settlementTimeoutMs: 1_500,
    longPollMs: 150,
    streamIdleMs: 400,
    virtualReplyMs: 10,
    logLevel: "error",
    participants: `${A}:Banco Alfa:1000,${B}:Banco Beta:1000`,
  });
  await sim.start();
});

after(async () => {
  for (const c of Object.values(clients)) c.destroy();
  await sim?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("pix para 99999A04: cooperativa virtual aceita e o SPI liquida", { skip }, async () => {
  const before = balance(A);
  const { xml, e2e } = pix({ receiverIspb: "99999A04", amount: 12.34 });
  const sent = await icom(A).sendMessages(xml);
  assert.equal(sent.statusCode, 201);
  const acsc = await waitFor(A, e2e, /<TxSts>ACSC<\/TxSts>/);
  assert.deepEqual(validateSpiMessage(acsc).errors, []);
  assert.equal(balance(A), before - 1234);
});

test("pix entre dois PSPs: pacs.008 chega ao recebedor, ACSP liquida, ACSC e ACCC", { skip }, async () => {
  const [a0, b0] = [balance(A), balance(B)];
  const { xml, e2e } = pix({ amount: 50 });
  await icom(A).sendMessages(xml);

  const incoming = await waitFor(B, e2e, /pacs\.008/);
  assert.deepEqual(validateSpiMessage(incoming).errors, [], "pacs.008 encaminhada pelo SPI valida no XSD");
  assert.match(incoming, /<Fr>[\s\S]*?<Id>00038166<\/Id>/);
  assert.match(incoming, /<MsgId>M00038166/);

  await icom(B).sendMessages(generatePacs002({ senderIspb: B, originalEndToEndId: e2e, status: "ACSP" }));
  const acsc = await waitFor(A, e2e, /<TxSts>ACSC<\/TxSts>/);
  const accc = await waitFor(B, e2e, /<TxSts>ACCC<\/TxSts>/);
  assert.match(acsc, /<FctvIntrBkSttlmDt>/);
  assert.deepEqual(validateSpiMessage(accc).errors, []);
  assert.equal(balance(A), a0 - 5000);
  assert.equal(balance(B), b0 + 5000);
  assert.equal(sim.engine.settlements.get(e2e)?.status, "SETTLED");
});

test("recebedor rejeita com AC03 e o pagador recebe o RJCT", { skip }, async () => {
  const a0 = balance(A);
  const { xml, e2e } = pix();
  await icom(A).sendMessages(xml);
  await waitFor(B, e2e, /pacs\.008/);
  await icom(B).sendMessages(generatePacs002({ senderIspb: B, originalEndToEndId: e2e, status: "RJCT", rejectReasonCode: "AC03" }));
  await waitFor(A, e2e, /<Cd>AC03<\/Cd>/);
  assert.equal(balance(A), a0);
});

test("sem resposta do recebedor em 40s (aqui 1,5s) o SPI rejeita com AB03 para os dois", { skip }, async () => {
  const { xml, e2e } = pix();
  await icom(A).sendMessages(xml);
  await waitFor(B, e2e, /pacs\.008/);
  await waitFor(A, e2e, /<Cd>AB03<\/Cd>/, 4_000);
  await waitFor(B, e2e, /<Cd>AB03<\/Cd>/, 2_000);
  // pacs.002 tardio e ignorado.
  await icom(B).sendMessages(generatePacs002({ senderIspb: B, originalEndToEndId: e2e, status: "ACSP" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sim.engine.settlements.get(e2e)?.status, "REJECTED");
});

test("devolucao pacs.004: o recebedor devolve e o dinheiro volta", { skip }, async () => {
  const { xml, e2e } = pix({ amount: 30 });
  await icom(A).sendMessages(xml);
  await waitFor(B, e2e, /pacs\.008/);
  await icom(B).sendMessages(generatePacs002({ senderIspb: B, originalEndToEndId: e2e, status: "ACSP" }));
  await waitFor(A, e2e, /ACSC/);
  await waitFor(B, e2e, /ACCC/);
  const [a0, b0] = [balance(A), balance(B)];

  const ret = generatePacs004({ senderIspb: B, originalPayerIspb: A, originalEndToEndId: e2e, amount: 30, returnReasonCode: "MD06" });
  const rtrId = /<RtrId>([^<]+)</.exec(ret)![1];
  await icom(B).sendMessages(ret);
  const incoming = await waitFor(A, rtrId, /pacs\.004/);
  assert.deepEqual(validateSpiMessage(incoming).errors, []);
  await icom(A).sendMessages(generatePacs002({ senderIspb: A, originalEndToEndId: e2e, originalInstructionId: rtrId, status: "ACSP" }));
  await waitFor(B, rtrId, /ACSC/);
  await waitFor(A, rtrId, /ACCC/);
  assert.equal(balance(A), a0 + 3000);
  assert.equal(balance(B), b0 - 3000);
});

test("regras do SPI: RC10, AG12, AM04, DS02 e AGNT", { skip }, async () => {
  const cases: [Partial<Pacs008Params>, string][] = [
    [{ receiverIspb: "30000003" }, "RC10"],
    [{ receiverIspb: A }, "AG12"],
    [{ amount: 999_999 }, "AM04"],
  ];
  for (const [over, code] of cases) {
    const { xml, e2e } = pix(over);
    await icom(A).sendMessages(xml);
    if (code === "AM04") {
      await waitFor(B, e2e, /pacs\.008/);
      await icom(B).sendMessages(generatePacs002({ senderIspb: B, originalEndToEndId: e2e, status: "ACSP" }));
    }
    await waitFor(A, e2e, new RegExp(`<Cd>${code}</Cd>`));
  }

  sim.participants.get(A)!.sendBlocked = true;
  const blocked = pix();
  await icom(A).sendMessages(blocked.xml);
  await waitFor(A, blocked.e2e, /<Cd>DS02<\/Cd>/);
  sim.participants.get(A)!.sendBlocked = false;
});

test("mensagem invalida vira admi.002 com o PI-ResourceId", { skip }, async () => {
  const bad = pix().xml.replace("<ChrgBr>SLEV</ChrgBr>", "");
  const { resourceIds } = await icom(A).sendMessages(bad);
  const admi = await waitFor(A, resourceIds[0], /admi\.002/);
  assert.deepEqual(validateSpiMessage(admi).errors, []);
  assert.match(admi, /XML invalido/);

  const oldVersion = pix().xml.replace("pacs.008/1.16", "pacs.008/1.13");
  const r2 = await icom(A).sendMessages(oldVersion);
  await waitFor(A, r2.resourceIds[0], /Schema desconhecido/);
});

test("idempotencia: a mesma mensagem enviada duas vezes liquida uma vez", { skip }, async () => {
  const { xml, e2e } = pix({ receiverIspb: "99999A04", amount: 1 });
  const a0 = balance(A);
  await icom(A).sendMessages(xml);
  await icom(A).sendMessages(xml);
  await waitFor(A, e2e, /ACSC/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(balance(A), a0 - 100);
});

test("stream sem DELETE: o lote volta para a fila com o mesmo ResourceId", { skip }, async () => {
  const { xml, e2e } = pix({ receiverIspb: "99999A04", amount: 1 });
  await icom(A).sendMessages(xml);
  await new Promise((r) => setTimeout(r, 300));

  const first = await icom(A).readStream();
  const target = first.messages.find(has(e2e, /ACSC/));
  assert.ok(target);
  // Abandona o stream sem seguir o PI-Pull-Next nem DELETE.
  await new Promise((r) => setTimeout(r, 5_500));
  const again = await icom(A).readUntil(has(e2e, /ACSC/), 2_000);
  assert.equal(again.find(has(e2e, /ACSC/))?.resourceId, target.resourceId);
});

test("limite de 6 streams de leitura por participante: o 7o recebe 429", { skip }, async () => {
  const c = icom(B);
  const opened = await Promise.all(Array.from({ length: 6 }, () => c.readStream()));
  await assert.rejects(c.readStream(), (e: unknown) => e instanceof HttpError && e.statusCode === 429);
  for (const s of opened) await c.closeStream(s.pullNext);
});

test("catalogo do ICOM lista as versoes aceitas", { skip }, async () => {
  assert.deepEqual(await icom(A).catalog("in"), ["pacs.002.spi.1.17", "pacs.004.spi.1.5", "pacs.008.spi.1.16"]);
});

test("ICOM recusa charset errado e cabecalho fora da lista", { skip }, async () => {
  const call = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const url = new URL(`/api/v1/in/${A}/msgs`, sim.urls.icom);
      const req = https.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        cert: fs.readFileSync(path.join(dir, `${A}.pem`)),
        key: fs.readFileSync(path.join(dir, `${A}.key`)),
        ca: fs.readFileSync(path.join(dir, "ca.pem")),
        headers: { host: "localhost", "content-length": "3", ...headers },
      }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end("<a/>".slice(0, 3));
    });
  assert.equal(await call({ "content-type": "application/xml; charset=utf-16" }), 400);
  assert.equal(await call({ "content-type": "text/plain" }), 415);
  assert.equal(await call({ "content-type": "application/xml; charset=utf-8", "x-datadog-trace-id": "1" }), 400);
});

test("certificado de um PSP nao opera pelo ISPB de outro", { skip }, async () => {
  const intruder = new IcomClient({
    baseUrl: sim.urls.icom,
    ispb: B,
    certPath: path.join(dir, `${A}.pem`),
    keyPath: path.join(dir, `${A}.key`),
    caPath: path.join(dir, "ca.pem"),
    maxRetries: 0,
  });
  await assert.rejects(intruder.sendMessages(pix().xml), (e: unknown) => e instanceof HttpError && e.statusCode === 403);
  intruder.destroy();
});

test("DICT: cadastro, consulta de outro PSP, consulta do proprio PSP e 404", { skip }, async () => {
  const da = dict(A);
  const db = dict(B);
  const created = await db.call("POST", "/entries/", buildCreateEntryRequest({
    keyType: "EMAIL",
    key: "maria@beta.com",
    account: { participant: B, branch: "1", accountNumber: "222", accountType: "CACC", openingDate: "2020-01-01T03:00:00.000Z" },
    owner: { type: "NATURAL_PERSON", taxIdNumber: "98765432100", name: "Maria Souza" },
  }));
  assert.equal(created.statusCode, 201);

  const found = await lookupKey(da, { key: "maria@beta.com", payerId: "12345678909", endToEndId: generateEndToEndId(A) });
  assert.equal(found.found, true);
  assert.equal(found.entry?.account.participant, B);

  await assert.rejects(
    lookupKey(db, { key: "maria@beta.com", payerId: "12345678909", endToEndId: generateEndToEndId(B) }),
    (e: unknown) => e instanceof HttpError && /EntryCannotBeQueriedForBookTransfer/.test(e.body),
  );

  const missing = await lookupKey(da, { key: "ninguem@x.com", payerId: "12345678909", endToEndId: generateEndToEndId(A) });
  assert.equal(missing.found, false);

  await assert.rejects(
    db.call("POST", "/entries/", buildCreateEntryRequest({
      keyType: "EMAIL",
      key: "maria@beta.com",
      account: { participant: B, branch: "1", accountNumber: "999", accountType: "CACC", openingDate: "2020-01-01T03:00:00.000Z" },
      owner: { type: "NATURAL_PERSON", taxIdNumber: "11111111111", name: "Outra Pessoa" },
    })),
    (e: unknown) => e instanceof HttpError && /EntryKeyOwnedByDifferentPerson/.test(e.body),
  );
  da.destroy();
  db.destroy();
});

test("DICT antiscan: 404 custa 20 fichas e o 6o erro do mesmo pagador PF da 429", { skip }, async () => {
  const da = dict(A);
  const payer = "52998224725";
  for (let i = 0; i < 5; i++) {
    const r = await lookupKey(da, { key: `nao${i}@x.com`, payerId: payer, endToEndId: generateEndToEndId(A) });
    assert.equal(r.found, false);
  }
  await assert.rejects(
    lookupKey(da, { key: "mais@x.com", payerId: payer, endToEndId: generateEndToEndId(A) }),
    (e: unknown) => e instanceof HttpError && e.statusCode === 429,
  );
  da.destroy();
});

test("Banco Virtual 99999A03 envia Pix com os dados do Roteiro", { skip }, async () => {
  const e2e = sim.virtual.sendPix({ to: B, amount: 5 });
  const incoming = await waitFor(B, e2e, /pacs\.008/);
  assert.match(incoming, /<Nm>Fulano<\/Nm>/);
  assert.match(incoming, /<MmbId>99999A03<\/MmbId>/);
  await icom(B).sendMessages(generatePacs002({ senderIspb: B, originalEndToEndId: e2e, status: "ACSP" }));
  await waitFor(B, e2e, /ACCC/);
});

test("linha do tempo registra a jornada de uma transacao", { skip }, async () => {
  const { xml, e2e } = pix({ receiverIspb: "99999A04", amount: 2 });
  await icom(A).sendMessages(xml);
  await waitFor(A, e2e, /ACSC/);
  const steps = sim.timeline.list({ txId: e2e }).map((e) => e.message);
  assert.ok(steps.some((m) => m.includes("Ordem de pagamento")));
  assert.ok(steps.some((m) => m.startsWith("LIQUIDADA")));
});
