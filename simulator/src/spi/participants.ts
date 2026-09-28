/**
 * Participantes do SPI e suas contas PI (Pagamentos Instantaneos) no Bacen.
 *
 * Todo participante direto tem uma conta PI. A liquidacao de um Pix debita a
 * conta PI do PSP do pagador e credita a do PSP do recebedor, em tempo real.
 * Valores em centavos, inteiros, para nao sofrer com ponto flutuante.
 */

export interface Participant {
  ispb: string;
  name: string;
  /** Participantes virtuais do Bacen respondem sozinhos, sem ICOM. */
  virtual: boolean;
  /** Saldo da conta PI, em centavos. */
  balanceCents: number;
  /** Bloqueio de envio de Pix (SPB-Web2 / SPI-Web). Envios viram RJCT DS02. */
  sendBlocked: boolean;
  active: boolean;
}

export const ISPB_PATTERN = /^[0-9A-Z]{8}$/;

export class Participants {
  private byIspb = new Map<string, Participant>();

  add(p: Partial<Participant> & { ispb: string }): Participant {
    if (!ISPB_PATTERN.test(p.ispb)) throw new Error(`ISPB invalido: ${p.ispb}`);
    const existing = this.byIspb.get(p.ispb);
    const participant: Participant = {
      name: p.ispb,
      virtual: false,
      balanceCents: 0,
      sendBlocked: false,
      active: true,
      ...existing,
      ...p,
    };
    this.byIspb.set(p.ispb, participant);
    return participant;
  }

  get(ispb: string): Participant | undefined {
    return this.byIspb.get(ispb);
  }

  list(): Participant[] {
    return [...this.byIspb.values()];
  }

  /** Move saldo entre contas PI. Retorna falso quando falta saldo. */
  transfer(fromIspb: string, toIspb: string, cents: number): boolean {
    const from = this.byIspb.get(fromIspb);
    const to = this.byIspb.get(toIspb);
    if (!from || !to) return false;
    if (from.balanceCents < cents) return false;
    from.balanceCents -= cents;
    to.balanceCents += cents;
    return true;
  }
}

export function toCents(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** Valor em reais para mensagens de log: R$ 1.234,56. */
export function brl(cents: number): string {
  return BRL.format(cents / 100);
}
