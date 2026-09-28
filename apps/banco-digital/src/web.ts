/**
 * Servidor web do banco: pagina estatica + API JSON usada por ela.
 *
 *   GET  /api/state                   clientes, saldos e extrato
 *   GET  /api/journey/stream          diario de bordo ao vivo (SSE)
 *   GET  /api/config                  URL da API de controle do simulador
 *   POST /api/customers/{id}/keys     {type, key?}      cadastra chave no DICT
 *   POST /api/pix/prepare             {customerId, key} ou {customerId, qr}
 *   POST /api/pix/confirm             {paymentId, amount, description?}
 *   POST /api/pix/manual              {customerId, ispb, branch, account, accountType, document, name?, amount}
 *   POST /api/pix/{id}/return         {amount}
 *   POST /api/qr                      {customerId, key, amount?, txId?}
 *   POST /api/lab/offline             {on}  banco para de ler o ICOM (AB03)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import type { Bank } from "./bank.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const cents = (v: unknown) => Math.round(Number(String(v ?? "").replace(",", ".")) * 100);

export function startWeb(bank: Bank, port: number, extra: { ctlUrl: string; theme: string }): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://bank");
    const p = url.pathname;
    try {
      if (p === "/api/state") return json(res, 200, bank.snapshot());
      if (p === "/api/config") return json(res, 200, { ctlUrl: extra.ctlUrl, theme: extra.theme, ...bank.snapshot().bank });

      if (p === "/api/journey/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        for (const item of bank.log.recent()) send("type" in item ? "start" : "step", item);
        const onStart = (i: unknown) => send("start", i);
        const onStep = (s: unknown) => send("step", s);
        bank.log.on("start", onStart);
        bank.log.on("step", onStep);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(ping);
          bank.log.off("start", onStart);
          bank.log.off("step", onStep);
        });
        return;
      }

      if (req.method === "POST") {
        const b = await readJson(req);
        const keyRoute = /^\/api\/customers\/([\w-]+)\/keys$/.exec(p);
        if (keyRoute) return json(res, 201, { key: await bank.registerKey(keyRoute[1], b.type, b.key || undefined) });
        if (p === "/api/pix/prepare") {
          return json(res, 200, b.qr ? await bank.prepareByKey(b.customerId, "", { qr: String(b.qr).trim() }) : await bank.prepareByKey(b.customerId, String(b.key).trim()));
        }
        if (p === "/api/pix/confirm") return json(res, 200, await bank.confirm(b.paymentId, cents(b.amount), b.description || undefined));
        if (p === "/api/pix/manual") {
          return json(res, 200, await bank.sendManual(b.customerId, {
            ispb: b.ispb, branch: b.branch || undefined, account: b.account, accountType: b.accountType || "CACC", document: b.document, name: b.name || undefined,
          }, cents(b.amount), b.description || undefined));
        }
        const ret = /^\/api\/pix\/([A-Za-z0-9]+)\/return$/.exec(p);
        if (ret) return json(res, 200, await bank.returnPix(ret[1], cents(b.amount)));
        if (p === "/api/lab/offline") {
          bank.setOffline(Boolean(b.on));
          return json(res, 200, { offline: bank.offline });
        }
        if (p === "/api/qr") return json(res, 200, { payload: bank.generateQr(b.customerId, b.key, b.amount ? cents(b.amount) : undefined, b.txId || undefined) });
      }

      if (req.method === "GET" && !p.startsWith("/api/")) {
        const file = path.join(PUBLIC, p === "/" ? "index.html" : p);
        if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return json(res, 404, { error: "nao encontrado" });
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
        return;
      }
      json(res, 404, { error: "rota inexistente" });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    (server as http.Server & { port?: number }).port = (server.address() as AddressInfo).port;
    resolve(server);
  }));
}
