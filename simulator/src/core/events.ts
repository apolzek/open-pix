/**
 * Linha do tempo do simulador.
 *
 * Cada passo relevante (mensagem recebida no ICOM, validacao, liquidacao,
 * consulta ao DICT...) vira um evento. Os eventos vao para o log do console
 * e ficam disponiveis na API de controle (GET /events e /events/stream),
 * que e o que o web app de estudo usa para mostrar o lado Bacen da jornada.
 */

import { EventEmitter } from "node:events";
import { logger } from "./log.js";

export type Actor = "ICOM" | "SPI" | "DICT" | "VIRTUAL" | "CTL";

export interface SimEvent {
  seq: number;
  at: string;
  actor: Actor;
  /** Participante envolvido (ISPB), quando houver. */
  ispb?: string;
  /** EndToEndId ou RtrId da transacao, quando houver. */
  txId?: string;
  /** Frase curta, em portugues, do que aconteceu. */
  message: string;
  /** Dados extras para quem quiser ver o detalhe (XML, status, custo...). */
  data?: Record<string, unknown>;
}

const MAX_EVENTS = 2_000;

export class Timeline extends EventEmitter {
  private events: SimEvent[] = [];
  private seq = 0;
  private logs = new Map<Actor, ReturnType<typeof logger>>();

  record(actor: Actor, message: string, extra: Omit<SimEvent, "seq" | "at" | "actor" | "message"> = {}): SimEvent {
    const event: SimEvent = { seq: ++this.seq, at: new Date().toISOString(), actor, message, ...extra };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();

    let log = this.logs.get(actor);
    if (!log) {
      log = logger(actor);
      this.logs.set(actor, log);
    }
    const fields: Record<string, unknown> = {};
    if (extra.ispb) fields.ispb = extra.ispb;
    if (extra.txId) fields.tx = extra.txId;
    log.info(message, fields);

    this.emit("event", event);
    return event;
  }

  list(opts: { since?: number; txId?: string } = {}): SimEvent[] {
    return this.events.filter(
      (e) => (opts.since === undefined || e.seq > opts.since) && (!opts.txId || e.txId === opts.txId),
    );
  }

  clear(): void {
    this.events = [];
  }
}
