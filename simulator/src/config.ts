/**
 * Configuracao central do simulador.
 *
 * Todos os valores tem default que reproduz o ambiente de homologacao do Bacen.
 * Sobrescreva via variavel de ambiente para exercitar cenarios diferentes.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function str(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  /** ISPB do participante virtual que representa o SPI. */
  spiIspb: str("SIM_SPI_ISPB", "99999004"),
  /** ISPB do participante virtual que representa o DICT. */
  dictIspb: str("SIM_DICT_ISPB", "99999060"),

  /** Porta do gateway ICOM. 16522 e a porta de homologacao real. */
  icomPort: num("SIM_ICOM_PORT", 16522),
  /** Porta do DICT. No Bacen usa a mesma porta em host diferente. */
  dictPort: num("SIM_DICT_PORT", 16523),
  /** Porta da API de controle. Fica fora da RSFN simulada, sem mTLS. */
  ctlPort: num("SIM_CTL_PORT", 18080),

  /** Quando falso, sobe em HTTP puro para facilitar depuracao. */
  tlsEnabled: bool("SIM_TLS", true),
  /** Quando falso, aceita o elemento Signature vazio nas escritas do DICT. */
  verifySignature: bool("SIM_VERIFY_SIGNATURE", true),
  /** Quando falso, aceita qualquer header HTTP no ICOM. */
  enforceHeaderWhitelist: bool("SIM_ENFORCE_HEADERS", true),

  certDir: str("SIM_CERT_DIR", new URL("../certs/", import.meta.url).pathname),

  /** Versao de catalogo SPI aceita. Mensagem com outra versao e recusada. */
  activeSpiVersion: str("SIM_SPI_VERSION", "1.13"),

  /** Prazo para o PSP credor responder o pacs.008 antes do AB03 automatico. */
  pacs002TimeoutMs: num("SIM_PACS002_TIMEOUT_MS", 10_000),
  /** Teto de conexoes simultaneas de leitura por ISPB no ICOM. */
  maxPollConnections: num("SIM_MAX_POLL_CONNECTIONS", 6),
  /** Teto de mensagens devolvidas por leitura de stream. */
  maxMessagesPerStream: num("SIM_MAX_MSGS_PER_STREAM", 10),
  /** Tempo maximo que uma leitura sem mensagem fica pendurada. */
  longPollMs: num("SIM_LONG_POLL_MS", 3_000),

  /** Categoria do participante, define o balde do antiscan do DICT. */
  participantCategory: str("SIM_PARTICIPANT_CATEGORY", "C"),
  /** Prazo de resolucao de reivindicacao, sete dias no Bacen. */
  claimResolutionDays: num("SIM_CLAIM_RESOLUTION_DAYS", 7),

  snapshotPath: str("SIM_SNAPSHOT", ""),
  logLevel: str("SIM_LOG_LEVEL", "info"),
} as const;

export type Config = typeof config;
