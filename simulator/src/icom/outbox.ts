/**
 * Caixa de saida do ICOM: mensagens que o SPI entrega a cada participante.
 *
 * Regras do Manual das Interfaces de Comunicacao 1.12, secao 2.2.2:
 * - O PSP abre um stream com GET .../stream/start e segue sempre o caminho
 *   devolvido em PI-Pull-Next.
 * - Uma leitura entrega ate 10 mensagens (multipart) ou 1 (application/xml).
 *   Sem mensagem, a API espera alguns segundos (long polling) e devolve 204.
 * - As mensagens entregues so ficam confirmadas quando o PSP pede o proximo
 *   PI-Pull-Next ou encerra o stream com DELETE. Sem isso, voltam para a fila
 *   e sao entregues de novo com o mesmo PI-ResourceId (duplicidade).
 * - Ate 6 streams simultaneos por participante; acima disso, 429.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export interface OutMessage {
  resourceId: string;
  xml: string;
  /** Tipo da mensagem, so para log (pacs.008, pacs.002...). */
  type: string;
}

interface Stream {
  id: string;
  ispb: string;
  /** Token do PI-Pull-Next valido para a proxima leitura. */
  token: string;
  /** Token anterior: repetir a mesma leitura reentrega o mesmo lote. */
  previousToken?: string;
  /** Entregues e ainda nao confirmadas. */
  pending: OutMessage[];
  lastSeen: number;
  reading: boolean;
}

export type ReadOutcome =
  | { kind: "messages"; messages: OutMessage[]; pullNext: string }
  | { kind: "empty"; pullNext: string }
  | { kind: "unknown-stream" }
  | { kind: "too-many-streams" };

/** ResourceId: ate 32 caracteres em Base64 (24 bytes). */
export function newResourceId(): string {
  return crypto.randomBytes(24).toString("base64");
}

export class Outbox extends EventEmitter {
  private queues = new Map<string, OutMessage[]>();
  private streams = new Map<string, Stream>();
  private byToken = new Map<string, Stream>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private opts: { maxStreams: number; maxPerRead: number; longPollMs: number; streamIdleMs: number },
  ) {
    super();
    this.setMaxListeners(0);
    this.sweeper = setInterval(() => this.expireIdle(), Math.min(opts.streamIdleMs, 5_000));
    this.sweeper.unref();
  }

  private queue(ispb: string): OutMessage[] {
    let q = this.queues.get(ispb);
    if (!q) {
      q = [];
      this.queues.set(ispb, q);
    }
    return q;
  }

  enqueue(ispb: string, xml: string, type: string): OutMessage {
    const msg = { resourceId: newResourceId(), xml, type };
    this.queue(ispb).push(msg);
    this.emit(`msg:${ispb}`);
    return msg;
  }

  pendingCount(ispb: string): number {
    return this.queue(ispb).length;
  }

  openStreams(ispb: string): number {
    return [...this.streams.values()].filter((s) => s.ispb === ispb).length;
  }

  private pullPath(ispb: string, token: string): string {
    return `/api/v1/out/${ispb}/stream/${token}`;
  }

  private rotate(stream: Stream): string {
    this.byToken.delete(stream.previousToken ?? "");
    stream.previousToken = stream.token;
    stream.token = crypto.randomBytes(6).toString("hex");
    this.byToken.set(stream.token, stream);
    return this.pullPath(stream.ispb, stream.token);
  }

  /** GET .../stream/start */
  async start(ispb: string, multipart: boolean): Promise<ReadOutcome> {
    if (this.openStreams(ispb) >= this.opts.maxStreams) return { kind: "too-many-streams" };
    const token = crypto.randomBytes(6).toString("hex");
    const stream: Stream = { id: token, ispb, token, pending: [], lastSeen: Date.now(), reading: false };
    this.streams.set(stream.id, stream);
    this.byToken.set(token, stream);
    return this.read(ispb, token, multipart);
  }

  /** GET .../stream/{token} */
  async read(ispb: string, token: string, multipart: boolean): Promise<ReadOutcome> {
    const stream = this.byToken.get(token);
    if (!stream || stream.ispb !== ispb) return { kind: "unknown-stream" };
    stream.lastSeen = Date.now();

    if (token === stream.previousToken) {
      // O PSP repetiu a leitura anterior (perdeu a resposta?): reentrega o lote.
      if (stream.pending.length) {
        return { kind: "messages", messages: stream.pending, pullNext: this.pullPath(ispb, stream.token) };
      }
      return { kind: "empty", pullNext: this.pullPath(ispb, stream.token) };
    }

    // Seguir o PI-Pull-Next confirma o lote anterior.
    stream.pending = [];

    const q = this.queue(ispb);
    if (q.length === 0) await this.waitFor(ispb, stream);

    const batch = q.splice(0, multipart ? this.opts.maxPerRead : 1);
    stream.pending = batch;
    stream.lastSeen = Date.now();
    const pullNext = this.rotate(stream);
    return batch.length ? { kind: "messages", messages: batch, pullNext } : { kind: "empty", pullNext };
  }

  /** DELETE .../stream/{token}: confirma o ultimo lote e libera o stream. */
  close(ispb: string, token: string): boolean {
    const stream = this.byToken.get(token);
    if (!stream || stream.ispb !== ispb) return false;
    if (token === stream.token) stream.pending = [];
    this.drop(stream);
    return true;
  }

  private drop(stream: Stream): void {
    // Lote nao confirmado volta para a frente da fila, com o mesmo ResourceId.
    if (stream.pending.length) {
      this.queue(stream.ispb).unshift(...stream.pending);
      this.emit(`msg:${stream.ispb}`);
    }
    this.streams.delete(stream.id);
    this.byToken.delete(stream.token);
    if (stream.previousToken) this.byToken.delete(stream.previousToken);
  }

  private waitFor(ispb: string, stream: Stream): Promise<void> {
    stream.reading = true;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off(`msg:${ispb}`, done);
        stream.reading = false;
        resolve();
      };
      const timer = setTimeout(done, this.opts.longPollMs);
      this.on(`msg:${ispb}`, done);
    });
  }

  private expireIdle(): void {
    const limit = Date.now() - this.opts.streamIdleMs;
    for (const stream of [...this.streams.values()]) {
      if (!stream.reading && stream.lastSeen < limit) this.drop(stream);
    }
  }

  reset(): void {
    this.queues.clear();
    this.streams.clear();
    this.byToken.clear();
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}
