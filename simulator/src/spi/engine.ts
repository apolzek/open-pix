/**
 * Motor do SPI simulado.
 *
 * Processa as mensagens que os participantes gravaram no ICOM, na ordem:
 *   1. schema (XSD oficial do catalogo 5.13), cabecalho e idempotencia;
 *      problemas aqui viram admi.002 para quem enviou;
 *   2. regras de negocio que o catalogo atribui ao SPI (DS02, AGNT, RC09,
 *      RC10, AG12, AM01, FF08, AB03...), que viram pacs.002 RJCT;
 *   3. encaminhamento da ordem (pacs.008 ou pacs.004) ao PSP recebedor, com
 *      AppHdr e MsgId novos do SPI;
 *   4. espera do pacs.002 do recebedor: ACSP liquida (debita e credita as
 *      contas PI e avisa ACSC ao pagador e ACCC ao recebedor), RJCT devolve
 *      a rejeicao ao pagador;
 *   5. sem resposta ate 40s depois do AccptncDtTm, rejeita com AB03.
 */

import { generatePacs002 } from "../../../scripts/spi/pacs002-generator.js";
import { generateAdmi002 } from "../../../scripts/spi/admi002-generator.js";
import { SPI_ISPB, spiNamespace, buildEnvelope, isoUtc, type SpiMessageType } from "../../../scripts/spi/spi-envelope.js";
import { generateBizMsgIdr } from "../../../scripts/utils/biz-message-id-generator.js";
import { parseXml, pick, pickText, asArray } from "../core/xml.js";
import { validateSpiMessage, hasXmllint, namespaceOf } from "../core/xsd.js";
import type { Timeline } from "../core/events.js";
import { Participants, toCents, fromCents, brl } from "./participants.js";
import { messageCost, type TrafficLimiter } from "../icom/traffic.js";

export type SettlementStatus = "AWAITING_CREDITOR" | "SETTLED" | "REJECTED";

export interface Settlement {
  /** EndToEndId (pagamento) ou RtrId (devolucao): o OrgnlInstrId do pacs.002. */
  id: string;
  kind: "payment" | "return";
  /** EndToEndId original. */
  endToEndId: string;
  /** Conta PI debitada. */
  payer: string;
  /** Conta PI creditada. */
  payee: string;
  amountCents: number;
  receivedAt: string;
  deadline: string;
  status: SettlementStatus;
  reason?: string;
  settledAt?: string;
  /** Soma ja devolvida (so para pagamentos). */
  returnedCents: number;
  localInstrument?: string;
}

export interface EngineOptions {
  settlementTimeoutMs: number;
  validateXsd: boolean;
  /** Tolerancia do horario no EndToEndId (12h no catalogo). */
  e2eToleranceMs: number;
  /** Prazo para devolucao de um Pix (90 dias no regulamento). */
  returnWindowMs: number;
}

export interface Delivery {
  (ispb: string, xml: string, type: string): void;
}

const TYPES: Record<string, SpiMessageType> = {};
for (const t of ["pacs.008", "pacs.002", "pacs.004", "admi.002"] as SpiMessageType[]) TYPES[spiNamespace(t)] = t;

const RAW_BLOCK = (tag: string) => new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");

export class SpiEngine {
  readonly settlements = new Map<string, Settlement>();
  private seenMessages = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Chamado quando um pagamento liquida; o DICT usa para devolver fichas. */
  onSettled?: (s: Settlement) => void;

  constructor(
    private participants: Participants,
    private deliver: Delivery,
    private timeline: Timeline,
    private traffic: TrafficLimiter,
    private opts: EngineOptions,
  ) {
    if (opts.validateXsd && !hasXmllint()) {
      timeline.record("SPI", "xmllint nao encontrado: validacao por XSD desligada");
      this.opts = { ...opts, validateXsd: false };
    }
  }

  // -------------------------------------------------------------------------
  // Entrada
  // -------------------------------------------------------------------------

  /** Processa uma mensagem que o participante gravou no ICOM. */
  receive(fromIspb: string, xml: string, resourceId: string): void {
    const ns = namespaceOf(xml);
    const type = ns ? TYPES[ns] : undefined;
    if (!type || type === "admi.002") {
      this.reject(fromIspb, resourceId, "Schema desconhecido", `Namespace ${ns ?? "ausente"} nao habilitado para uso`);
      return;
    }

    if (this.opts.validateXsd) {
      const result = validateSpiMessage(xml);
      if (!result.valid) {
        this.reject(fromIspb, resourceId, "XML invalido", result.errors.join(" | "));
        return;
      }
    }

    let doc: Record<string, any>;
    try {
      doc = parseXml(xml);
    } catch (err) {
      this.reject(fromIspb, resourceId, "XML invalido", (err as Error).message);
      return;
    }

    const env = doc.Envelope;
    const fr = pickText(env, "AppHdr.Fr.FIId.FinInstnId.Othr.Id");
    const to = pickText(env, "AppHdr.To.FIId.FinInstnId.Othr.Id");
    const bizMsgIdr = pickText(env, "AppHdr.BizMsgIdr") ?? "";
    if (fr !== fromIspb) {
      this.reject(fromIspb, resourceId, "Emissor invalido", `AppHdr/Fr=${fr} diferente do ISPB da URL ${fromIspb}`, "AppHdr/Fr");
      return;
    }
    if (to !== SPI_ISPB) {
      this.reject(fromIspb, resourceId, "Destinatario invalido", `AppHdr/To deve ser o SPI (${SPI_ISPB}), veio ${to}`, "AppHdr/To");
      return;
    }
    if (bizMsgIdr.slice(1, 9) !== fromIspb) {
      this.reject(fromIspb, resourceId, "BizMsgIdr invalido", "BizMsgIdr deve comecar com M + ISPB do emissor", "AppHdr/BizMsgIdr");
      return;
    }

    const key = `${fromIspb}:${bizMsgIdr}`;
    if (this.seenMessages.has(key)) {
      this.timeline.record("SPI", `Mensagem ${bizMsgIdr} repetida: ignorada (idempotencia)`, { ispb: fromIspb });
      return;
    }
    this.seenMessages.add(key);

    const operations =
      type === "pacs.008" ? asArray(pick(env, "Document.FIToFICstmrCdtTrf.CdtTrfTxInf")).length
        : type === "pacs.002" ? asArray(pick(env, "Document.FIToFIPmtStsRpt.TxInfAndSts")).length
          : 1;
    const cost = messageCost(type, operations);
    const balance = this.traffic.debit(fromIspb, cost);
    this.timeline.record("SPI", `${type} de ${fromIspb} passou no schema e no cabecalho`, {
      ispb: fromIspb,
      data: { resourceId, bizMsgIdr, operations, trafficCost: cost, trafficBalance: Math.floor(balance) },
    });

    if (type === "pacs.008") this.onPacs008(fromIspb, xml, env);
    else if (type === "pacs.004") this.onPacs004(fromIspb, xml, env);
    else this.onPacs002(fromIspb, resourceId, env);
  }

  // -------------------------------------------------------------------------
  // pacs.008: ordem de pagamento
  // -------------------------------------------------------------------------

  private onPacs008(fromIspb: string, xml: string, env: Record<string, any>): void {
    const doc = env.Document.FIToFICstmrCdtTrf;
    const txs = asArray(doc.CdtTrfTxInf) as Record<string, any>[];
    const rawTxs = xml.match(RAW_BLOCK("CdtTrfTxInf")) ?? [];
    const rawGrpHdr = xml.match(RAW_BLOCK("GrpHdr"))?.[0] ?? "";
    const declared = Number(pickText(doc, "GrpHdr.NbOfTxs"));
    const serviceLevel = pickText(doc, "GrpHdr.PmtTpInf.SvcLvl.Prtry");

    txs.forEach((tx, i) => {
      const e2e = pickText(tx, "PmtId.EndToEndId")!;
      const debtorAgent = pickText(tx, "DbtrAgt.FinInstnId.ClrSysMmbId.MmbId")!;
      const creditorAgent = pickText(tx, "CdtrAgt.FinInstnId.ClrSysMmbId.MmbId")!;
      const amountCents = toCents(pickText(tx, "IntrBkSttlmAmt") ?? "0");
      const acceptedAt = Date.parse(pickText(tx, "AccptncDtTm") ?? "");
      const now = Date.now();
      // PAGFRD (suspeita de fraude) conta o prazo a partir do recebimento pelo SPI.
      const deadline = (serviceLevel === "PAGFRD" ? now : acceptedAt) + this.opts.settlementTimeoutMs;

      this.timeline.record("SPI", `Ordem de pagamento ${brl(amountCents)} de ${debtorAgent} para ${creditorAgent}`, {
        ispb: fromIspb,
        txId: e2e,
        data: { localInstrument: pickText(tx, "MndtRltdInf.Tp.LclInstrm.Prtry"), acceptedAt: pickText(tx, "AccptncDtTm") },
      });

      const rejectPayer = (code: string, info: string) => {
        this.timeline.record("SPI", `Rejeitada pelo SPI: ${code} (${info})`, { ispb: fromIspb, txId: e2e });
        this.sendStatus(fromIspb, e2e, e2e, "RJCT", code, info);
      };

      const sender = this.participants.get(fromIspb)!;
      const debtor = this.participants.get(debtorAgent);
      const creditor = this.participants.get(creditorAgent);
      const e2eStamp = Date.UTC(
        Number(e2e.slice(9, 13)), Number(e2e.slice(13, 15)) - 1, Number(e2e.slice(15, 17)),
        Number(e2e.slice(17, 19)), Number(e2e.slice(19, 21)),
      );

      if (declared !== txs.length) return rejectPayer("AM18", `NbOfTxs=${declared} com ${txs.length} transacoes`);
      if (sender.sendBlocked) return rejectPayer("DS02", "envio de Pix bloqueado no SPI-Web");
      if (!debtor) return rejectPayer("RC09", `ISPB do pagador ${debtorAgent} inexistente`);
      if (debtorAgent !== fromIspb) return rejectPayer("AGNT", `${fromIspb} nao e liquidante de ${debtorAgent}`);
      if (!creditor || !creditor.active) return rejectPayer("RC10", `ISPB do recebedor ${creditorAgent} inexistente`);
      if (debtorAgent === creditorAgent) return rejectPayer("AG12", "pagador e recebedor no mesmo participante");
      if (amountCents <= 0) return rejectPayer("AM01", "valor zero");
      if (Math.abs(now - e2eStamp) > this.opts.e2eToleranceMs) return rejectPayer("FF08", "horario do EndToEndId fora da tolerancia de 12h");
      if (this.settlements.has(e2e)) return rejectPayer("ED05", "EndToEndId ja utilizado");
      if (!Number.isFinite(acceptedAt) || deadline <= now) return rejectPayer("AB03", "prazo de 40s ja expirado na chegada");

      const settlement: Settlement = {
        id: e2e,
        kind: "payment",
        endToEndId: e2e,
        payer: debtorAgent,
        payee: creditorAgent,
        amountCents,
        receivedAt: new Date(now).toISOString(),
        deadline: new Date(deadline).toISOString(),
        status: "AWAITING_CREDITOR",
        returnedCents: 0,
        localInstrument: pickText(tx, "MndtRltdInf.Tp.LclInstrm.Prtry"),
      };
      this.settlements.set(e2e, settlement);
      this.armTimeout(settlement);

      const forwarded = this.forward("pacs.008", creditorAgent, "FIToFICstmrCdtTrf", rawGrpHdr.replace(/<NbOfTxs>\d+<\/NbOfTxs>/, "<NbOfTxs>1</NbOfTxs>"), rawTxs[i]);
      this.timeline.record("SPI", `pacs.008 encaminhada a ${creditorAgent}; aguardando pacs.002 ate ${settlement.deadline}`, {
        ispb: creditorAgent,
        txId: e2e,
      });
      this.deliver(creditorAgent, forwarded, "pacs.008");
    });
  }

  // -------------------------------------------------------------------------
  // pacs.004: devolucao
  // -------------------------------------------------------------------------

  private onPacs004(fromIspb: string, xml: string, env: Record<string, any>): void {
    const doc = env.Document.PmtRtr;
    const txs = asArray(doc.TxInf) as Record<string, any>[];
    const rawTxs = xml.match(RAW_BLOCK("TxInf")) ?? [];
    const rawGrpHdr = xml.match(RAW_BLOCK("GrpHdr"))?.[0] ?? "";

    txs.forEach((tx, i) => {
      const rtrId = pickText(tx, "RtrId")!;
      const e2e = pickText(tx, "OrgnlEndToEndId")!;
      const amountCents = toCents(pickText(tx, "RtrdIntrBkSttlmAmt") ?? "0");
      const original = this.settlements.get(e2e);
      const now = Date.now();

      this.timeline.record("SPI", `Devolucao ${rtrId} de ${brl(amountCents)} referente a ${e2e}`, {
        ispb: fromIspb,
        txId: rtrId,
        data: { reason: pickText(tx, "RtrRsnInf.Rsn.Cd") },
      });

      const rejectPayer = (code: string, info: string) => {
        this.timeline.record("SPI", `Devolucao rejeitada pelo SPI: ${code} (${info})`, { ispb: fromIspb, txId: rtrId });
        this.sendStatus(fromIspb, rtrId, e2e, "RJCT", code, info);
      };

      if (this.participants.get(fromIspb)!.sendBlocked) return rejectPayer("DS02", "envio de Pix bloqueado no SPI-Web");
      if (!original || original.kind !== "payment" || original.status !== "SETTLED") {
        return rejectPayer("CH16", "pagamento original nao encontrado ou nao liquidado");
      }
      if (original.payee !== fromIspb) return rejectPayer("AGNT", "so o PSP que recebeu o Pix pode devolve-lo");
      if (now - Date.parse(original.settledAt!) > this.opts.returnWindowMs) return rejectPayer("DT05", "prazo de devolucao expirado");
      if (amountCents <= 0) return rejectPayer("AM01", "valor zero");
      if (this.settlements.has(rtrId)) return rejectPayer("ED05", "RtrId ja utilizado");

      const settlement: Settlement = {
        id: rtrId,
        kind: "return",
        endToEndId: e2e,
        payer: fromIspb,
        payee: original.payer,
        amountCents,
        receivedAt: new Date(now).toISOString(),
        deadline: new Date(now + this.opts.settlementTimeoutMs).toISOString(),
        status: "AWAITING_CREDITOR",
        returnedCents: 0,
      };
      this.settlements.set(rtrId, settlement);
      this.armTimeout(settlement);

      const forwarded = this.forward("pacs.004", original.payer, "PmtRtr", rawGrpHdr, rawTxs[i]);
      this.timeline.record("SPI", `pacs.004 encaminhada a ${original.payer}; aguardando pacs.002`, { ispb: original.payer, txId: rtrId });
      this.deliver(original.payer, forwarded, "pacs.004");
    });
  }

  // -------------------------------------------------------------------------
  // pacs.002 do PSP recebedor
  // -------------------------------------------------------------------------

  private onPacs002(fromIspb: string, resourceId: string, env: Record<string, any>): void {
    for (const tx of asArray(pick(env, "Document.FIToFIPmtStsRpt.TxInfAndSts")) as Record<string, any>[]) {
      const id = pickText(tx, "OrgnlInstrId")!;
      const status = pickText(tx, "TxSts");
      const reason = pickText(tx, "StsRsnInf.Rsn.Cd");
      const settlement = this.settlements.get(id);

      if (!settlement) {
        this.reject(fromIspb, resourceId, "Transacao inexistente", `Nenhuma ordem pendente com OrgnlInstrId ${id}`, "OrgnlInstrId");
        continue;
      }
      if (settlement.payee !== fromIspb) {
        this.reject(fromIspb, resourceId, "Participante invalido", `Somente ${settlement.payee} pode responder ${id}`, "AppHdr/Fr");
        continue;
      }
      if (settlement.status !== "AWAITING_CREDITOR") {
        this.timeline.record("SPI", `pacs.002 ${status} chegou depois do fim da transacao (${settlement.status}): ignorada`, {
          ispb: fromIspb,
          txId: id,
        });
        continue;
      }

      const elapsed = Date.now() - Date.parse(settlement.receivedAt);
      this.timeline.record("SPI", `Recebedor ${fromIspb} respondeu ${status}${reason ? ` ${reason}` : ""} em ${elapsed} ms`, {
        ispb: fromIspb,
        txId: id,
      });

      if (status === "ACSP") this.settle(settlement);
      else if (status === "RJCT") this.finishRejected(settlement, reason ?? "DS04", "rejeitada pelo recebedor", false);
      else this.reject(fromIspb, resourceId, "TxSts invalido", `PSP recebedor so responde ACSP ou RJCT, veio ${status}`, "TxSts");
    }
  }

  // -------------------------------------------------------------------------
  // Liquidacao
  // -------------------------------------------------------------------------

  private settle(s: Settlement): void {
    this.clearTimer(s.id);
    if (!this.participants.transfer(s.payer, s.payee, s.amountCents)) {
      this.finishRejected(s, "AM04", "saldo insuficiente na conta PI do pagador", true);
      return;
    }
    const settledAt = new Date();
    s.status = "SETTLED";
    s.settledAt = settledAt.toISOString();
    if (s.kind === "return") {
      const original = this.settlements.get(s.endToEndId);
      if (original) original.returnedCents += s.amountCents;
    }

    const payer = this.participants.get(s.payer)!;
    const payee = this.participants.get(s.payee)!;
    this.timeline.record("SPI", `LIQUIDADA: conta PI ${s.payer} -${brl(s.amountCents)}, conta PI ${s.payee} +${brl(s.amountCents)}`, {
      txId: s.id,
      data: { [s.payer]: fromCents(payer.balanceCents), [s.payee]: fromCents(payee.balanceCents) },
    });

    this.sendStatus(s.payer, s.id, s.endToEndId, "ACSC", undefined, undefined, settledAt);
    this.sendStatus(s.payee, s.id, s.endToEndId, "ACCC", undefined, undefined, settledAt);
    this.onSettled?.(s);
  }

  private finishRejected(s: Settlement, code: string, info: string, notifyPayee: boolean): void {
    this.clearTimer(s.id);
    s.status = "REJECTED";
    s.reason = code;
    this.timeline.record("SPI", `Transacao rejeitada: ${code} (${info})`, { txId: s.id });
    this.sendStatus(s.payer, s.id, s.endToEndId, "RJCT", code, info);
    if (notifyPayee) this.sendStatus(s.payee, s.id, s.endToEndId, "RJCT", code, info);
  }

  private armTimeout(s: Settlement): void {
    const ms = Math.max(0, Date.parse(s.deadline) - Date.now());
    const timer = setTimeout(() => {
      if (s.status !== "AWAITING_CREDITOR") return;
      this.finishRejected(s, "AB03", `recebedor ${s.payee} nao respondeu no prazo`, true);
    }, ms);
    timer.unref();
    this.timers.set(s.id, timer);
  }

  private clearTimer(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  // -------------------------------------------------------------------------
  // Saida
  // -------------------------------------------------------------------------

  /** Reembala Document da ordem com cabecalho e MsgId do SPI. */
  private forward(type: SpiMessageType, to: string, root: string, rawGrpHdr: string, rawTx: string): string {
    const bizMsgIdr = generateBizMsgIdr(SPI_ISPB);
    const createdAt = isoUtc();
    const grpHdr = rawGrpHdr
      .replace(/<MsgId>[^<]*<\/MsgId>/, `<MsgId>${bizMsgIdr}</MsgId>`)
      .replace(/<CreDtTm>[^<]*<\/CreDtTm>/, `<CreDtTm>${createdAt}</CreDtTm>`);
    return buildEnvelope({
      type,
      from: SPI_ISPB,
      to,
      bizMsgIdr,
      createdAt,
      document: `<${root}>\n${grpHdr}\n${rawTx}\n</${root}>`,
    });
  }

  private sendStatus(
    to: string,
    instrId: string,
    endToEndId: string,
    status: "ACSC" | "ACCC" | "RJCT",
    reason?: string,
    info?: string,
    settledAt?: Date,
  ): void {
    const xml = generatePacs002({
      senderIspb: SPI_ISPB,
      receiverIspb: to,
      originalEndToEndId: endToEndId,
      originalInstructionId: instrId,
      status,
      rejectReasonCode: reason,
      additionalInfo: info?.slice(0, 105),
      settledAt,
    });
    this.timeline.record("SPI", `pacs.002 ${status}${reason ? ` ${reason}` : ""} enviada a ${to}`, { ispb: to, txId: instrId });
    this.deliver(to, xml, "pacs.002");
  }

  private reject(to: string, resourceId: string, reason: string, description: string, location?: string): void {
    this.timeline.record("SPI", `admi.002 para ${to}: ${reason} - ${description}`, { ispb: to, data: { resourceId } });
    this.deliver(to, generateAdmi002({ receiverIspb: to, resourceId, reason, description, location }), "admi.002");
  }

  reset(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.settlements.clear();
    this.seenMessages.clear();
  }
}
