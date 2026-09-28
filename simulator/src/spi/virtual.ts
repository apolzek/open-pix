/**
 * Participantes virtuais do ambiente de homologacao, conforme o Roteiro para
 * Participacao Direta no SPI (item 7):
 *
 * - 99999A04, Cooperativa de Credito Virtual: responde qualquer pacs.008 (e
 *   pacs.004) com pacs.002 ACSP, sem olhar cliente nem conta.
 * - 99999A03, Banco Virtual: e o pagador nos testes em que o participante
 *   recebe. Envia pacs.008 HIGH com pagador CACC, agencia 1, conta 1,
 *   CPF 11111111111, nome "Fulano".
 *
 * Eles nao usam o ICOM: o SPI entrega e recebe as mensagens deles direto.
 */

import { generatePacs002 } from "../../../scripts/spi/pacs002-generator.js";
import { generatePacs008 } from "../../../scripts/spi/pacs008-generator.js";
import { parseXml, pickText } from "../core/xml.js";
import type { Timeline } from "../core/events.js";
import { newResourceId } from "../icom/outbox.js";

export const VIRTUAL_CREDITOR = "99999A04";
export const VIRTUAL_DEBTOR = "99999A03";

export interface VirtualPixRequest {
  /** ISPB do PSP recebedor. */
  to: string;
  amount: number;
  creditor?: { document?: string; branch?: string; accountNumber?: string; accountType?: "CACC" | "SVGS" | "TRAN" };
  /** Chave Pix do recebedor; muda a forma de iniciacao para DICT. */
  key?: string;
  description?: string;
}

export class VirtualParticipants {
  constructor(
    private submit: (fromIspb: string, xml: string, resourceId: string) => void,
    private timeline: Timeline,
    private replyDelayMs = 50,
  ) {}

  handles(ispb: string): boolean {
    return ispb === VIRTUAL_CREDITOR || ispb === VIRTUAL_DEBTOR;
  }

  /** Mensagem que o SPI entregou a um participante virtual. */
  receive(ispb: string, xml: string, type: string): void {
    if (type !== "pacs.008" && type !== "pacs.004") {
      const doc = parseXml(xml);
      const status = pickText(doc, "Envelope.Document.FIToFIPmtStsRpt.TxInfAndSts.TxSts");
      const id = pickText(doc, "Envelope.Document.FIToFIPmtStsRpt.TxInfAndSts.OrgnlInstrId");
      this.timeline.record("VIRTUAL", `${ispb} recebeu ${type}${status ? ` ${status}` : ""}`, { ispb, txId: id });
      return;
    }

    const doc = parseXml(xml);
    const e2e =
      type === "pacs.008"
        ? pickText(doc, "Envelope.Document.FIToFICstmrCdtTrf.CdtTrfTxInf.PmtId.EndToEndId")!
        : pickText(doc, "Envelope.Document.PmtRtr.TxInf.OrgnlEndToEndId")!;
    const instrId = type === "pacs.008" ? e2e : pickText(doc, "Envelope.Document.PmtRtr.TxInf.RtrId")!;

    this.timeline.record("VIRTUAL", `${ispb} recebeu ${type} e vai responder ACSP`, { ispb, txId: instrId });
    setTimeout(() => {
      const reply = generatePacs002({ senderIspb: ispb, originalEndToEndId: e2e, originalInstructionId: instrId, status: "ACSP" });
      this.submit(ispb, reply, newResourceId());
    }, this.replyDelayMs).unref();
  }

  /** Faz o Banco Virtual (99999A03) enviar um Pix para um participante. */
  sendPix(req: VirtualPixRequest): string {
    const xml = generatePacs008({
      senderIspb: VIRTUAL_DEBTOR,
      receiverIspb: req.to,
      amount: req.amount,
      localInstrument: req.key ? "DICT" : "MANU",
      proxy: req.key,
      description: req.description,
      debitParty: { name: "Fulano", document: "11111111111", branch: "1", accountNumber: "1", accountType: "CACC" },
      creditParty: {
        document: req.creditor?.document ?? "11111111111",
        branch: req.creditor?.branch ?? "1",
        accountNumber: req.creditor?.accountNumber ?? "1",
        accountType: req.creditor?.accountType ?? "CACC",
      },
    });
    const e2e = /<EndToEndId>([^<]+)<\/EndToEndId>/.exec(xml)![1];
    this.timeline.record("VIRTUAL", `${VIRTUAL_DEBTOR} (Banco Virtual) enviou Pix de ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(req.amount)} para ${req.to}`, {
      ispb: VIRTUAL_DEBTOR,
      txId: e2e,
    });
    this.submit(VIRTUAL_DEBTOR, xml, newResourceId());
    return e2e;
  }
}
