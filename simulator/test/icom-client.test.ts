/**
 * Exercita o IcomClient contra um ICOM minimo, com mTLS, que segue o
 * Manual das Interfaces de Comunicacao 1.12: envio em /in, leitura em
 * /out/stream com PI-Pull-Next, DELETE no fim, Host sem porta, gzip e
 * lista fechada de cabecalhos.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

import { IcomClient, DictClient, buildMultipart, parseMultipart, HttpError } from "../../scripts/utils/http-client.js";

const ISPB = "12345678";
const ALLOWED = new Set([
  "accept", "accept-encoding", "connection", "content-encoding", "content-length", "content-type",
  "cookie", "host", "max-forwards", "transfer-encoding", "user-agent", "via",
]);

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
let dir = "";
let server: https.Server;
let baseUrl = "";
const outbox: string[] = [];
const received: string[] = [];
const seen: { method: string; url: string; headers: Record<string, unknown> }[] = [];

function openssl(...args: string[]): void {
  const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

before(() => {
  if (!hasOpenssl) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "icom-"));
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=ca", "-keyout", "ca.key", "-out", "ca.pem");
  for (const name of ["server", "client"]) {
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", `${name}.key`, "-out", `${name}.csr`);
    fs.writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", "ext.cnf", "-out", `${name}.pem`);
  }
});

before(async () => {
  if (!hasOpenssl) return;
  let stream = 0;
  server = https.createServer(
    {
      key: fs.readFileSync(path.join(dir, "server.key")),
      cert: fs.readFileSync(path.join(dir, "server.pem")),
      ca: fs.readFileSync(path.join(dir, "ca.pem")),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers });
        const extra = Object.keys(req.headers).filter((h) => !ALLOWED.has(h) && !h.startsWith("pi-"));
        if (extra.length || String(req.headers.host).includes(":")) {
          res.writeHead(400, { "content-type": "application/problem+xml" }).end("<problem/>");
          return;
        }

        if (req.method === "POST" && req.url === `/api/v1/in/${ISPB}/msgs`) {
          const ct = String(req.headers["content-type"]);
          let body = Buffer.concat(chunks);
          if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
          if (!ct.includes("charset=utf-8") && !ct.startsWith("multipart/mixed")) {
            res.writeHead(415).end();
            return;
          }
          const msgs = ct.startsWith("multipart/")
            ? parseMultipart(body.toString("utf8"), ct).map((m) => m.xml)
            : [body.toString("utf8")];
          received.push(...msgs);
          res.writeHead(201, { "PI-ResourceId": msgs.map((_, i) => `rid${received.length - msgs.length + i}`).join(",") }).end();
          return;
        }

        const read = req.url === `/api/v1/out/${ISPB}/stream/start` || req.url!.startsWith(`/api/v1/out/${ISPB}/stream/s`);
        if (req.method === "GET" && read) {
          const next = `/api/v1/out/${ISPB}/stream/s${++stream}`;
          if (outbox.length === 0) {
            setTimeout(() => res.writeHead(204, { "PI-Pull-Next": next }).end(), 50);
            return;
          }
          const batch = outbox.splice(0, 10);
          const { contentType, body } = buildMultipart(batch, "b");
          const withIds = body.replace(/Content-Type: application\/xml; charset=utf-8\r\n/g, (m) => `${m}PI-ResourceId: out${stream}\r\n`);
          res.writeHead(200, { "PI-Pull-Next": next, "Content-Type": contentType, "Content-Encoding": "gzip" });
          res.end(zlib.gzipSync(withIds));
          return;
        }

        if (req.method === "DELETE" && req.url!.startsWith(`/api/v1/out/${ISPB}/stream/`)) {
          res.writeHead(200).end();
          return;
        }

        if (req.method === "POST" && req.url === "/api/v2/entries/") {
          const plain = req.headers["content-encoding"] === undefined && Buffer.concat(chunks).toString().startsWith("<?xml");
          res.writeHead(plain ? 201 : 400, { "content-type": "application/xml" }).end("<CreateEntryResponse/>");
          return;
        }

        if (req.method === "GET" && req.url!.startsWith("/api/v2/entries/")) {
          res.writeHead(404, { "content-type": "application/problem+xml" }).end("<problem/>");
          return;
        }

        res.writeHead(404).end();
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function client(): IcomClient {
  return new IcomClient({
    baseUrl,
    ispb: ISPB,
    certPath: path.join(dir, "client.pem"),
    keyPath: path.join(dir, "client.key"),
    caPath: path.join(dir, "ca.pem"),
    maxRetries: 0,
  });
}

const skip = !hasOpenssl && "openssl nao instalado";

test("icom: envio avulso e multipart em /in com gzip e Host sem porta", { skip }, async () => {
  const c = client();
  try {
    const one = await c.sendMessages("<Envelope>1</Envelope>");
    assert.equal(one.statusCode, 201);
    assert.equal(one.resourceIds.length, 1);

    const many = await c.sendMessages(["<Envelope>2</Envelope>", "<Envelope>3</Envelope>"]);
    assert.equal(many.resourceIds.length, 2);
    assert.deepEqual(received.slice(-3), ["<Envelope>1</Envelope>", "<Envelope>2</Envelope>", "<Envelope>3</Envelope>"]);

    const post = seen.filter((s) => s.method === "POST").at(-1)!;
    assert.equal(post.headers.host, "localhost");
    assert.equal(post.headers["content-encoding"], "gzip");

    await assert.rejects(c.sendMessages([]), /between 1 and 10/);
    await assert.rejects(c.sendMessages(Array(11).fill("<x/>")), /between 1 and 10/);
  } finally {
    c.destroy();
  }
});

test("icom: leitura segue PI-Pull-Next e fecha o stream com DELETE", { skip }, async () => {
  const c = client();
  try {
    outbox.push("<Envelope>pacs.002 A</Envelope>", "<Envelope>pacs.002 B</Envelope>");
    const msgs = await c.readUntil((m) => m.xml.includes("B"), 2_000);
    assert.deepEqual(msgs.map((m) => m.xml), ["<Envelope>pacs.002 A</Envelope>", "<Envelope>pacs.002 B</Envelope>"]);
    assert.ok(msgs.every((m) => m.resourceId?.startsWith("out")));

    const reads = seen.filter((s) => s.url.includes("/stream/"));
    assert.equal(reads[0].url, `/api/v1/out/${ISPB}/stream/start`);
    assert.equal(reads[0].headers.accept, "multipart/mixed");
    const del = reads.at(-1)!;
    assert.equal(del.method, "DELETE");
    assert.match(del.url, /\/stream\/s\d+$/);
  } finally {
    c.destroy();
  }
});

test("icom: leitura vazia devolve 204 com PI-Pull-Next", { skip }, async () => {
  const c = client();
  try {
    const read = await c.readStream();
    assert.equal(read.statusCode, 204);
    assert.deepEqual(read.messages, []);
    await c.closeStream(read.pullNext);
  } finally {
    c.destroy();
  }
});

test("dict: consulta usa /api/v2, cabecalhos PI-* e nao compacta o corpo", { skip }, async () => {
  const d = new DictClient({
    baseUrl,
    ispb: ISPB,
    certPath: path.join(dir, "client.pem"),
    keyPath: path.join(dir, "client.key"),
    caPath: path.join(dir, "ca.pem"),
    maxRetries: 0,
  });
  try {
    const res = await d.call("GET", "/entries/%2B5561988880000", undefined, {
      payerId: "11111111111",
      endToEndId: "E12345678202609281200abcdefghijk",
      okStatus: [404],
    });
    assert.equal(res.statusCode, 404);
    const req = seen.at(-1)!;
    assert.equal(req.url, "/api/v2/entries/%2B5561988880000");
    assert.equal(req.headers["pi-requestingparticipant"], ISPB);
    assert.equal(req.headers["pi-payerid"], "11111111111");
    assert.equal(req.headers["pi-endtoendid"], "E12345678202609281200abcdefghijk");

    await assert.rejects(d.call("GET", "/entries/x"), (err: unknown) => err instanceof HttpError && err.statusCode === 404);

    const created = await d.call("POST", "/entries/", '<?xml version="1.0" encoding="UTF-8"?><CreateEntryRequest/>');
    assert.equal(created.statusCode, 201);
    assert.equal(seen.at(-1)!.headers["content-encoding"], undefined);
  } finally {
    d.destroy();
  }
});
