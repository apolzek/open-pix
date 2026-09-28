/**
 * API de controle do simulador (JSON, sem mTLS). Nao existe no Bacen real:
 * serve para observar e manipular o ambiente durante estudos e testes.
 *
 *   GET  /health
 *   GET  /participants                     participantes e saldo da conta PI
 *   POST /participants                     {ispb, name, balance}
 *   POST /participants/{ispb}/block        bloqueia envio de Pix (RJCT DS02)
 *   POST /participants/{ispb}/unblock
 *   GET  /transactions[?id=]               liquidacoes do SPI
 *   GET  /dict/entries                     chaves registradas
 *   GET  /events[?since=&txId=]            linha do tempo
 *   GET  /events/stream                    linha do tempo ao vivo (SSE)
 *   POST /virtual/pix                      {to, amount, key?, creditor?}: 99999A03 envia um Pix
 *   POST /reset
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Timeline, SimEvent } from "../core/events.js";
import type { Participants } from "../spi/participants.js";
import { fromCents } from "../spi/participants.js";
import type { SpiEngine } from "../spi/engine.js";
import type { DictStore } from "../dict/server.js";
import type { VirtualParticipants } from "../spi/virtual.js";
import type { Outbox } from "../icom/outbox.js";

export interface ControlContext {
  participants: Participants;
  engine: SpiEngine;
  dict: DictStore;
  virtual: VirtualParticipants;
  outbox: Outbox;
  timeline: Timeline;
  reset: () => void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function controlHandler(ctx: ControlContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://ctl");
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      if (p === "/health") return json(res, 200, { ok: true });

      if (p === "/participants" && req.method === "GET") {
        return json(res, 200, ctx.participants.list().map((x) => ({
          ...x,
          balance: fromCents(x.balanceCents),
          queuedMessages: ctx.outbox.pendingCount(x.ispb),
          openStreams: ctx.outbox.openStreams(x.ispb),
        })));
      }
      if (p === "/participants" && req.method === "POST") {
        const b = await readJson(req);
        const added = ctx.participants.add({ ispb: b.ispb, name: b.name, balanceCents: Math.round(Number(b.balance ?? 0) * 100) });
        ctx.timeline.record("CTL", `Participante ${added.ispb} ${added.name} cadastrado`, { ispb: added.ispb });
        return json(res, 201, added);
      }
      const block = /^\/participants\/([0-9A-Z]{8})\/(block|unblock)$/.exec(p);
      if (block && req.method === "POST") {
        const part = ctx.participants.get(block[1]);
        if (!part) return json(res, 404, { error: "participante inexistente" });
        part.sendBlocked = block[2] === "block";
        ctx.timeline.record("CTL", `Envio de Pix de ${part.ispb} ${part.sendBlocked ? "bloqueado" : "desbloqueado"}`, { ispb: part.ispb });
        return json(res, 200, part);
      }

      if (p === "/transactions") {
        const id = url.searchParams.get("id");
        const list = [...ctx.engine.settlements.values()].map((s) => ({ ...s, amount: fromCents(s.amountCents) }));
        return json(res, 200, id ? list.filter((s) => s.id === id || s.endToEndId === id) : list.reverse());
      }

      if (p === "/dict/entries") return json(res, 200, [...ctx.dict.entries.values()]);

      if (p === "/events" && req.method === "GET") {
        const since = url.searchParams.get("since");
        return json(res, 200, ctx.timeline.list({
          since: since ? Number(since) : undefined,
          txId: url.searchParams.get("txId") ?? undefined,
        }));
      }
      if (p === "/events/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        const push = (e: SimEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        for (const e of ctx.timeline.list().slice(-50)) push(e);
        ctx.timeline.on("event", push);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(ping);
          ctx.timeline.off("event", push);
        });
        return;
      }

      if (p === "/virtual/pix" && req.method === "POST") {
        const b = await readJson(req);
        const e2e = ctx.virtual.sendPix({ to: b.to, amount: Number(b.amount), key: b.key, creditor: b.creditor, description: b.description });
        return json(res, 202, { endToEndId: e2e });
      }

      if (p === "/reset" && req.method === "POST") {
        ctx.reset();
        return json(res, 200, { ok: true });
      }

      json(res, 404, { error: "rota inexistente" });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  };
}
