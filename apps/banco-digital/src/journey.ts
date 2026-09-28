/**
 * Diario de bordo do banco: cada operacao (um Pix enviado, recebido,
 * devolvido, uma chave cadastrada) e uma jornada com passos numerados.
 *
 * Cada passo sai no console, colorido e com uma explicacao curta do porque,
 * e vai para a pagina web por Server-Sent Events.
 */

import { EventEmitter } from "node:events";

export type StepKind = "info" | "ok" | "warn" | "error" | "send" | "receive";

export interface Step {
  journeyId: string;
  n: number;
  at: string;
  kind: StepKind;
  text: string;
  /** Explicacao didatica: por que esse passo existe. */
  why?: string;
  /** Detalhe tecnico opcional (XML, cabecalhos...). */
  detail?: string;
}

export interface JourneyInfo {
  id: string;
  title: string;
  startedAt: string;
}

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

const ICON: Record<StepKind, string> = {
  info: "•",
  ok: "✔",
  warn: "!",
  error: "✖",
  send: "→",
  receive: "←",
};

const KIND_COLOR: Record<StepKind, string> = {
  info: COLORS.reset,
  ok: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
  send: COLORS.cyan,
  receive: COLORS.magenta,
};

export class JourneyLog extends EventEmitter {
  private counters = new Map<string, number>();
  private history: (Step | (JourneyInfo & { type: "start" }))[] = [];
  private seq = 0;

  constructor(
    private bankLabel: string,
    private color: string,
    private useColor = process.stdout.isTTY ?? false,
  ) {
    super();
    this.setMaxListeners(0);
  }

  private c(code: keyof typeof COLORS | string, text: string): string {
    if (!this.useColor) return text;
    const esc = code in COLORS ? COLORS[code as keyof typeof COLORS] : code;
    return `${esc}${text}${COLORS.reset}`;
  }

  private prefix(): string {
    return this.c(this.color, this.c("bold", `[${this.bankLabel}]`));
  }

  start(title: string): string {
    const id = `J${++this.seq}`;
    const info = { id, title, startedAt: new Date().toISOString() };
    this.counters.set(id, 0);
    console.log(`\n${this.prefix()} ${this.c("bold", `▶ ${title}`)} ${this.c("dim", `(${id})`)}`);
    this.push({ type: "start", ...info });
    this.emit("start", info);
    return id;
  }

  step(journeyId: string, kind: StepKind, text: string, why?: string, detail?: string): Step {
    const n = (this.counters.get(journeyId) ?? 0) + 1;
    this.counters.set(journeyId, n);
    const step: Step = { journeyId, n, at: new Date().toISOString(), kind, text, why, detail };
    const num = String(n).padStart(2, " ");
    console.log(`${this.prefix()}   ${num}. ${this.c(KIND_COLOR[kind], `${ICON[kind]} ${text}`)}`);
    if (why) console.log(`${this.prefix()}       ${this.c("dim", `↳ ${why}`)}`);
    this.push(step);
    this.emit("step", step);
    return step;
  }

  private push(item: Step | (JourneyInfo & { type: "start" })): void {
    this.history.push(item);
    if (this.history.length > 1_000) this.history.shift();
  }

  recent(): (Step | (JourneyInfo & { type: "start" }))[] {
    return this.history.slice(-300);
  }
}
