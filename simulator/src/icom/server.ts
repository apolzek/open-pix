/**
 * API do ICOM simulada (Manual das Interfaces de Comunicacao 1.12).
 *
 *   POST   /api/v1/in/{ispb}/msgs          envia 1 mensagem ou ate 10 (multipart)
 *   GET    /api/v1/out/{ispb}/stream/start abre um stream de leitura
 *   GET    /api/v1/out/{ispb}/stream/{id}  proxima leitura (PI-Pull-Next)
 *   DELETE /api/v1/out/{ispb}/stream/{id}  encerra e confirma as leituras
 *   GET    /api/v1/in/catalog              versoes aceitas na entrada
 *   GET    /api/v1/out/catalog             versoes entregues na saida
 *
 * O POST so grava: responde 201 com PI-ResourceId e a validacao acontece
 * depois, no SPI, que devolve admi.002 pelo stream quando algo esta errado.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import zlib from "node:zlib";

import { buildMultipart, parseMultipart } from "../../../scripts/utils/http-client.js";
import { spiMsgDefIdr, type SpiMessageType } from "../../../scripts/spi/spi-envelope.js";
import { escapeXml } from "../core/problem.js";
import type { Timeline } from "../core/events.js";
import type { Participants } from "../spi/participants.js";
import { Outbox, newResourceId } from "./outbox.js";
import type { TrafficLimiter } from "./traffic.js";

export const ICOM_ERROR_BASE = "https://icom.pi.rsfn.net.br/api/v1/error";

const ALLOWED_HEADERS = new Set([
  "accept", "accept-encoding", "connection", "content-encoding", "content-length", "content-type",
  "cookie", "host", "max-forwards", "transfer-encoding", "user-agent", "via",
]);

const IN_CATALOG: SpiMessageType[] = ["pacs.002", "pacs.004", "pacs.008"];
const OUT_CATALOG: SpiMessageType[] = ["admi.002", "pacs.002", "pacs.004", "pacs.008"];
const MAX_MESSAGES_PER_POST = 10;

export interface IcomContext {
  participants: Participants;
  outbox: Outbox;
  traffic: TrafficLimiter;
  timeline: Timeline;
  /** Entrega a mensagem gravada ao SPI (assincrono). */
  submit: (ispb: string, xml: string, resourceId: string) => void;
  enforceHeaders: boolean;
  tls: boolean;
}

function problem(res: ServerResponse, status: number, type: string, title: string, headers: Record<string, string> = {}): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<problem xmlns="urn:ietf:rfc:7807">
    <type>${ICOM_ERROR_BASE}/${type}</type>
    <title>${escapeXml(title)}</title>
    <status>${status}</status>
</problem>`;
  res.writeHead(status, { "Content-Type": "application/problem+xml; charset=utf-8", ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function typeOf(xml: string): string {
  return /xmlns="https:\/\/www\.bcb\.gov\.br\/pi\/([a-z]+\.\d{3})\//.exec(xml)?.[1] ?? "desconhecido";
}

function send(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string>, body?: string): void {
  if (body && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip" });
    res.end(zlib.gzipSync(body));
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

export function icomHandler(ctx: IcomContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handle(ctx, req, res);
    } catch (err) {
      ctx.timeline.record("ICOM", `Erro interno: ${(err as Error).message}`);
      if (!res.headersSent) problem(res, 500, "internal", "Erro interno");
    }
  };
}

async function handle(ctx: IcomContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://icom");
  const path = url.pathname;

  if (ctx.enforceHeaders) {
    const extra = Object.keys(req.headers).filter((h) => !ALLOWED_HEADERS.has(h));
    if (extra.length) {
      ctx.timeline.record("ICOM", `Requisicao recusada: cabecalhos nao permitidos ${extra.join(", ")}`);
      problem(res, 400, "header", `Cabecalho nao permitido: ${extra.join(", ")}`);
      return;
    }
    if (String(req.headers.host ?? "").includes(":")) {
      problem(res, 400, "host", "Cabecalho Host deve ser enviado sem a porta");
      return;
    }
  }

  if (req.method === "GET" && (path === "/api/v1/in/catalog" || path === "/api/v1/out/catalog")) {
    const list = path.includes("/in/") ? IN_CATALOG : OUT_CATALOG;
    const body = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<Catalog>
${list.map((t) => `    <Message>${spiMsgDefIdr(t)}</Message>`).join("\n")}
</Catalog>
`;
    send(req, res, 200, { "Content-Type": "application/xml; charset=utf-8" }, body);
    return;
  }

  const match = /^\/api\/v1\/(in|out)\/([0-9A-Z]{8})\/(msgs|stream\/([A-Za-z0-9]+))$/.exec(path);
  if (!match) {
    problem(res, 404, "not-found", "Recurso inexistente");
    return;
  }
  const [, direction, ispb, resource, token] = match;

  const participant = ctx.participants.get(ispb);
  if (!participant || participant.virtual) {
    problem(res, 403, "forbidden", `Participante ${ispb} nao habilitado`);
    return;
  }
  if (ctx.tls) {
    const cn = (req.socket as TLSSocket).getPeerCertificate?.()?.subject?.CN;
    if (typeof cn === "string" && /^[0-9A-Z]{8}$/.test(cn) && cn !== ispb) {
      problem(res, 403, "forbidden", `Certificado de ${cn} nao pode operar pelo ISPB ${ispb}`);
      return;
    }
  }

  if (direction === "in" && resource === "msgs" && req.method === "POST") {
    await post(ctx, ispb, req, res);
    return;
  }

  if (direction === "out" && token) {
    const multipart = String(req.headers.accept ?? "").includes("multipart/mixed");
    if (req.method === "DELETE") {
      const ok = ctx.outbox.close(ispb, token);
      res.writeHead(ok ? 200 : 410).end();
      return;
    }
    if (req.method === "GET") {
      const outcome = token === "start" ? await ctx.outbox.start(ispb, multipart) : await ctx.outbox.read(ispb, token, multipart);
      if (outcome.kind === "too-many-streams") {
        problem(res, 429, "too-many-streams", "Limite de 6 streams de leitura simultaneos atingido");
        return;
      }
      if (outcome.kind === "unknown-stream") {
        problem(res, 404, "stream", "Stream inexistente ou expirado; use o PI-Pull-Next mais recente");
        return;
      }
      if (outcome.kind === "empty") {
        res.writeHead(204, { "PI-Pull-Next": outcome.pullNext }).end();
        return;
      }
      for (const m of outcome.messages) {
        ctx.timeline.record("ICOM", `${ispb} leu ${m.type} do stream`, { ispb, data: { resourceId: m.resourceId } });
      }
      if (multipart) {
        const { contentType, body } = buildMultipart(outcome.messages.map((m) => m.xml));
        let i = 0;
        const withIds = body.replace(/Content-Type: application\/xml; charset=utf-8\r\n/g, (h) => `${h}PI-ResourceId: ${outcome.messages[i++].resourceId}\r\n`);
        send(req, res, 200, { "Content-Type": contentType, "PI-Pull-Next": outcome.pullNext }, withIds);
      } else {
        const [m] = outcome.messages;
        send(req, res, 200, {
          "Content-Type": "application/xml; charset=utf-8",
          "PI-Pull-Next": outcome.pullNext,
          "PI-ResourceId": m.resourceId,
        }, m.xml);
      }
      return;
    }
  }

  problem(res, 405, "method", "Metodo nao suportado neste recurso");
}

async function post(ctx: IcomContext, ispb: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const retry = ctx.traffic.retryAfter(ispb);
  if (retry > 0) {
    ctx.timeline.record("ICOM", `${ispb} sem fichas no balde de trafego: 429`, { ispb });
    problem(res, 429, "rate-limit", "Limite de trafego atingido", { "Retry-After": String(retry) });
    return;
  }

  if (req.headers["content-length"] === undefined && !/chunked/i.test(String(req.headers["transfer-encoding"] ?? ""))) {
    problem(res, 411, "length", "Envie Content-Length ou Transfer-Encoding: chunked");
    return;
  }

  const contentType = String(req.headers["content-type"] ?? "");
  const multipart = contentType.startsWith("multipart/mixed");
  if (!multipart && !contentType.startsWith("application/xml")) {
    problem(res, 415, "content-type", "Content-Type deve ser application/xml; charset=utf-8 ou multipart/mixed");
    return;
  }
  if (!multipart && !/charset=utf-8/i.test(contentType)) {
    problem(res, 400, "charset", "Charset XML invalido.");
    return;
  }

  let body = await readBody(req);
  const encoding = req.headers["content-encoding"];
  if (encoding === "gzip") {
    try {
      body = zlib.gunzipSync(body);
    } catch {
      problem(res, 400, "gzip", "Conteudo gzip invalido");
      return;
    }
  } else if (encoding !== undefined) {
    problem(res, 415, "content-encoding", "Somente gzip e aceito em Content-Encoding");
    return;
  }

  let messages: string[];
  try {
    messages = multipart ? parseMultipart(body.toString("utf8"), contentType).map((m) => m.xml) : [body.toString("utf8")];
  } catch {
    problem(res, 400, "multipart", "Multipart invalido");
    return;
  }
  if (messages.length === 0 || messages.length > MAX_MESSAGES_PER_POST) {
    problem(res, 400, "multipart", `Envie de 1 a ${MAX_MESSAGES_PER_POST} mensagens por requisicao`);
    return;
  }

  const ids = messages.map(() => newResourceId());
  res.writeHead(201, { "PI-ResourceId": ids.join(",") }).end();

  messages.forEach((xml, i) => {
    ctx.timeline.record("ICOM", `${ispb} gravou ${typeOf(xml)} no ICOM (201, PI-ResourceId ${ids[i]})`, {
      ispb,
      data: { resourceId: ids[i], gzip: encoding === "gzip" },
    });
    setImmediate(() => ctx.submit(ispb, xml, ids[i]));
  });
}
