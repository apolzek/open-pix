/**
 * Respostas de erro do DICT no formato RFC 7807, serializadas em XML.
 *
 * O type segue o padrao oficial:
 *   https://dict.pi.rsfn.net.br/api/v2/error/<TipoErro>
 */

export const DICT_ERROR_BASE = "https://dict.pi.rsfn.net.br/api/v2/error";

/**
 * Tipos de erro do DICT, conforme a secao "Tratamento de erros" da API v2.
 * Quase todo erro de regra de negocio e 400; 404 so em NotFound e ClaimKeyNotFound.
 */
export const DictError = {
  Forbidden: { status: 403, title: "Requisicao nao autorizada" },
  BadRequest: { status: 400, title: "Requisicao com formato invalido" },
  NotFound: { status: 404, title: "Entidade nao encontrada" },
  ResourceConflict: { status: 409, title: "Conflito com o estado atual do recurso" },
  Gone: { status: 410, title: "Recurso nao esta mais disponivel" },
  DeprecatedResource: { status: 410, title: "Recurso descontinuado" },
  RateLimited: { status: 429, title: "Limite de requisicoes atingido" },
  InternalServerError: { status: 500, title: "Condicao inesperada ao processar requisicao" },
  ServiceUnavailable: { status: 503, title: "Servico indisponivel no momento" },
  RequestSignatureInvalid: { status: 400, title: "Assinatura digital da requisicao e invalida" },
  RequestIdAlreadyUsed: { status: 400, title: "RequestId ja usado com parametros diferentes" },
  InvalidReason: { status: 400, title: "Razao invalida para a operacao" },
  ParticipantInvalid: { status: 400, title: "Participante nao pode participar da operacao" },
  TaxIdNumberBlocked: { status: 400, title: "CPF/CNPJ bloqueado por ordem judicial" },

  EntryInvalid: { status: 400, title: "Campos invalidos na criacao do vinculo" },
  EntryLimitExceeded: { status: 400, title: "Limite de vinculos da conta excedido" },
  EntryAlreadyExists: { status: 400, title: "Ja existe vinculo para essa chave com o mesmo participante e dono" },
  EntryCannotBeQueriedForBookTransfer: { status: 400, title: "Consulta indevida, pagador e recebedor no mesmo PSP" },
  EntryKeyOwnedByDifferentPerson: { status: 400, title: "Chave pertence a outra pessoa" },
  EntryKeyInCustodyOfDifferentParticipant: { status: 400, title: "Chave do mesmo dono custodiada em outro participante" },
  EntryLockedByClaim: { status: 400, title: "Vinculo bloqueado por reivindicacao em aberto" },

  ClaimInvalid: { status: 400, title: "Campos invalidos na reivindicacao" },
  ClaimTypeInconsistent: { status: 400, title: "Tipo de reivindicacao incompativel com o vinculo" },
  ClaimKeyNotFound: { status: 404, title: "Nao existe vinculo com a chave reivindicada" },
  ClaimAlreadyExistsForKey: { status: 400, title: "Ja existe reivindicacao aberta para essa chave" },
  ClaimResultingEntryAlreadyExists: { status: 400, title: "Vinculo resultante da reivindicacao ja existe" },
  ClaimOperationInvalid: { status: 400, title: "Status da reivindicacao nao permite a operacao" },
  ClaimResolutionPeriodNotEnded: { status: 400, title: "Periodo de resolucao ainda nao terminou" },
  ClaimCompletionPeriodNotEnded: { status: 400, title: "Periodo de encerramento ainda nao terminou" },

  InfractionReportInvalid: { status: 400, title: "Campos invalidos na notificacao de infracao" },
  InfractionReportOperationInvalid: { status: 400, title: "Status da notificacao de infracao nao permite a operacao" },

  RefundInvalid: { status: 400, title: "Campos invalidos na solicitacao de devolucao" },
  RefundOperationInvalid: { status: 400, title: "Status da solicitacao de devolucao nao permite a operacao" },
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
