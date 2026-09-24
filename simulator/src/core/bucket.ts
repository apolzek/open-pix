/**
 * Limitacao de requisicoes do DICT por token bucket.
 *
 * As taxas e tamanhos de balde vem da tabela oficial da API v1 do DICT,
 * secao "Limitacao de requisicoes". As regras de contagem tambem:
 * consulta que devolve 404 desconta mais ficha que consulta que devolve 200,
 * justamente para encarecer varredura de dados.
 */

import { logger } from "./log.js";

const log = logger("bucket");

export interface PolicyDef {
  /** USER quando o balde e por usuario final, PSP quando e por participante. */
  scope: "USER" | "PSP";
  /** Fichas repostas por minuto. */
  refillPerMin: number;
  /** Capacidade do balde. */
  size: number;
}

/** Baldes do antiscan por participante, definidos pela categoria no Bacen. */
export const PARTICIPANT_CATEGORIES: Record<string, { refillPerMin: number; size: number }> = {
  A: { refillPerMin: 12_000, size: 20_000 },
  B: { refillPerMin: 8_000, size: 15_000 },
  C: { refillPerMin: 2_000, size: 8_000 },
  D: { refillPerMin: 500, size: 4_000 },
  E: { refillPerMin: 50, size: 3_000 },
  F: { refillPerMin: 2, size: 1_000 },
};

/** Baldes do antiscan por usuario final, por tipo de pessoa. */
export const USER_BUCKET_SIZES = { NATURAL_PERSON: 100, LEGAL_PERSON: 1_000 } as const;

export const POLICIES: Record<string, PolicyDef> = {
  ENTRIES_READ_USER_ANTISCAN: { scope: "USER", refillPerMin: 2, size: 100 },
  ENTRIES_READ_USER_ANTISCAN_V2: { scope: "USER", refillPerMin: 2, size: 100 },
  ENTRIES_READ_PARTICIPANT_ANTISCAN: { scope: "PSP", refillPerMin: 2_000, size: 8_000 },
  ENTRIES_WRITE: { scope: "PSP", refillPerMin: 1_200, size: 36_000 },
  ENTRIES_UPDATE: { scope: "PSP", refillPerMin: 600, size: 600 },
  CLAIMS_READ: { scope: "PSP", refillPerMin: 600, size: 18_000 },
  CLAIMS_WRITE: { scope: "PSP", refillPerMin: 1_200, size: 36_000 },
  CLAIMS_LIST_WITH_ROLE: { scope: "PSP", refillPerMin: 40, size: 200 },
  CLAIMS_LIST_WITHOUT_ROLE: { scope: "PSP", refillPerMin: 10, size: 50 },
  SYNC_VERIFICATIONS_WRITE: { scope: "PSP", refillPerMin: 10, size: 50 },
  CIDS_FILES_WRITE: { scope: "PSP", refillPerMin: 40 / 1440, size: 200 },
  CIDS_FILES_READ: { scope: "PSP", refillPerMin: 10, size: 50 },
  CIDS_EVENTS_LIST: { scope: "PSP", refillPerMin: 20, size: 100 },
  CIDS_ENTRIES_READ: { scope: "PSP", refillPerMin: 1_200, size: 36_000 },
  INFRACTION_REPORTS_READ: { scope: "PSP", refillPerMin: 600, size: 18_000 },
  INFRACTION_REPORTS_WRITE: { scope: "PSP", refillPerMin: 1_200, size: 36_000 },
  INFRACTION_REPORTS_LIST_WITH_ROLE: { scope: "PSP", refillPerMin: 40, size: 200 },
  INFRACTION_REPORTS_LIST_WITHOUT_ROLE: { scope: "PSP", refillPerMin: 10, size: 50 },
  KEYS_CHECK: { scope: "PSP", refillPerMin: 70, size: 70 },
  REFUNDS_READ: { scope: "PSP", refillPerMin: 1_200, size: 36_000 },
  REFUNDS_WRITE: { scope: "PSP", refillPerMin: 2_400, size: 72_000 },
  REFUND_LIST_WITH_ROLE: { scope: "PSP", refillPerMin: 40, size: 200 },
  REFUND_LIST_WITHOUT_ROLE: { scope: "PSP", refillPerMin: 10, size: 50 },
  STATISTICS_READ: { scope: "PSP", refillPerMin: 500, size: 500 },
  POLICIES_READ: { scope: "PSP", refillPerMin: 60, size: 200 },
  POLICIES_LIST: { scope: "PSP", refillPerMin: 6, size: 20 },
};

interface BucketState {
  tokens: number;
  size: number;
  refillPerMin: number;
  updatedAt: number;
}

export interface BucketSnapshot {
  policy: string;
  owner: string;
  tokens: number;
  size: number;
  refillPerMin: number;
}

export class RateLimiter {
  private buckets = new Map<string, BucketState>();
  /** Quando falso, contabiliza mas nunca recusa. Util para depurar. */
  enabled = true;

  constructor(private category: string = "C") {}

  setCategory(category: string): void {
    if (!PARTICIPANT_CATEGORIES[category]) return;
    this.category = category;
    // Rebaseia o balde de antiscan por participante, os demais nao mudam.
    for (const [key, state] of this.buckets) {
      if (key.startsWith("ENTRIES_READ_PARTICIPANT_ANTISCAN:")) {
        const def = PARTICIPANT_CATEGORIES[category];
        state.size = def.size;
        state.refillPerMin = def.refillPerMin;
        state.tokens = Math.min(state.tokens, def.size);
      }
    }
  }

  private defFor(policy: string, owner: string): PolicyDef {
    const base = POLICIES[policy];
    if (!base) throw new Error(`politica desconhecida: ${policy}`);
    if (policy === "ENTRIES_READ_PARTICIPANT_ANTISCAN") {
      const cat = PARTICIPANT_CATEGORIES[this.category] ?? PARTICIPANT_CATEGORIES.C;
      return { scope: "PSP", ...cat };
    }
    if (base.scope === "USER" && owner.startsWith("PJ:")) {
      return { ...base, size: USER_BUCKET_SIZES.LEGAL_PERSON };
    }
    return base;
  }

  private state(policy: string, owner: string): BucketState {
    const id = `${policy}:${owner}`;
    let state = this.buckets.get(id);
    if (!state) {
      const def = this.defFor(policy, owner);
      state = { tokens: def.size, size: def.size, refillPerMin: def.refillPerMin, updatedAt: Date.now() };
      this.buckets.set(id, state);
    }
    return state;
  }

  private refill(state: BucketState): void {
    const now = Date.now();
    const elapsedMin = (now - state.updatedAt) / 60_000;
    if (elapsedMin <= 0) return;
    state.tokens = Math.min(state.size, state.tokens + elapsedMin * state.refillPerMin);
    state.updatedAt = now;
  }

  /** Verifica se ha ficha disponivel sem consumir. */
  allows(policy: string, owner: string): boolean {
    if (!this.enabled) return true;
    const state = this.state(policy, owner);
    this.refill(state);
    return state.tokens >= 1;
  }

  /**
   * Desconta fichas depois que a resposta foi decidida.
   * O custo depende do status, que e exatamente como o Bacen encarece 404.
   */
  charge(policy: string, owner: string, cost: number): void {
    if (!this.enabled || cost === 0) return;
    const state = this.state(policy, owner);
    this.refill(state);
    state.tokens = Math.max(0, Math.min(state.size, state.tokens - cost));
    if (state.tokens === 0) {
      log.warn("balde zerado", { policy, owner });
    }
  }

  /** Devolve ficha, usado quando a ordem de pagamento e efetivamente enviada. */
  credit(policy: string, owner: string, amount = 1): void {
    if (!this.enabled) return;
    const state = this.state(policy, owner);
    this.refill(state);
    state.tokens = Math.min(state.size, state.tokens + amount);
  }

  list(owner?: string): BucketSnapshot[] {
    const out: BucketSnapshot[] = [];
    for (const [id, state] of this.buckets) {
      const sep = id.indexOf(":");
      const policy = id.slice(0, sep);
      const bucketOwner = id.slice(sep + 1);
      if (owner && bucketOwner !== owner) continue;
      this.refill(state);
      out.push({
        policy,
        owner: bucketOwner,
        tokens: Math.floor(state.tokens),
        size: state.size,
        refillPerMin: state.refillPerMin,
      });
    }
    return out;
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Custo em fichas de uma consulta de vinculo, conforme as regras de contagem.
 * O 404 caro e o que trava varredura de chave.
 */
export function antiscanCost(status: number, scope: "USER" | "PSP"): number {
  if (status === 200) return 1;
  if (status === 404) return scope === "USER" ? 20 : 3;
  return 1;
}
