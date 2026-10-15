/**
 * Pix do Banco XPTO para o Banco ABCD, numa pagina so.
 *
 *   npm run xpto-abcd            http://localhost:3003
 *
 * Usa o simulador que ja estiver no ar (SIM_CTL_URL, padrao
 * http://localhost:18080). Os dois bancos entram como participantes pela API
 * de controle (POST /participants) e falam com o ICOM e o DICT por mTLS,
 * como qualquer PSP. Sem simulador no ar, sobe um proprio.
 *
 *   GET  /api/state                     os dois bancos (clientes, saldos, extrato)
 *   GET  /api/stream                    diarios dos bancos + linha do tempo do Bacen (SSE)
 *   POST /api/pix                       {from, key, amount, description?}  XPTO -> ABCD por chave
 *   POST /api/pix/{e2e}/return          {amount}  ABCD devolve (pacs.004)
 *   POST /api/lab/offline               {on}  ABCD para de ler o ICOM (AB03)
 *   GET  /api/bacen/{participants|transactions}  repassa para a API de controle
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSimulator } from "../../../simulator/src/index.js";
import { config as simConfig } from "../../../simulator/src/config.js";
import { generateCerts } from "../../../simulator/tools/gen-certs.js";
import { Bank } from "../../banco-digital/src/bank.js";

const XPTO = { ispb: "40000004", name: "Banco XPTO", label: "XPTO", color: "\x1b[36m" };
const ABCD = { ispb: "50000005", name: "Banco ABCD", label: "ABCD", color: "\x1b[32m" };
const PORT = Number(process.env.PORT || 3003);
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const certDir = simConfig.certDir;

async function ctlAlive(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

// --- Bacen: o simulador que ja esta no ar, ou um proprio -------------------

let ctlUrl = process.env.SIM_CTL_URL || `http://localhost:${simConfig.ctlPort}`;
let icomUrl = process.env.SIM_ICOM_URL || `https://localhost:${simConfig.icomPort}`;
let dictUrl = process.env.SIM_DICT_URL || `https://localhost:${simConfig.dictPort}`;
let embedded: ReturnType<typeof createSimulator> | undefined;

generateCerts(certDir, [XPTO.ispb, ABCD.ispb]);
if (!(await ctlAlive(ctlUrl))) {
  console.log(`Nenhum simulador em ${ctlUrl}: subindo um proprio.`);
  embedded = createSimulator({ certDir, logLevel: "warn", participants: "" });
  await embedded.start();
  ({ ctl: ctlUrl, icom: icomUrl, dict: dictUrl } = embedded.urls);
}

// --- Os dois bancos ---------------------------------------------------------

const common = { icomUrl, dictUrl, certDir };
const xpto = new Bank({ ...common, ...XPTO });
const abcd = new Bank({ ...common, ...ABCD });

const carlos = xpto.addCustomer({ name: "Carlos Pereira", taxId: "69461501048", personType: "NATURAL_PERSON", branch: "1", account: "40001", accountType: "CACC", balance: 2500 });
const julia = xpto.addCustomer({ name: "Julia Ramos", taxId: "84731111927", personType: "NATURAL_PERSON", branch: "1", account: "40002", accountType: "CACC", balance: 700 });
const lucas = abcd.addCustomer({ name: "Lucas Almeida", taxId: "97141091750", personType: "NATURAL_PERSON", branch: "9", account: "50001", accountType: "CACC", balance: 300 });
const loja = abcd.addCustomer({ name: "Loja Bom Preco Ltda", taxId: "29519784000140", personType: "LEGAL_PERSON", branch: "9", account: "50002", accountType: "CACC", balance: 1200 });

/**
 * Cadastra os bancos no SPI e as chaves no DICT. Roda de novo se alguem der
 * POST /reset no simulador, que apaga participantes e chaves.
 */
async function enroll(): Promise<void> {
  for (const b of [XPTO, ABCD]) {
    await fetch(`${ctlUrl}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ispb: b.ispb, name: b.name, balance: 1_000_000 }),
    });
  }
  for (const c of [carlos, julia, lucas, loja]) c.keys = [];
  await xpto.registerKey(carlos.id, "EMAIL", "carlos@xpto.com.br");
  await xpto.registerKey(julia.id, "PHONE", "+5531977776666");
  await abcd.registerKey(lucas.id, "EMAIL", "lucas@abcd.com.br");
  await abcd.registerKey(lucas.id, "CPF");
  await abcd.registerKey(loja.id, "CNPJ");
  await abcd.registerKey(loja.id, "EVP");
}

await enroll();
xpto.start();
abcd.start();

let enrolling = false;
setInterval(async () => {
  if (enrolling) return;
  enrolling = true;
  try {
    const list = (await (await fetch(`${ctlUrl}/participants`)).json()) as { ispb: string }[];
    if (!list.some((p) => p.ispb === XPTO.ispb)) await enroll();
  } catch {
    // simulador fora do ar: tenta de novo no proximo ciclo
  } finally {
    enrolling = false;
  }
}, 3_000).unref();

// --- Web --------------------------------------------------------------------

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const cents = (v: unknown) => Math.round(Number(String(v ?? "").replace(",", ".")) * 100);

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

/** Une os diarios dos bancos e a linha do tempo do Bacen num SSE so. */
function stream(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const off: (() => void)[] = [];

  for (const bank of [xpto, abcd]) {
    const label = bank.opts.label;
    const onStart = (i: object) => send({ source: label, type: "start", ...i });
    const onStep = (s: object) => send({ source: label, type: "step", ...s });
    bank.log.on("start", onStart);
    bank.log.on("step", onStep);
    off.push(() => { bank.log.off("start", onStart); bank.log.off("step", onStep); });
  }

  const bacen = new AbortController();
  off.push(() => bacen.abort());
  (async () => {
    try {
      const r = await fetch(`${ctlUrl}/events/stream`, { signal: bacen.signal });
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (!line) continue;
          const e = JSON.parse(line.slice(6));
          if (e.actor === "ICOM" && / leu /.test(e.message)) continue; // leitura do stream e ruido
          send({ source: "BACEN", type: "event", ...e });
        }
      }
    } catch {
      // conexao fechada
    }
  })();

  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    off.forEach((f) => f());
  });
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url ?? "/", "http://x").pathname;
  try {
    if (p === "/api/state") return json(res, 200, { xpto: xpto.snapshot(), abcd: abcd.snapshot(), ctlUrl });
    if (p === "/api/stream") return stream(req, res);

    const bacen = /^\/api\/bacen\/(participants|transactions)$/.exec(p);
    if (bacen) return json(res, 200, await (await fetch(`${ctlUrl}/${bacen[1]}`)).json());

    if (req.method === "POST") {
      const b = await readJson(req);
      if (p === "/api/pix") {
        // Os dois passos de um Pix por chave: consulta ao DICT e confirmacao.
        const prep = await xpto.prepareByKey(b.from, String(b.key).trim());
        if (prep.bank !== ABCD.ispb) return json(res, 400, { error: `a chave e do ISPB ${prep.bank}, nao do Banco ABCD` });
        return json(res, 200, { recipient: prep, tx: await xpto.confirm(String(prep.paymentId), cents(b.amount), b.description || undefined) });
      }
      const ret = /^\/api\/pix\/([A-Za-z0-9]+)\/return$/.exec(p);
      if (ret) return json(res, 200, await abcd.returnPix(ret[1], cents(b.amount)));
      if (p === "/api/lab/offline") {
        abcd.setOffline(Boolean(b.on));
        return json(res, 200, { offline: abcd.offline });
      }
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nXPTO -> ABCD pronto: http://localhost:${PORT}  (Bacen: ${ctlUrl})\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await Promise.all([xpto.stop(), abcd.stop()]);
    server.close();
    await embedded?.stop();
    process.exit(0);
  });
}
