/**
 * Limitacao de trafego do ICOM (Manual das Interfaces de Comunicacao 1.12,
 * secao 2.2.1.5).
 *
 * Balde por PSP no canal primario: 3750 fichas, repostas a 750 por segundo.
 * O debito acontece no processamento, nao na recepcao, e o saldo pode ficar
 * negativo. Com saldo menor ou igual a zero, o POST recebe 429 com
 * Retry-After em segundos.
 *
 * Custo: 1 ficha por operacao em pacs.008 e trck.002, 0,2 por operacao em
 * pacs.002 e 1 por mensagem de qualquer outro tipo.
 */

export interface TrafficOptions {
  size: number;
  refillPerSecond: number;
}

export const PRIMARY_CHANNEL: TrafficOptions = { size: 3750, refillPerSecond: 750 };

interface State {
  tokens: number;
  updatedAt: number;
}

export function messageCost(type: string, operations: number): number {
  if (type === "pacs.008" || type === "trck.002") return operations;
  if (type === "pacs.002") return 0.2 * operations;
  return 1;
}

export class TrafficLimiter {
  private state = new Map<string, State>();

  constructor(private opts: TrafficOptions = PRIMARY_CHANNEL) {}

  private get(ispb: string): State {
    let s = this.state.get(ispb);
    const now = Date.now();
    if (!s) {
      s = { tokens: this.opts.size, updatedAt: now };
      this.state.set(ispb, s);
    }
    const elapsed = (now - s.updatedAt) / 1000;
    s.tokens = Math.min(this.opts.size, s.tokens + elapsed * this.opts.refillPerSecond);
    s.updatedAt = now;
    return s;
  }

  /** Segundos ate o saldo ficar positivo; 0 quando pode enviar. */
  retryAfter(ispb: string): number {
    const s = this.get(ispb);
    if (s.tokens > 0) return 0;
    return Math.max(1, Math.ceil((-s.tokens + 1) / this.opts.refillPerSecond));
  }

  debit(ispb: string, cost: number): number {
    const s = this.get(ispb);
    s.tokens -= cost;
    return s.tokens;
  }

  balance(ispb: string): number {
    return this.get(ispb).tokens;
  }

  reset(): void {
    this.state.clear();
  }
}
