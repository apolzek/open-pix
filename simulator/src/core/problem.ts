/**
 * Respostas de erro do DICT no formato RFC 7807, serializadas em XML.
 *
 * O type segue o padrao oficial:
 *   https://dict.pi.rsfn.net.br/api/v1/error/<TipoErro>
 */

export const DICT_ERROR_BASE = "https://dict.pi.rsfn.net.br/api/v1/error";

/** Tipos de erro do DICT, conforme a secao "Tratamento de erros" da API v1. */
export const DictError = {
  Forbidden: { status: 403, title: "Requisicao nao autorizada" },
  BadRequest: { status: 400, title: "Requisicao com formato invalido" },
  NotFound: { status: 404, title: "Entidade nao encontrada" },
  RateLimited: { status: 429, title: "Limite de requisicoes atingido" },
  InternalServerError: { status: 500, title: "Condicao inesperada ao processar requisicao" },
  ServiceUnavailable: { status: 503, title: "Servico indisponivel no momento" },
  RequestSignatureInvalid: { status: 403, title: "Assinatura digital da requisicao e invalida" },
  RequestIdAlreadyUsed: { status: 400, title: "RequestId ja usado com parametros diferentes" },
  InvalidReason: { status: 400, title: "Razao invalida para a operacao" },

  EntryInvalid: { status: 400, title: "Campos invalidos na criacao do vinculo" },
  EntryLimitExceeded: { status: 403, title: "Limite de vinculos da conta excedido" },
  EntryAlreadyExists: { status: 409, title: "Ja existe vinculo para essa chave" },
  EntryKeyOwnedByDifferentPerson: { status: 409, title: "Chave pertence a outra pessoa" },
  EntryCannotBeQueriedForBookTransfer: { status: 403, title: "Consulta indevida, pagador e recebedor no mesmo PSP" },
  EntryLockedByClaim: { status: 403, title: "Vinculo bloqueado por reivindicacao em aberto" },

  ClaimNotFound: { status: 404, title: "Reivindicacao nao encontrada" },
  ClaimAlreadyExists: { status: 409, title: "Ja existe reivindicacao aberta para essa chave" },
  ClaimInvalidState: { status: 409, title: "Operacao incompativel com o estado da reivindicacao" },
  ClaimOperationNotAllowed: { status: 403, title: "Participante nao pode executar essa operacao" },

  InfractionReportNotFound: { status: 404, title: "Relato de infracao nao encontrado" },
  InfractionReportInvalidState: { status: 409, title: "Operacao incompativel com o estado do relato" },

  RefundNotFound: { status: 404, title: "Pedido de devolucao nao encontrado" },
  RefundInvalidState: { status: 409, title: "Operacao incompativel com o estado da devolucao" },
} as const;

export type DictErrorType = keyof typeof DictError;

export class DictProblem extends Error {
  constructor(
    readonly type: DictErrorType,
    readonly detail?: string,
  ) {
    super(`${type}: ${detail ?? DictError[type].title}`);
    this.name = "DictProblem";
  }

  get status(): number {
    return DictError[this.type].status;
  }

  toXml(): string {
    const { title } = DictError[this.type];
    const detail = this.detail ? `\n    <detail>${escapeXml(this.detail)}</detail>` : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<problem xmlns="urn:ietf:rfc:7807">
    <type>${DICT_ERROR_BASE}/${this.type}</type>
    <title>${escapeXml(title)}</title>
    <status>${this.status}</status>${detail}
</problem>`;
  }
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
