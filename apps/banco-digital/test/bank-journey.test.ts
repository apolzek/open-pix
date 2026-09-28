/**
 * Jornadas do banco digital de ponta a ponta: Banco Alfa e Banco Beta
 * falando com o Bacen simulado, pelos mesmos metodos que a pagina usa.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";

import { startDemo } from "../src/demo.js";
import type { Bank, Tx } from "../src/bank.js";

const skip = (spawnSync("openssl", ["version"]).status !== 0 || spawnSync("xmllint", ["--version"]).status !== 0) && "precisa de openssl e xmllint";

let dir = "";
let demo: Awaited<ReturnType<typeof startDemo>>;
let alfa: Bank;
let beta: Bank;

before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-"));
  // O diario escreve no console; nos testes basta o historico.
  console.log = () => undefined;
  demo = await startDemo({
    certDir: dir,
    alfaPort: 0,
    betaPort: 0,
    ctlPort: 0,
    icomPort: 0,
    dictPort: 0,
    quiet: true,
    sim: { settlementTimeoutMs: 2_000, longPollMs: 150, virtualReplyMs: 10 },
  });
  alfa = demo.alfa;
  beta = demo.beta;
});

after(async () => {
  await demo?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const byName = (bank: Bank, name: string) => [...bank.customers.values()].find((c) => c.name.startsWith(name))!;

async function settled(bank: Bank, id: string, ms = 4_000): Promise<Tx> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const tx = bank.txs.get(id);
    if (tx && tx.status !== "PENDENTE") return tx;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`${id} continuou pendente`);
}

test("Pix por chave do Alfa para o Beta: consulta DICT, SPI liquida, Maria recebe", { skip }, async () => {
  const ana = byName(alfa, "Ana");
  const maria = byName(beta, "Maria");
  const [a0, m0] = [ana.balanceCents, maria.balanceCents];

  const prep = await alfa.prepareByKey(ana.id, "maria@beta.com.br");
  assert.equal(prep.name, "Maria Souza");
  const tx = await alfa.confirm(prep.paymentId as string, 5000, "almoco");
  assert.equal((await settled(alfa, tx.id)).status, "CONCLUIDO");
  assert.equal((await settled(beta, tx.id)).status, "CONCLUIDO");
  assert.equal(ana.balanceCents, a0 - 5000);
  assert.equal(maria.balanceCents, m0 + 5000);
  assert.equal(demo.sim.engine.settlements.get(tx.id)?.localInstrument, "DICT");
});

test("chave do proprio banco vira transferencia interna, sem SPI", { skip }, async () => {
  const ana = byName(alfa, "Ana");
  const bruno = byName(alfa, "Bruno");
  const [a0, b0] = [ana.balanceCents, bruno.balanceCents];
  const before = demo.sim.engine.settlements.size;

  const prep = await alfa.prepareByKey(ana.id, "+5511988887777");
  const tx = await alfa.confirm(prep.paymentId as string, 1000);
  assert.equal(tx.kind, "internal");
  assert.equal(tx.status, "CONCLUIDO");
  assert.equal(ana.balanceCents, a0 - 1000);
  assert.equal(bruno.balanceCents, b0 + 1000);
  assert.equal(demo.sim.engine.settlements.size, before);
});

test("chave inexistente: DICT responde 404", { skip }, async () => {
  await assert.rejects(alfa.prepareByKey(byName(alfa, "Ana").id, "ninguem@x.com"), /nao encontrada/);
});

test("QR Code estatico: Beta gera para a Padaria, Alfa paga com QRES e txid", { skip }, async () => {
  const padaria = byName(beta, "Padaria");
  const bruno = byName(alfa, "Bruno");
  const p0 = padaria.balanceCents;
  const payload = beta.generateQr(padaria.id, padaria.keys.find((k) => k.type === "CNPJ")!.key, 1250, "PEDIDO42");

  const prep = await alfa.prepareByKey(bruno.id, "", { qr: payload });
  assert.equal(prep.fixedAmount, 1250);
  const tx = await alfa.confirm(prep.paymentId as string, 1);
  assert.equal(tx.amountCents, 1250, "valor do QR prevalece");
  await settled(beta, tx.id);
  assert.equal(padaria.balanceCents, p0 + 1250);
  assert.equal(demo.sim.engine.settlements.get(tx.id)?.localInstrument, "QRES");
});

test("Pix por agencia e conta (MANU) para a cooperativa virtual 99999A04", { skip }, async () => {
  const ana = byName(alfa, "Ana");
  const tx = await alfa.sendManual(ana.id, { ispb: "99999A04", branch: "1", account: "1", accountType: "CACC", document: "11111111111" }, 700);
  assert.equal((await settled(alfa, tx.id)).status, "CONCLUIDO");
});

test("banco inexistente: SPI rejeita com RC10 e o valor volta para o cliente", { skip }, async () => {
  const ana = byName(alfa, "Ana");
  const a0 = ana.balanceCents;
  const tx = await alfa.sendManual(ana.id, { ispb: "30000003", account: "1", accountType: "CACC", document: "11111111111" }, 700);
  const done = await settled(alfa, tx.id);
  assert.equal(done.status, "REJEITADO");
  assert.equal(done.reason, "RC10");
  assert.equal(ana.balanceCents, a0);
});

test("conta inexistente no recebedor: Beta rejeita com AC03", { skip }, async () => {
  const ana = byName(alfa, "Ana");
  const a0 = ana.balanceCents;
  const tx = await alfa.sendManual(ana.id, { ispb: "20000002", branch: "7", account: "99999", accountType: "CACC", document: "98765432100" }, 700);
  const done = await settled(alfa, tx.id);
  assert.equal(done.reason, "AC03");
  assert.equal(ana.balanceCents, a0);
});

test("Banco Virtual 99999A03 paga Maria pelos dados da conta", { skip }, async () => {
  const maria = byName(beta, "Maria");
  const m0 = maria.balanceCents;
  const e2e = demo.sim.virtual.sendPix({ to: "20000002", amount: 3, creditor: { document: maria.taxId, branch: maria.branch, accountNumber: maria.account } });
  assert.equal((await settled(beta, e2e)).status, "CONCLUIDO");
  assert.equal(maria.balanceCents, m0 + 300);
});

test("devolucao parcial: Maria devolve R$ 20 e Ana recebe de volta", { skip }, async () => {
  const ana = byName(alfa, "Ana");
  const maria = byName(beta, "Maria");
  const prep = await alfa.prepareByKey(ana.id, "+5521999990000");
  const pix = await alfa.confirm(prep.paymentId as string, 6000);
  await settled(beta, pix.id);
  const [a0, m0] = [ana.balanceCents, maria.balanceCents];

  const ret = await beta.returnPix(pix.id, 2000);
  assert.equal((await settled(beta, ret.id)).status, "CONCLUIDO");
  assert.equal((await settled(alfa, ret.id)).status, "CONCLUIDO");
  assert.equal(ana.balanceCents, a0 + 2000);
  assert.equal(maria.balanceCents, m0 - 2000);
  assert.equal(beta.txs.get(pix.id)!.returnedCents, 2000);
  await assert.rejects(beta.returnPix(pix.id, 5000), /invalido/);
});

test("envio bloqueado no SPI: DS02 e estorno", { skip }, async () => {
  const ana = byName(alfa, "Ana");
  const a0 = ana.balanceCents;
  demo.sim.participants.get("10000001")!.sendBlocked = true;
  const prep = await alfa.prepareByKey(ana.id, "maria@beta.com.br");
  const tx = await alfa.confirm(prep.paymentId as string, 100);
  const done = await settled(alfa, tx.id);
  demo.sim.participants.get("10000001")!.sendBlocked = false;
  assert.equal(done.reason, "DS02");
  assert.equal(ana.balanceCents, a0);
});

test("recebedor fora do ar: SPI rejeita com AB03 e Ana recebe o estorno", { skip }, async () => {
  const ana = byName(alfa, "Ana");
  const a0 = ana.balanceCents;
  beta.setOffline(true); // Beta para de ler o ICOM e nao responde
  const prep = await alfa.prepareByKey(ana.id, "maria@beta.com.br");
  const tx = await alfa.confirm(prep.paymentId as string, 100);
  const done = await settled(alfa, tx.id, 5_000);
  assert.equal(done.reason, "AB03");
  assert.equal(ana.balanceCents, a0);

  // De volta, o Beta le a pacs.008 atrasada, responde, e o SPI ignora; depois chega o RJCT AB03.
  const maria = byName(beta, "Maria");
  const m0 = maria.balanceCents;
  beta.setOffline(false);
  const late = await settled(beta, tx.id, 5_000);
  assert.equal(late.status, "REJEITADO");
  assert.equal(late.reason, "AB03");
  assert.equal(maria.balanceCents, m0);
});

test("pagina e API do banco respondem", { skip }, async () => {
  const get = (url: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      http.get(url, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (res.headers["content-type"]?.startsWith("text/event-stream")) res.destroy();
        });
        res.on("close", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body }));
      }).on("error", reject);
    });
  const page = await get(`${demo.urls.alfa}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Diário do banco/);
  const js = await get(`${demo.urls.alfa}/app.js`);
  assert.match(js.type, /javascript/);
  const state = JSON.parse((await get(`${demo.urls.alfa}/api/state`)).body);
  assert.equal(state.bank.ispb, "10000001");
  assert.ok(state.transactions.length > 5);
  const sse = await get(`${demo.urls.alfa}/api/journey/stream`);
  assert.match(sse.body, /event: (start|step)/);
  const participants = JSON.parse((await get(`${demo.urls.ctl}/participants`)).body);
  assert.equal(participants.length, 4);
  assert.equal((await get(`${demo.urls.alfa}/../../etc/passwd`)).status, 404);
});
