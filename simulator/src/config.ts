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
  /** ISPB do SPI, que e o proprio Bacen (campo To das mensagens). */
  spiIspb: str("SIM_SPI_ISPB", "00038166"),
  /**
   * ISPB do participante virtual do DICT. Nao consta em documento oficial;
   * vem da pratica de homologacao.
   */
  dictIspb: str("SIM_DICT_ISPB", "99999060"),

  /** Porta do gateway ICOM. 16522 e a porta de homologacao real. */
  icomPort: num("SIM_ICOM_PORT", 16522),
  /** Porta do DICT. No Bacen usa a mesma porta em host diferente. */
  dictPort: num("SIM_DICT_PORT", 16523),
  /** Porta da API de controle. Fica fora da RSFN simulada, sem mTLS. */
  ctlPort: num("SIM_CTL_PORT", 18080),

  /** Quando falso, sobe em HTTP puro para facilitar depuracao. */
  tlsEnabled: bool("SIM_TLS", true),
  /**
   * Quando verdadeiro, recusa escritas no DICT com Signature vazio. Fica
   * desligado ate a assinatura XMLDSig ser implementada (core/signature.ts).
   */
  verifySignature: bool("SIM_VERIFY_SIGNATURE", false),
  /** Valida cada mensagem do SPI contra o XSD oficial (precisa de xmllint). */
  validateXsd: bool("SIM_VALIDATE_XSD", true),
  /** Quando falso, aceita qualquer header HTTP no ICOM. */
  enforceHeaderWhitelist: bool("SIM_ENFORCE_HEADERS", true),

  certDir: str("SIM_CERT_DIR", new URL("../certs/", import.meta.url).pathname),

  /** Versao do Catalogo de Mensagens e Servicos do SPI. */
  spiCatalogVersion: str("SIM_SPI_CATALOG", "5.13"),
  /**
   * Versao aceita de cada mensagem no catalogo 5.13. Vai no namespace
   * (https://www.bcb.gov.br/pi/pacs.008/1.16) e no MsgDefIdr (pacs.008.spi.1.16).
   * Mensagem com outra versao e recusada.
   */
  spiMessageVersions: {
    "pacs.008": str("SIM_PACS008_VERSION", "1.16"),
    "pacs.002": str("SIM_PACS002_VERSION", "1.17"),
    "pacs.004": str("SIM_PACS004_VERSION", "1.5"),
  },

  /**
   * Limite ponta a ponta da liquidacao no Manual de Tempos do Pix 7.0: 40s
   * contados do AccptncDtTm do pacs.008 (t0') ate a liquidacao (t4). Com
   * suspeita de fraude (PAGFRD) a contagem comeca no recebimento pelo SPI.
   * Estourado, o SPI rejeita com AB03.
   */
  settlementTimeoutMs: num("SIM_SETTLEMENT_TIMEOUT_MS", 40_000),
  /** Teto de conexoes simultaneas de leitura por ISPB e canal no ICOM; acima disso, 429. */
  maxPollConnections: num("SIM_MAX_POLL_CONNECTIONS", 6),
  /** Teto de mensagens devolvidas por leitura de stream. */
  maxMessagesPerStream: num("SIM_MAX_MSGS_PER_STREAM", 10),
  /** Tempo maximo que uma leitura sem mensagem fica pendurada. O manual so diz "alguns segundos". */
  longPollMs: num("SIM_LONG_POLL_MS", 3_000),
  /** Stream sem leitura por esse tempo e descartado; o lote nao confirmado volta para a fila. */
  streamIdleMs: num("SIM_STREAM_IDLE_MS", 60_000),
  /** Tempo que os participantes virtuais levam para responder. */
  virtualReplyMs: num("SIM_VIRTUAL_REPLY_MS", 200),

  /**
   * Participantes diretos cadastrados na partida, no formato
   * ISPB:Nome:saldoEmReais separados por virgula.
   */
  participants: str("SIM_PARTICIPANTS", "10000001:Banco Alfa:1000000,20000002:Banco Beta:1000000"),

  /** Categoria do participante (A a H), define o balde do antiscan do DICT. */
  participantCategory: str("SIM_PARTICIPANT_CATEGORY", "C"),
  /** Prazo de resolucao de reivindicacao, sete dias no Bacen. */
  claimResolutionDays: num("SIM_CLAIM_RESOLUTION_DAYS", 7),
  /** Periodo de encerramento da reivindicacao de posse, mais sete dias. */
  claimCompletionDays: num("SIM_CLAIM_COMPLETION_DAYS", 7),

  snapshotPath: str("SIM_SNAPSHOT", ""),
  logLevel: str("SIM_LOG_LEVEL", "info"),
} as const;

export type Config = typeof config;
