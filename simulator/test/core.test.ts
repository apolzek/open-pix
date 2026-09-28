import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RateLimiter,
  antiscanCost,
  policyCost,
  paymentSentCredit,
  userAntiscanPolicy,
  POLICIES,
  PARTICIPANT_CATEGORIES,
} from "../src/core/bucket.js";
import {
  generateEndToEndId,
  checkEndToEndId,
  generateBizMsgIdr,
  computeCid,
  correlationId,
  isoNow,
} from "../src/core/ids.js";
import { DictProblem, escapeXml, DICT_ERROR_BASE } from "../src/core/problem.js";
import { parseXml, pick, pickText, asArray, el, indent } from "../src/core/xml.js";
import { setLevel } from "../src/core/log.js";

setLevel("error");

test("bucket: comeca cheio e recusa quando zera", () => {
  const rl = new RateLimiter("C");
  assert.equal(rl.allows("KEYS_CHECK", "12345678"), true);
  rl.charge("KEYS_CHECK", "12345678", 70);
  assert.equal(rl.allows("KEYS_CHECK", "12345678"), false);
  const snap = rl.list("12345678").find((b) => b.policy === "KEYS_CHECK")!;
  assert.equal(snap.size, 70);
  assert.equal(snap.tokens, 0);
});

test("bucket: donos diferentes tem baldes independentes", () => {
  const rl = new RateLimiter();
  rl.charge("KEYS_CHECK", "A", 70);
  assert.equal(rl.allows("KEYS_CHECK", "B"), true);
});

test("bucket: repoe fichas com o tempo", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const rl = new RateLimiter();
  rl.charge("KEYS_CHECK", "X", 70);
  t.mock.timers.tick(60_000);
  const snap = rl.list("X")[0];
  assert.equal(snap.tokens, 70);
  rl.charge("POLICIES_LIST", "X", 20);
  t.mock.timers.tick(30_000);
  assert.equal(rl.list("X").find((b) => b.policy === "POLICIES_LIST")!.tokens, 3);
});

test("bucket: antiscan do participante segue a categoria", () => {
  const rl = new RateLimiter("A");
  rl.charge("ENTRIES_READ_PARTICIPANT_ANTISCAN", "P", 1);
  let snap = rl.list("P")[0];
  assert.equal(snap.size, PARTICIPANT_CATEGORIES.A.size);
  rl.setCategory("H");
  snap = rl.list("P")[0];
  assert.equal(snap.size, 50);
  assert.equal(snap.refillPerMin, 2);
  assert.ok(snap.tokens <= 50);
  rl.setCategory("Z");
  assert.equal(rl.list("P")[0].size, 50);
});

test("bucket: tabela de categorias A a H da API v2", () => {
  assert.deepEqual(Object.keys(PARTICIPANT_CATEGORIES), ["A", "B", "C", "D", "E", "F", "G", "H"]);
  assert.deepEqual(PARTICIPANT_CATEGORIES.A, { refillPerMin: 25_000, size: 50_000 });
  assert.deepEqual(PARTICIPANT_CATEGORIES.C, { refillPerMin: 15_000, size: 30_000 });
  const rl = new RateLimiter("E");
  rl.charge("ENTRIES_STATISTICS_READ", "P", 1);
  assert.equal(rl.list("P")[0].size, 5_000);
  assert.ok(POLICIES.FRAUD_MARKERS_WRITE && POLICIES.EVENT_LIST && POLICIES.PERSONS_STATISTICS_READ);
  assert.equal(POLICIES.STATISTICS_READ, undefined);
});

test("bucket: usuario PJ tem balde maior que PF", () => {
  const rl = new RateLimiter();
  rl.charge("ENTRIES_READ_USER_ANTISCAN", "PF:11111111111", 1);
  rl.charge("ENTRIES_READ_USER_ANTISCAN", "PJ:11111111000111", 1);
  const snaps = rl.list();
  const pf = snaps.find((b) => b.owner.startsWith("PF:"))!;
  const pj = snaps.find((b) => b.owner.startsWith("PJ:"))!;
  assert.deepEqual([pf.size, pf.refillPerMin], [100, 2]);
  assert.deepEqual([pj.size, pj.refillPerMin], [1_000, 20]);
});

test("bucket: credit nao passa do tamanho e disabled nunca recusa", () => {
  const rl = new RateLimiter();
  rl.charge("KEYS_CHECK", "Y", 10);
  rl.credit("KEYS_CHECK", "Y", 100);
  assert.equal(rl.list("Y")[0].tokens, 70);
  rl.enabled = false;
  rl.charge("KEYS_CHECK", "Y", 1000);
  assert.equal(rl.allows("KEYS_CHECK", "Y"), true);
});

test("bucket: politica desconhecida lanca erro", () => {
  assert.throws(() => new RateLimiter().allows("NAO_EXISTE", "x"));
  assert.ok(Object.keys(POLICIES).length > 20);
});

test("bucket: custo do antiscan por status", () => {
  assert.equal(antiscanCost(200, "USER"), 1);
  assert.equal(antiscanCost(404, "USER"), 20);
  assert.equal(antiscanCost(404, "PSP"), 3);
  assert.equal(antiscanCost(500, "PSP"), 0);
  assert.equal(policyCost(200), 1);
  assert.equal(policyCost(400), 1);
  assert.equal(policyCost(500), 0);
});

test("bucket: politica por tipo de chave e credito por pagamento enviado", () => {
  assert.equal(userAntiscanPolicy("EMAIL"), "ENTRIES_READ_USER_ANTISCAN");
  assert.equal(userAntiscanPolicy("PHONE"), "ENTRIES_READ_USER_ANTISCAN");
  assert.equal(userAntiscanPolicy("CPF"), "ENTRIES_READ_USER_ANTISCAN_V2");
  assert.equal(userAntiscanPolicy("EVP"), "ENTRIES_READ_USER_ANTISCAN_V2");
  assert.equal(paymentSentCredit("ENTRIES_READ_USER_ANTISCAN", "PF:1"), 1);
  assert.equal(paymentSentCredit("ENTRIES_READ_USER_ANTISCAN_V2", "PJ:1"), 2);
  assert.equal(paymentSentCredit("ENTRIES_READ_PARTICIPANT_ANTISCAN", "P"), 1);
  assert.equal(paymentSentCredit("KEYS_CHECK", "P"), 0);
});

test("ids: EndToEndId gerado e valido", () => {
  for (let i = 0; i < 200; i++) {
    const e2e = generateEndToEndId("12345678");
    assert.equal(e2e.length, 32);
    const chk = checkEndToEndId(e2e);
    assert.deepEqual(chk, { valid: true, ispb: "12345678", devolution: false });
  }
  assert.equal(checkEndToEndId(generateEndToEndId("99999A04")).valid, true);
  assert.equal(checkEndToEndId("E99999a04202609281200abcdefghijk").valid, false);
  const dev = generateEndToEndId("12345678", true);
  assert.equal(dev[0], "D");
  assert.equal(checkEndToEndId(dev).devolution, true);
});

test("ids: EndToEndId invalidos sao recusados", () => {
  assert.equal(checkEndToEndId("E123").valid, false);
  assert.equal(checkEndToEndId("X12345678202609281200abcdefghijk").valid, false);
  assert.equal(checkEndToEndId("E12345678202613281200abcdefghijk").valid, false);
  assert.equal(checkEndToEndId("E12345678202609002400abcdefghijk").valid, false);
  assert.equal(checkEndToEndId("E12345678202609282400abcdefghijk").valid, false);
  assert.equal(checkEndToEndId("E12345678202609281260abcdefghijk").valid, false);
  assert.equal(checkEndToEndId(undefined as unknown as string).valid, false);
});

test("ids: EndToEndId usa data e hora em UTC", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-28T01:30:00Z").getTime() });
  assert.equal(generateEndToEndId("12345678").slice(9, 21), "202609280130");
});

test("ids: BizMsgIdr tem 32 posicoes", () => {
  const id = generateBizMsgIdr("12345678");
  assert.match(id, /^M12345678[A-Za-z0-9]{23}$/);
  assert.equal(id.length, 32);
});

test("ids: CID deterministico e sensivel aos campos", () => {
  const base = {
    key: "a@b.com", keyType: "EMAIL", participant: "12345678", branch: "0001",
    accountNumber: "0007654321", accountType: "CACC", taxIdNumber: "11122233344", requestId: "r1",
  };
  const cid = computeCid(base);
  assert.match(cid, /^[0-9a-f]{64}$/);
  assert.equal(computeCid({ ...base }), cid);
  assert.notEqual(computeCid({ ...base, branch: "0002" }), cid);
  assert.match(correlationId(), /^[0-9a-f]{32}$/);
});

test("ids: formatos de data", () => {
  const at = new Date("2026-09-28T15:04:05.123Z");
  assert.equal(isoNow(at), "2026-09-28T15:04:05.123Z");

});

test("problem: XML RFC 7807", () => {
  const p = new DictProblem("EntryAlreadyExists", "chave <x> & y");
  assert.equal(p.status, 400);
  assert.equal(new DictProblem("ClaimKeyNotFound").status, 404);
  const doc = parseXml(p.toXml());
  assert.equal(pickText(doc, "problem.type"), `${DICT_ERROR_BASE}/EntryAlreadyExists`);
  assert.equal(pickText(doc, "problem.status"), "400");
  assert.equal(pickText(doc, "problem.detail"), "chave <x> & y");
  assert.equal(new DictProblem("NotFound").toXml().includes("<detail>"), false);
  assert.equal(escapeXml(`<a b="c">'&'`), "&lt;a b=&quot;c&quot;&gt;&apos;&amp;&apos;");
});

test("xml: preserva zero a esquerda, namespace e listas", () => {
  const doc = parseXml(`<ns:Doc xmlns:ns="urn:x"><Acct Tp="CACC">0001234</Acct><Id>00038166</Id><I>1</I></ns:Doc>`);
  assert.equal(pickText(doc, "Doc.Id"), "00038166");
  assert.equal(pickText(doc, "Doc.Acct"), "0001234");
  assert.equal(pick(doc, "Doc.Acct.@Tp"), "CACC");
  assert.equal(pick(doc, "Doc.Nada.Mais"), undefined);
  assert.deepEqual(asArray(pick(doc, "Doc.I")), ["1"]);
  assert.deepEqual(asArray(undefined), []);
  assert.equal(el("A", "x&y", { t: "1" }), `<A t="1">x&amp;y</A>`);
  assert.equal(el("A", ""), "<A/>");
  assert.equal(el("A", 0), "<A>0</A>");
  assert.equal(indent("a\n\nb", 2), "  a\n\n  b");
});

test("config: defaults carregam", async () => {
  const { config } = await import("../src/config.js");
  assert.equal(config.icomPort, 16522);
  assert.equal(config.tlsEnabled, true);
  assert.equal(config.spiIspb, "00038166");
  assert.equal(config.settlementTimeoutMs, 40_000);
  assert.equal(config.spiMessageVersions["pacs.008"], "1.16");
  assert.ok(config.certDir.endsWith("/simulator/certs/"));
});
