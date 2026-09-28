/**
 * Banco digital (PSP participante direto do SPI) para estudo.
 *
 * Guarda clientes e contas em memoria e fala com o "Bacen" pelos mesmos
 * caminhos de um PSP real:
 * - DICT (API v2) para cadastrar chaves e descobrir a conta de uma chave;
 * - ICOM para enviar pacs.008/pacs.002/pacs.004 ao SPI e ler o que o SPI
 *   entrega (stream com PI-Pull-Next).
 *
 * Todo passo vira uma linha no diario (JourneyLog), com o porque.
 */

import crypto from "node:crypto";
import path from "node:path";

import { IcomClient, DictClient, HttpError, type ReceivedMessage } from "../../../scripts/utils/http-client.js";
import { generatePacs008, type LocalInstrument } from "../../../scripts/spi/pacs008-generator.js";
import { generatePacs002 } from "../../../scripts/spi/pacs002-generator.js";
import { generatePacs004 } from "../../../scripts/spi/pacs004-generator.js";
import { generateEndToEndId } from "../../../scripts/utils/endtoendid-generator.js";
import { buildCreateEntryRequest } from "../../../scripts/dict/key-bulk-creator.js";
import { lookupKey, detectKeyType, parseProblem, type KeyType, type LookupResult } from "../../../scripts/dict/key-lookup.js";
import { generateStaticQr } from "../../../scripts/qrcode/qr-generator.js";
import { parseQrPayload } from "../../../scripts/qrcode/qr-parser.js";
import { parseXml, pickText } from "../../../simulator/src/core/xml.js";
import { validateSpiMessage, hasXmllint } from "../../../simulator/src/core/xsd.js";
import { JourneyLog } from "./journey.js";

export interface BankOptions {
  ispb: string;
  name: string;
  /** Rotulo curto no console, ex. ALFA. */
  label: string;
  /** Codigo ANSI da cor do rotulo. */
  color: string;
  icomUrl: string;
  dictUrl: string;
  certDir: string;
}

export interface Customer {
  id: string;
  name: string;
  taxId: string;
  personType: "NATURAL_PERSON" | "LEGAL_PERSON";
  branch: string;
  account: string;
  accountType: "CACC" | "SVGS" | "TRAN";
  balanceCents: number;
  keys: { type: KeyType; key: string }[];
}

export type TxKind = "pix-out" | "pix-in" | "return-out" | "return-in" | "internal";
export type TxStatus = "PENDENTE" | "CONCLUIDO" | "REJEITADO";

export interface Tx {
  /** EndToEndId (Pix) ou RtrId (devolucao). */
  id: string;
  endToEndId: string;
  kind: TxKind;
  customerId: string;
  counterparty: string;
  amountCents: number;
  status: TxStatus;
  reason?: string;
  createdAt: string;
  journeyId: string;
  resourceId?: string;
  returnedCents: number;
  description?: string;
  startedAt: number;
}

interface PendingPayment {
  id: string;
  customerId: string;
  journeyId: string;
  endToEndId: string;
  localInstrument: LocalInstrument;
  key?: string;
  txId?: string;
  fixedAmountCents?: number;
  /** Destino no proprio banco: transferencia interna, sem SPI. */
  localCustomer?: Customer;
  entry?: LookupResult["entry"];
  createdAt: number;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const brl = (cents: number) => BRL.format(cents / 100);

const REASONS: Record<string, string> = {
  AB03: "tempo esgotado no SPI (40 s)",
  AC03: "conta do recebedor inexistente",
  AM04: "saldo insuficiente na conta PI do banco pagador",
  AM09: "valor de devolucao maior que o Pix original",
  BE01: "CPF/CNPJ nao confere com o titular da conta",
  DS02: "envio de Pix bloqueado no SPI",
  RC10: "banco do recebedor inexistente no SPI",
  AG12: "pagador e recebedor no mesmo banco",
  ED05: "erro no processamento",
  DS04: "recusada pelo banco do recebedor",
  CH16: "conteudo incompativel com as regras",
};

function maskDoc(doc?: string): string {
  if (!doc) return "?";
  return doc.length === 11 ? `***.${doc.slice(3, 6)}.${doc.slice(6, 9)}-**` : `${doc.slice(0, 2)}.***.***/${doc.slice(8, 12)}-**`;
}

function typeOf(xml: string): string {
  return /xmlns="https:\/\/www\.bcb\.gov\.br\/pi\/([a-z]+\.\d{3})\//.exec(xml)?.[1] ?? "?";
}

export class Bank {
  readonly log: JourneyLog;
  readonly customers = new Map<string, Customer>();
  readonly txs = new Map<string, Tx>();
  private keys = new Map<string, string>();
  private pending = new Map<string, PendingPayment>();
  private icom: IcomClient;
  private dict: DictClient;
  private running = false;
  /** Laboratorio: o banco para de ler o ICOM, como se estivesse fora do ar. */
  offline = false;
  /** Mensagens lidas enquanto o banco estava fora do ar, tratadas na volta. */
  private backlog: ReceivedMessage[] = [];
  private loop?: Promise<void>;
  private xsd = hasXmllint();

  constructor(readonly opts: BankOptions) {
    this.log = new JourneyLog(opts.label, opts.color);
    const tls = {
      ispb: opts.ispb,
      certPath: path.join(opts.certDir, `${opts.ispb}.pem`),
      keyPath: path.join(opts.certDir, `${opts.ispb}.key`),
      caPath: path.join(opts.certDir, "ca.pem"),
      maxRetries: 1,
    };
    this.icom = new IcomClient({ baseUrl: opts.icomUrl, ...tls });
    this.dict = new DictClient({ baseUrl: opts.dictUrl, ...tls });
  }

  // -------------------------------------------------------------------------
  // Clientes e chaves
  // -------------------------------------------------------------------------

  addCustomer(c: Omit<Customer, "id" | "keys" | "balanceCents"> & { balance: number }): Customer {
    const customer: Customer = {
      id: `${this.opts.label.toLowerCase()}-${this.customers.size + 1}`,
      keys: [],
      balanceCents: Math.round(c.balance * 100),
      name: c.name,
      taxId: c.taxId,
      personType: c.personType,
      branch: c.branch,
      account: c.account,
      accountType: c.accountType,
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  customer(id: string): Customer {
    const c = this.customers.get(id);
    if (!c) throw new Error(`Cliente ${id} inexistente`);
    return c;
  }

  async registerKey(customerId: string, type: KeyType, key?: string): Promise<string> {
    const c = this.customer(customerId);
    const j = this.log.start(`Cadastro de chave ${type} para ${c.name}`);
    if (type === "CPF" || type === "CNPJ") key = c.taxId;
    try {
      const xml = buildCreateEntryRequest({
        keyType: type,
        key: type === "EVP" ? undefined : key,
        account: {
          participant: this.opts.ispb,
          branch: c.branch,
          accountNumber: c.account,
          accountType: c.accountType,
          openingDate: "2024-01-02T03:00:00.000Z",
        },
        owner: { type: c.personType, taxIdNumber: c.taxId, name: c.name },
      });
      this.log.step(j, "send", `DICT: POST /api/v2/entries/ (CreateEntryRequest)`,
        "Toda chave Pix vive no DICT, o diretorio do Bacen que liga chave -> conta. So o banco da conta pode cadastra-la.");
      const res = await this.dict.call("POST", "/entries/", xml);
      const created = pickText(parseXml(res.body), "CreateEntryResponse.Entry.Key") ?? key!;
      c.keys.push({ type, key: created });
      this.keys.set(created, c.id);
      this.log.step(j, "ok", `DICT respondeu ${res.statusCode}: chave ${created} ativa`,
        type === "EVP" ? "Chave aleatoria (EVP): quem gera o UUID e o proprio DICT." : undefined);
      return created;
    } catch (err) {
      this.log.step(j, "error", `DICT recusou: ${this.describe(err)}`);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Enviar Pix: consulta (DICT) + confirmacao (SPI)
  // -------------------------------------------------------------------------

  /** Passo 1 do Pix por chave: descobre para quem vai o dinheiro. */
  async prepareByKey(customerId: string, key: string, via: { qr?: string } = {}): Promise<Record<string, unknown>> {
    const c = this.customer(customerId);
    let txId: string | undefined;
    let fixedAmountCents: number | undefined;
    let instrument: LocalInstrument = "DICT";

    const j = this.log.start(via.qr ? `Pix por QR Code de ${c.name}` : `Pix por chave de ${c.name} para ${key}`);
    if (via.qr) {
      const qr = parseQrPayload(via.qr);
      this.log.step(j, "info", `QR Code lido: ${qr.isStatic ? "estatico" : "dinamico"}, CRC ${qr.crcValid ? "ok" : "INVALIDO"}`,
        "O QR (BR Code) e texto EMV: campos TLV com a chave, o valor, o txid e um CRC16 no final.");
      if (!qr.crcValid || !qr.pixKey) {
        this.log.step(j, "error", `QR recusado: ${qr.issues.join("; ") || "sem chave Pix"}`);
        throw new Error("QR Code invalido ou dinamico (este banco so paga QR estatico)");
      }
      key = qr.pixKey;
      txId = qr.txId && qr.txId !== "***" ? qr.txId : undefined;
      fixedAmountCents = qr.amount ? Math.round(Number(qr.amount) * 100) : undefined;
      instrument = "QRES";
      this.log.step(j, "info", `Chave ${key}${fixedAmountCents ? `, valor ${brl(fixedAmountCents)}` : ""}${txId ? `, txid ${txId}` : ""}`,
        "Na pacs.008 a forma de iniciacao sera QRES e o txid vai em TxId, para o recebedor conciliar.");
    }

    const keyType = detectKeyType(key);
    if (!keyType) {
      this.log.step(j, "error", `"${key}" nao tem formato de chave Pix`);
      throw new Error("Chave em formato invalido");
    }
    this.log.step(j, "info", `Chave identificada como ${keyType}`,
      "O formato define o tipo: 11 digitos CPF, 14 CNPJ, +55... telefone, e-mail ou UUID (aleatoria).");

    const endToEndId = generateEndToEndId(this.opts.ispb);
    this.log.step(j, "info", `EndToEndId gerado: ${endToEndId}`,
      "E + ISPB do banco + data/hora UTC (yyyyMMddHHmm) + 11 caracteres. Identifica o Pix do inicio ao fim e ja vai na consulta ao DICT.");

    const payment: PendingPayment = {
      id: crypto.randomUUID(),
      customerId,
      journeyId: j,
      endToEndId,
      localInstrument: instrument,
      key,
      txId,
      fixedAmountCents,
      createdAt: Date.now(),
    };

    const localId = this.keys.get(key);
    if (localId) {
      payment.localCustomer = this.customer(localId);
      this.log.step(j, "warn", `A chave e de um cliente deste banco (${payment.localCustomer.name}): transferencia interna`,
        "Pix entre contas do mesmo banco nao passa pelo DICT nem pelo SPI: o DICT recusaria a consulta (EntryCannotBeQueriedForBookTransfer) e o SPI rejeitaria com AG12.");
      this.pending.set(payment.id, payment);
      return { paymentId: payment.id, name: payment.localCustomer.name, document: maskDoc(payment.localCustomer.taxId), bank: `${this.opts.name} (interno)`, fixedAmount: fixedAmountCents };
    }

    this.log.step(j, "send", `DICT: GET /api/v2/entries/${encodeURIComponent(key)}`,
      `Cabecalhos PI-RequestingParticipant=${this.opts.ispb}, PI-PayerId=${maskDoc(c.taxId)} (CPF/CNPJ do pagador, para o antiscan) e PI-EndToEndId.`);
    let found: LookupResult;
    try {
      found = await lookupKey(this.dict, { key, payerId: c.taxId, endToEndId });
    } catch (err) {
      const msg = this.describe(err);
      this.log.step(j, "error", `DICT recusou: ${msg}`,
        err instanceof HttpError && err.statusCode === 429 ? "Antiscan: consultas a chaves inexistentes custam 20 fichas do balde do pagador (PF: 100 fichas, +2 por minuto)." : undefined);
      throw new Error(msg);
    }
    if (!found.found || !found.entry) {
      this.log.step(j, "error", "DICT: 404, chave nao encontrada",
        "Consulta que da 404 custa 20 fichas ao pagador e 3 ao banco: isso trava quem tenta varrer chaves.");
      throw new Error("Chave nao encontrada no DICT");
    }
    payment.entry = found.entry;
    this.pending.set(payment.id, payment);
    this.log.step(j, "receive", `DICT: 200, ${found.entry.owner.name} (${maskDoc(found.entry.owner.taxIdNumber)}), banco ${found.entry.account.participant}, ag ${found.entry.account.branch ?? "-"} conta ${found.entry.account.accountNumber}`,
      "O app mostra nome e documento mascarado para o cliente confirmar antes de pagar.");
    return {
      paymentId: payment.id,
      name: found.entry.owner.name,
      document: maskDoc(found.entry.owner.taxIdNumber),
      bank: found.entry.account.participant,
      fixedAmount: fixedAmountCents,
    };
  }

  /** Passo 2: o cliente confirmou o valor. */
  async confirm(paymentId: string, amountCents: number, description?: string): Promise<Tx> {
    const p = this.pending.get(paymentId);
    if (!p) throw new Error("Pagamento expirado ou inexistente; consulte a chave de novo");
    this.pending.delete(paymentId);
    const c = this.customer(p.customerId);
    const j = p.journeyId;
    if (p.fixedAmountCents) amountCents = p.fixedAmountCents;

    this.log.step(j, "info", `Cliente confirmou ${brl(amountCents)}${description ? ` ("${description}")` : ""}`);
    if (!(amountCents > 0)) {
      this.log.step(j, "error", "Valor invalido");
      throw new Error("Valor invalido");
    }
    if (c.balanceCents < amountCents) {
      this.log.step(j, "error", `Saldo insuficiente: ${brl(c.balanceCents)}`);
      throw new Error("Saldo insuficiente");
    }

    if (p.localCustomer) {
      c.balanceCents -= amountCents;
      p.localCustomer.balanceCents += amountCents;
      const tx = this.record({ id: p.endToEndId, endToEndId: p.endToEndId, kind: "internal", customerId: c.id, counterparty: p.localCustomer.name, amountCents, status: "CONCLUIDO", journeyId: j, description });
      this.log.step(j, "ok", `Transferencia interna concluida: ${c.name} -${brl(amountCents)}, ${p.localCustomer.name} +${brl(amountCents)}`,
        "Nenhuma mensagem saiu do banco: a conta PI no Bacen nao muda.");
      return tx;
    }

    const e = p.entry!;
    const acceptedAt = new Date();
    const xml = generatePacs008({
      senderIspb: this.opts.ispb,
      receiverIspb: e.account.participant,
      amount: amountCents / 100,
      endToEndId: p.endToEndId,
      acceptedAt,
      localInstrument: p.localInstrument,
      proxy: p.key,
      txId: p.txId,
      description,
      debitParty: { name: c.name, document: c.taxId, branch: c.branch, accountNumber: c.account, accountType: c.accountType },
      creditParty: { document: e.owner.taxIdNumber, branch: e.account.branch, accountNumber: e.account.accountNumber, accountType: e.account.accountType as "CACC" },
    });
    return this.sendOrder(c, xml, {
      id: p.endToEndId,
      kind: "pix-out",
      counterparty: `${e.owner.name} (${e.account.participant})`,
      amountCents,
      journeyId: j,
      description,
      acceptedAt,
    });
  }

  /** Pix por dados da conta (MANU): sem DICT. */
  async sendManual(customerId: string, to: { ispb: string; branch?: string; account: string; accountType: "CACC" | "SVGS" | "TRAN"; document: string; name?: string }, amountCents: number, description?: string): Promise<Tx> {
    const c = this.customer(customerId);
    const j = this.log.start(`Pix por dados da conta de ${c.name} para ${to.name ?? to.document} no banco ${to.ispb}`);
    this.log.step(j, "info", "Forma de iniciacao MANU: o cliente digitou banco, agencia, conta e documento",
      "Sem chave nao ha consulta ao DICT, e a pacs.008 nao leva o bloco Prxy.");
    if (c.balanceCents < amountCents || !(amountCents > 0)) {
      this.log.step(j, "error", "Saldo insuficiente ou valor invalido");
      throw new Error("Saldo insuficiente ou valor invalido");
    }
    const endToEndId = generateEndToEndId(this.opts.ispb);
    this.log.step(j, "info", `EndToEndId gerado: ${endToEndId}`);
    const acceptedAt = new Date();
    const xml = generatePacs008({
      senderIspb: this.opts.ispb,
      receiverIspb: to.ispb,
      amount: amountCents / 100,
      endToEndId,
      acceptedAt,
      localInstrument: "MANU",
      description,
      debitParty: { name: c.name, document: c.taxId, branch: c.branch, accountNumber: c.account, accountType: c.accountType },
      creditParty: { document: to.document, branch: to.branch, accountNumber: to.account, accountType: to.accountType },
    });
    return this.sendOrder(c, xml, { id: endToEndId, kind: "pix-out", counterparty: `${to.name ?? maskDoc(to.document)} (${to.ispb})`, amountCents, journeyId: j, description, acceptedAt });
  }

  /** Devolve (total ou parcialmente) um Pix recebido: pacs.004 MD06. */
  async returnPix(endToEndId: string, amountCents: number): Promise<Tx> {
    const original = this.txs.get(endToEndId);
    if (!original || original.kind !== "pix-in" || original.status !== "CONCLUIDO") throw new Error("Pix recebido e concluido nao encontrado");
    const c = this.customer(original.customerId);
    const j = this.log.start(`Devolucao de ${brl(amountCents)} do Pix ${endToEndId}`);
    const available = original.amountCents - original.returnedCents;
    if (amountCents <= 0 || amountCents > available) {
      this.log.step(j, "error", `Valor maior que o disponivel para devolucao (${brl(available)})`);
      throw new Error("Valor de devolucao invalido");
    }
    if (c.balanceCents < amountCents) {
      this.log.step(j, "error", "Saldo insuficiente para devolver");
      throw new Error("Saldo insuficiente");
    }
    const payerIspb = original.counterparty.match(/\(([0-9A-Z]{8})\)$/)?.[1];
    const xml = generatePacs004({
      senderIspb: this.opts.ispb,
      originalPayerIspb: payerIspb!,
      originalEndToEndId: endToEndId,
      amount: amountCents / 100,
      returnReasonCode: "MD06",
      returnInfo: "Devolucao solicitada pelo recebedor",
    });
    const rtrId = /<RtrId>([^<]+)</.exec(xml)![1];
    this.log.step(j, "info", `pacs.004 com RtrId ${rtrId} e motivo MD06`,
      "A devolucao tem identificador proprio (D + ISPB + data/hora UTC...) e aponta o Pix original em OrgnlEndToEndId. Pode ser feita em ate 90 dias.");
    const tx = await this.sendOrder(c, xml, { id: rtrId, endToEndId, kind: "return-out", counterparty: original.counterparty, amountCents, journeyId: j, acceptedAt: new Date() });
    return tx;
  }

  generateQr(customerId: string, key: string, amountCents?: number, txId?: string): string {
    const c = this.customer(customerId);
    const j = this.log.start(`QR Code estatico de ${c.name}`);
    const payload = generateStaticQr({
      pixKey: key,
      merchantName: c.name.normalize("NFD").replace(/[^\x20-\x7e]/g, "").slice(0, 25),
      merchantCity: "SAO PAULO",
      amount: amountCents ? amountCents / 100 : undefined,
      txId,
    });
    this.log.step(j, "ok", `Payload BR Code gerado (${payload.length} caracteres)`,
      "Campos 00 (formato), 26 (br.gov.bcb.pix + chave), 52/53/54 (categoria, moeda 986, valor), 58/59/60 (pais, nome, cidade), 62-05 (txid) e 63 (CRC16).", payload);
    return payload;
  }

  // -------------------------------------------------------------------------
  // Envio ao SPI via ICOM
  // -------------------------------------------------------------------------

  private async sendOrder(
    c: Customer,
    xml: string,
    t: { id: string; endToEndId?: string; kind: TxKind; counterparty: string; amountCents: number; journeyId: string; description?: string; acceptedAt: Date },
  ): Promise<Tx> {
    const j = t.journeyId;
    const type = typeOf(xml);
    c.balanceCents -= t.amountCents;
    this.log.step(j, "info", `${brl(t.amountCents)} reservado na conta de ${c.name} (saldo ${brl(c.balanceCents)})`,
      "O dinheiro sai da conta do cliente agora e so volta se o SPI rejeitar.");

    this.log.step(j, "info", `${type} montada: AppHdr Fr=${this.opts.ispb} To=00038166 (SPI), MsgDefIdr ${/<MsgDefIdr>([^<]+)/.exec(xml)?.[1]}`,
      "Toda mensagem vai ao SPI, nunca direto ao outro banco: o outro banco so aparece no corpo (CdtrAgt).", xml);
    if (this.xsd) {
      const v = validateSpiMessage(xml);
      this.log.step(j, v.valid ? "ok" : "error", v.valid ? "Validada no XSD oficial do catalogo 5.13" : `XSD: ${v.errors[0]}`,
        v.valid ? "Assinatura XMLDSig (Sgntr) fica vazia neste simulador." : undefined);
    }

    const tx = this.record({ id: t.id, endToEndId: t.endToEndId ?? t.id, kind: t.kind, customerId: c.id, counterparty: t.counterparty, amountCents: t.amountCents, status: "PENDENTE", journeyId: j, description: t.description });
    tx.startedAt = t.acceptedAt.getTime();
    try {
      this.log.step(j, "send", `ICOM: POST /api/v1/in/${this.opts.ispb}/msgs (gzip, mTLS)`,
        "O ICOM so grava a mensagem e devolve 201; a validacao e a liquidacao acontecem depois, no SPI.");
      const { statusCode, resourceIds } = await this.icom.sendMessages(xml);
      tx.resourceId = resourceIds[0];
      this.log.step(j, "ok", `ICOM respondeu ${statusCode} Created, PI-ResourceId ${resourceIds[0]}`,
        "Agora e esperar a resposta do SPI no stream de leitura. O prazo total e de 40 s a partir do aceite (AccptncDtTm).");
    } catch (err) {
      c.balanceCents += t.amountCents;
      tx.status = "REJEITADO";
      tx.reason = this.describe(err);
      this.log.step(j, "error", `ICOM recusou: ${tx.reason}; valor devolvido ao cliente`);
      throw err;
    }
    return tx;
  }

  private record(t: Omit<Tx, "createdAt" | "returnedCents" | "startedAt">): Tx {
    const tx: Tx = { ...t, createdAt: new Date().toISOString(), returnedCents: 0, startedAt: Date.now() };
    this.txs.set(tx.id, tx);
    return tx;
  }

  // -------------------------------------------------------------------------
  // Leitura do ICOM
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.consume();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.icom.destroy();
    this.dict.destroy();
  }

  private async consume(): Promise<void> {
    let pullNext: string | undefined;
    while (this.running) {
      if (this.offline) {
        if (pullNext) await this.icom.closeStream(pullNext).catch(() => undefined);
        pullNext = undefined;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      try {
        const read = await this.icom.readStream(pullNext);
        pullNext = read.pullNext;
        if (this.offline) {
          // A leitura em andamento terminou depois da queda: guarda sem tratar.
          this.backlog.push(...read.messages);
          continue;
        }
        const batch = [...this.backlog.splice(0), ...read.messages];
        for (const m of batch) {
          try {
            await this.handle(m);
          } catch (err) {
            console.error(`[${this.opts.label}] erro tratando mensagem: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        pullNext = undefined;
        if (this.running) await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    if (pullNext) await this.icom.closeStream(pullNext).catch(() => undefined);
  }

  setOffline(on: boolean): void {
    if (this.offline === on) return;
    this.offline = on;
    const j = this.log.start(on ? "Laboratorio: banco fora do ar" : "Laboratorio: banco de volta");
    this.log.step(j, on ? "warn" : "ok", on ? "O banco parou de ler o stream do ICOM" : "O banco voltou a ler o stream do ICOM",
      on
        ? "Pix enviados para este banco ficam sem resposta: 40 s depois do aceite o SPI rejeita com AB03 e o pagador recebe o estorno."
        : "Mensagens que ficaram na fila do ICOM sao entregues agora; as que ja expiraram chegam como RJCT AB03.");
  }

  private async handle(m: ReceivedMessage): Promise<void> {
    const type = typeOf(m.xml);
    const doc = parseXml(m.xml).Envelope?.Document ?? {};
    if (type === "pacs.008") return this.onIncomingPix(m, doc);
    if (type === "pacs.004") return this.onIncomingReturn(m, doc);
    if (type === "pacs.002") return this.onStatus(doc);
    if (type === "admi.002") return this.onAdmi(doc);
  }

  private async answer(j: string, e2e: string, instrId: string, status: "ACSP" | "RJCT", code?: string, startedAt = Date.now()): Promise<void> {
    const xml = generatePacs002({ senderIspb: this.opts.ispb, originalEndToEndId: e2e, originalInstructionId: instrId, status, rejectReasonCode: code });
    await this.icom.sendMessages(xml);
    const ms = Date.now() - startedAt;
    this.log.step(j, status === "ACSP" ? "send" : "warn", `pacs.002 ${status}${code ? ` ${code}` : ""} enviada ao SPI em ${ms} ms`,
      status === "ACSP"
        ? "ACSP = aceito, liquidacao em processo. O Bacen mede esse tempo: meta de 1,4 s (p50) e 2,3 s (p95)."
        : `O SPI repassa a rejeicao ao banco pagador, que devolve o dinheiro ao cliente (${REASONS[code ?? ""] ?? code}).`);
  }

  private async onIncomingPix(m: ReceivedMessage, doc: Record<string, any>): Promise<void> {
    const t0 = Date.now();
    const tx = doc.FIToFICstmrCdtTrf.CdtTrfTxInf;
    const e2e = pickText(tx, "PmtId.EndToEndId")!;
    if (this.txs.has(e2e)) return; // entrega duplicada (mesmo ResourceId)
    const amountCents = Math.round(Number(pickText(tx, "IntrBkSttlmAmt")) * 100);
    const payerName = pickText(tx, "Dbtr.Nm") ?? "?";
    const payerBank = pickText(tx, "DbtrAgt.FinInstnId.ClrSysMmbId.MmbId")!;
    const account = pickText(tx, "CdtrAcct.Id.Othr.Id");
    const branch = pickText(tx, "CdtrAcct.Id.Othr.Issr");
    const doc_ = pickText(tx, "Cdtr.Id.PrvtId.Othr.Id");

    const j = this.log.start(`Pix recebido: ${brl(amountCents)} de ${payerName} (banco ${payerBank})`);
    this.log.step(j, "receive", `ICOM stream: pacs.008 do SPI, PI-ResourceId ${m.resourceId}`,
      "O SPI reembala a ordem com o cabecalho dele (Fr=00038166) e entrega pelo stream de leitura.");

    const customer = [...this.customers.values()].find((c) => c.account === account && (!branch || Number(c.branch) === Number(branch)));
    let code: string | undefined;
    if (!customer) code = "AC03";
    else if (customer.taxId !== doc_) code = "BE01";

    this.record({ id: e2e, endToEndId: e2e, kind: "pix-in", customerId: customer?.id ?? "?", counterparty: `${payerName} (${payerBank})`, amountCents, status: code ? "REJEITADO" : "PENDENTE", reason: code, journeyId: j, description: pickText(tx, "RmtInf.Ustrd") });
    if (code) {
      this.log.step(j, "warn", `Conta ${branch ?? "-"}/${account} ${code === "AC03" ? "nao existe neste banco" : "nao pertence ao documento informado"}: rejeitar com ${code}`);
      await this.answer(j, e2e, e2e, "RJCT", code, t0);
      return;
    }
    this.log.step(j, "ok", `Conta encontrada: ${customer!.name}, documento confere`,
      "O banco recebedor valida conta, titularidade e regras (limites, fraude) antes de aceitar.");
    await this.answer(j, e2e, e2e, "ACSP", undefined, t0);
    this.log.step(j, "info", "Credito so apos a confirmacao do SPI (ACCC)",
      "Se o SPI nao conseguir liquidar (ex.: AB03, AM04), o dinheiro nao existe: por isso o credito espera a liquidacao.");
  }

  private async onIncomingReturn(m: ReceivedMessage, doc: Record<string, any>): Promise<void> {
    const t0 = Date.now();
    const tx = doc.PmtRtr.TxInf;
    const rtrId = pickText(tx, "RtrId")!;
    const e2e = pickText(tx, "OrgnlEndToEndId")!;
    if (this.txs.has(rtrId)) return;
    const amountCents = Math.round(Number(pickText(tx, "RtrdIntrBkSttlmAmt")) * 100);
    const original = this.txs.get(e2e);
    const j = original?.journeyId ?? this.log.start(`Devolucao recebida ${rtrId}`);
    this.log.step(j, "receive", `ICOM stream: pacs.004 (devolucao ${rtrId}) de ${brl(amountCents)}, motivo ${pickText(tx, "RtrRsnInf.Rsn.Cd")}`,
      "O recebedor do Pix esta devolvendo o dinheiro. Este banco precisa aceitar (pacs.002) como em um Pix comum.");

    let code: string | undefined;
    if (!original || original.kind !== "pix-out") code = "AC03";
    else if (amountCents > original.amountCents - original.returnedCents) code = "AM09";
    this.record({ id: rtrId, endToEndId: e2e, kind: "return-in", customerId: original?.customerId ?? "?", counterparty: original?.counterparty ?? "?", amountCents, status: code ? "REJEITADO" : "PENDENTE", reason: code, journeyId: j });
    await this.answer(j, e2e, rtrId, code ? "RJCT" : "ACSP", code, t0);
  }

  private onStatus(doc: Record<string, any>): void {
    const s = doc.FIToFIPmtStsRpt.TxInfAndSts;
    const id = pickText(s, "OrgnlInstrId")!;
    const status = pickText(s, "TxSts")!;
    const code = pickText(s, "StsRsnInf.Rsn.Cd");
    const tx = this.txs.get(id);
    if (!tx || tx.status !== "PENDENTE") return;
    const c = this.customers.get(tx.customerId);
    const j = tx.journeyId;
    const ms = Date.now() - tx.startedAt;
    this.log.step(j, "receive", `ICOM stream: pacs.002 ${status}${code ? ` ${code}` : ""} do SPI`);

    const outgoing = tx.kind === "pix-out" || tx.kind === "return-out";
    if (status === "ACSC" && outgoing) {
      tx.status = "CONCLUIDO";
      if (tx.kind === "return-out") {
        const original = this.txs.get(tx.endToEndId);
        if (original) original.returnedCents += tx.amountCents;
      }
      this.log.step(j, "ok", `Liquidado no SPI: conta PI do banco debitada. Concluido em ${ms} ms`,
        "ACSC e o aviso ao banco pagador; o recebedor ganha um ACCC. A liquidacao e bruta e em tempo real, nas contas PI do Bacen.");
    } else if (status === "ACCC" && !outgoing) {
      tx.status = "CONCLUIDO";
      if (c) c.balanceCents += tx.amountCents;
      if (tx.kind === "return-in") {
        const original = this.txs.get(tx.endToEndId);
        if (original) original.returnedCents += tx.amountCents;
      }
      this.log.step(j, "ok", `SPI liquidou: ${c?.name ?? "?"} +${brl(tx.amountCents)} (saldo ${brl(c?.balanceCents ?? 0)})`,
        "Com o ACCC o dinheiro ja esta na conta PI do banco, e o credito ao cliente e imediato.");
    } else if (status === "RJCT") {
      tx.status = "REJEITADO";
      tx.reason = code;
      if (outgoing && c) c.balanceCents += tx.amountCents;
      this.log.step(j, "error", `Rejeitado: ${code} - ${REASONS[code ?? ""] ?? "ver catalogo"}${outgoing ? `; ${brl(tx.amountCents)} devolvido ao cliente` : ""}`);
    }
  }

  private onAdmi(doc: Record<string, any>): void {
    const a = doc["admi.002.001.01"];
    const ref = pickText(a, "RltdRef.Ref");
    const reason = `${pickText(a, "Rsn.RjctgPtyRsn")}: ${pickText(a, "Rsn.RsnDesc") ?? ""}`;
    const tx = [...this.txs.values()].find((t) => t.resourceId === ref);
    const j = tx?.journeyId ?? this.log.start("admi.002 recebida");
    this.log.step(j, "error", `admi.002: o SPI nao processou a mensagem ${ref} (${reason})`,
      "admi.002 = erro de formato/schema/cabecalho. O ICOM aceitou (201) mas o SPI recusou depois.");
    if (tx && tx.status === "PENDENTE") {
      tx.status = "REJEITADO";
      tx.reason = "admi.002";
      const c = this.customers.get(tx.customerId);
      if (c) c.balanceCents += tx.amountCents;
    }
  }

  private describe(err: unknown): string {
    if (err instanceof HttpError) {
      const p = parseProblem(err.body);
      return `${err.statusCode} ${p?.type?.split("/").pop() ?? ""}${p?.detail ? ` (${p.detail})` : ""}`.trim();
    }
    return (err as Error).message;
  }

  snapshot() {
    return {
      bank: { ispb: this.opts.ispb, name: this.opts.name, label: this.opts.label, offline: this.offline },
      customers: [...this.customers.values()].map((c) => ({ ...c, balance: c.balanceCents / 100 })),
      transactions: [...this.txs.values()].reverse().map((t) => ({ ...t, amount: t.amountCents / 100, returned: t.returnedCents / 100 })),
    };
  }
}
