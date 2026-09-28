import { test } from "node:test";
import assert from "node:assert/strict";

import { crc16, parseTlv } from "../../scripts/qrcode/emv.js";
import { generateStaticQr, generateDynamicQr } from "../../scripts/qrcode/qr-generator.js";
import { parseQrPayload } from "../../scripts/qrcode/qr-parser.js";

/** Exemplos da secao 2 do Manual de Padroes para Iniciacao do Pix 2.10.0. */
const MANUAL_STATIC =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";

const MANUAL_DYNAMIC =
  "00020101021226700014br.gov.bcb.pix2548pix.example.com/8b3da2f39a4140d1a91abd93113bd4415204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***630464E4";

test("emv: CRC do exemplo oficial do QR estatico", () => {
  assert.equal(crc16(MANUAL_STATIC.slice(0, -4)), "1D3D");
});

test("gerador: reproduz byte a byte o exemplo oficial do QR estatico", () => {
  const payload = generateStaticQr({
    pixKey: "123e4567-e12b-12d1-a456-426655440000",
    merchantName: "Fulano de Tal",
    merchantCity: "BRASILIA",
  });
  assert.equal(payload, MANUAL_STATIC);
});

test("gerador: valor nao torna o QR de uso unico", () => {
  const payload = generateStaticQr({ pixKey: "fulano@x.com", merchantName: "F", merchantCity: "SP", amount: 10 });
  assert.equal(parseTlv(payload).some((f) => f.id === "01"), false);
  assert.ok(payload.includes("540510.00"));
  const single = generateStaticQr({ pixKey: "fulano@x.com", merchantName: "F", merchantCity: "SP", singleUse: true });
  assert.ok(single.startsWith("0002010102122"));
});

test("gerador: regras de tamanho e txid", () => {
  assert.throws(() => generateStaticQr({ pixKey: "k".repeat(77), merchantName: "F", merchantCity: "SP", description: "texto" }), /99/);
  assert.throws(() => generateStaticQr({ pixKey: "k", merchantName: "F", merchantCity: "SP", txId: "com-hifen" }), /txid/);
  assert.throws(() => generateDynamicQr({ pixUrl: "https://x.com/a", merchantName: "F", merchantCity: "SP" }), /https/);
});

test("parser: exemplo oficial e estatico, CRC ok, sem problemas", () => {
  const r = parseQrPayload(MANUAL_STATIC);
  assert.equal(r.crcValid, true);
  assert.equal(r.isStatic, true);
  assert.equal(r.isDynamic, false);
  assert.equal(r.pixKey, "123e4567-e12b-12d1-a456-426655440000");
  assert.equal(r.txId, "***");
  assert.deepEqual(r.issues, []);
});

test("gerador e parser: reproduz o exemplo oficial do QR dinamico", () => {
  const payload = generateDynamicQr({
    pixUrl: "pix.example.com/8b3da2f39a4140d1a91abd93113bd441",
    merchantName: "Fulano de Tal",
    merchantCity: "BRASILIA",
    singleUse: true,
  });
  assert.equal(payload, MANUAL_DYNAMIC);
  const r = parseQrPayload(payload);
  assert.equal(r.isDynamic, true);
  assert.equal(r.singleUse, true);
  assert.deepEqual(r.issues, []);
});

test("parser: detecta CRC errado e template Pix fora do ID 26", () => {
  const broken = MANUAL_STATIC.slice(0, -4) + "0000";
  assert.equal(parseQrPayload(broken).crcValid, false);

  const moved = MANUAL_STATIC.slice(0, -8).replace("2658", "2758");
  const withCrc = moved + "6304" + crc16(moved + "6304");
  const r = parseQrPayload(withCrc);
  assert.equal(r.pixKey, "123e4567-e12b-12d1-a456-426655440000");
  assert.deepEqual(r.issues, []);
});
