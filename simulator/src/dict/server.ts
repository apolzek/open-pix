/**
 * DICT simulado: subconjunto da API DICT v2.12.1 (base /api/v2).
 *
 *   POST /entries/              createEntry  (CreateEntryRequest)
 *   GET  /entries/{Key}         getEntry     (PI-RequestingParticipant, PI-PayerId, PI-EndToEndId)
 *   POST /entries/{Key}/delete  deleteEntry  (DeleteEntryRequest)
 *   GET  /policies/{policy}     getPolicy    (estado do balde)
 *
 * Regras reproduzidas:
 * - antiscan por usuario (PF 2/min balde 100, PJ 20/min balde 1000) e por
 *   participante (categoria A..H): 200 custa 1 ficha, 404 custa 20 (usuario)
 *   ou 3 (participante); sem ficha, 429 RateLimited. Um Pix liquidado depois
 *   da consulta devolve fichas (PF +1, PJ +2, participante +1);
 * - consulta de chave do proprio PSP e recusada (transferencia interna nao
 *   passa pelo DICT nem pelo SPI);
 * - conflitos de chave: EntryAlreadyExists, EntryKeyOwnedByDifferentPerson,
 *   EntryKeyInCustodyOfDifferentParticipant; chave EVP gerada pelo DICT;
 * - RequestId idempotente: repetir com os mesmos dados devolve o mesmo
 *   resultado, com dados diferentes da RequestIdAlreadyUsed;
 * - erros em RFC 7807 (application/problem+xml).
 *
 * A assinatura XMLDSig ainda nao e verificada (SIM_VERIFY_SIGNATURE).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import crypto from "node:crypto";

import { RateLimiter, antiscanCost, policyCost, paymentSentCredit, userAntiscanPolicy, POLICIES } from "../core/bucket.js";
import { DictProblem } from "../core/problem.js";
import { correlationId } from "../core/ids.js";
import { parseXml, pickText } from "../core/xml.js";
import { escapeXml } from "../core/problem.js";
import type { Timeline } from "../core/events.js";
import type { Participants } from "../spi/participants.js";
import { KEY_PATTERNS, detectKeyType, type KeyType } from "../../../scripts/dict/key-lookup.js";

export interface Entry {
  key: string;
  keyType: KeyType;
  account: { participant: string; branch?: string; accountNumber: string; accountType: string; openingDate: string };
  owner: { type: string; taxIdNumber: string; name: string; tradeName?: string };
  creationDate: string;
  keyOwnershipDate: string;
}

interface Lookup {
  userPolicy: string;
  userOwner: string;
  participant: string;
}

export interface DictContext {
  participants: Participants;
  limiter: RateLimiter;
  timeline: Timeline;
  verifySignature: boolean;
  tls: boolean;
}

export class DictStore {
  readonly entries = new Map<string, Entry>();
  private requests = new Map<string, { fingerprint: string; key: string }>();
  /** Consultas por EndToEndId, para devolver fichas quando o Pix liquidar. */
  private lookups = new Map<string, Lookup>();

  constructor(private ctx: DictContext) {}

  /** Chamado pelo SPI quando um pagamento liquida. */
  paymentSettled(endToEndId: string): void {
    const lookup = this.lookups.get(endToEndId);
    if (!lookup) return;
    this.lookups.delete(endToEndId);
    const user = paymentSentCredit(lookup.userPolicy, lookup.userOwner);
    const psp = paymentSentCredit("ENTRIES_READ_PARTICIPANT_ANTISCAN", lookup.participant);
    this.ctx.limiter.credit(lookup.userPolicy, lookup.userOwner, user);
    this.ctx.limiter.credit("ENTRIES_READ_PARTICIPANT_ANTISCAN", lookup.participant, psp);
    this.ctx.timeline.record("DICT", `Pix liquidado apos consulta: devolvidas ${user} ficha(s) ao pagador e ${psp} ao PSP`, {
      ispb: lookup.participant,
      txId: endToEndId,
    });
  }

  handler() {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        await this.handle(req, res);
      } catch (err) {
        const p = err instanceof DictProblem ? err : new DictProblem("InternalServerError", (err as Error).message);
        this.ctx.timeline.record("DICT", `Erro ${p.status} ${p.type}${p.detail ? `: ${p.detail}` : ""}`);
        res.writeHead(p.status, { "Content-Type": "application/problem+xml; charset=utf-8" });
        res.end(p.toXml());
      }
    };
  }

  private requester(req: IncomingMessage): string {
    const cn = this.ctx.tls ? (req.socket as TLSSocket).getPeerCertificate?.()?.subject?.CN : undefined;
    const header = req.headers["pi-requestingparticipant"];
    const ispb = typeof cn === "string" && /^[0-9A-Z]{8}$/.test(cn) ? cn : typeof header === "string" ? header : undefined;
    if (!ispb || !this.ctx.participants.get(ispb)) throw new DictProblem("Forbidden", `Participante ${ispb ?? "?"} nao habilitado no DICT`);
    if (typeof header === "string" && header !== ispb) throw new DictProblem("Forbidden", "PI-RequestingParticipant diferente do certificado");
    return ispb;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://dict");
    const path = url.pathname;
    if (!path.startsWith("/api/v2/")) throw new DictProblem("NotFound", "Use a API v2 em /api/v2/");
    const route = path.slice("/api/v2".length);
    const ispb = this.requester(req);

    if (req.method === "POST" && route === "/entries/") return this.create(ispb, await body(req), res);

    let m = /^\/entries\/([^/]+)\/delete$/.exec(route);
    if (req.method === "POST" && m) return this.remove(ispb, decodeURIComponent(m[1]), await body(req), res);

    m = /^\/entries\/([^/]+)$/.exec(route);
    if (req.method === "GET" && m) return this.get(ispb, decodeURIComponent(m[1]), req, res);

    m = /^\/policies\/([A-Z_]+)$/.exec(route);
    if (req.method === "GET" && m) return this.policy(ispb, m[1], res);

    throw new DictProblem("NotFound", `Operacao nao suportada pelo simulador: ${req.method} ${route}`);
  }

  private write(res: ServerResponse, status: number, root: string, inner: string): void {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<${root}>
    <Signature></Signature>
    <ResponseTime>${new Date().toISOString()}</ResponseTime>
    <CorrelationId>${correlationId()}</CorrelationId>
${inner}
</${root}>
`;
    res.writeHead(status, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(xml);
  }

  private checkSignature(doc: Record<string, any>, root: string): void {
    const sig = doc[root]?.Signature;
    if (this.ctx.verifySignature && (!sig || (typeof sig === "string" && sig.trim() === ""))) {
      throw new DictProblem("RequestSignatureInvalid", "Requisicao de escrita sem assinatura XMLDSig");
    }
  }

  private charge(policy: string, owner: string, cost: number): void {
    if (!this.ctx.limiter.allows(policy, owner)) throw new DictProblem("RateLimited", `Balde ${policy} vazio`);
    this.ctx.limiter.charge(policy, owner, cost);
  }

  private create(ispb: string, xml: string, res: ServerResponse): void {
    const doc = parseXml(xml);
    if (!doc.CreateEntryRequest) throw new DictProblem("BadRequest", "Esperado CreateEntryRequest");
    this.checkSignature(doc, "CreateEntryRequest");
    const r = doc.CreateEntryRequest;
    const e = r.Entry ?? {};
    const keyType = pickText(e, "KeyType") as KeyType;
    const requestId = pickText(r, "RequestId") ?? "";
    const account = {
      participant: pickText(e, "Account.Participant") ?? "",
      branch: pickText(e, "Account.Branch"),
      accountNumber: pickText(e, "Account.AccountNumber") ?? "",
      accountType: pickText(e, "Account.AccountType") ?? "",
      openingDate: pickText(e, "Account.OpeningDate") ?? "",
    };
    const owner = {
      type: pickText(e, "Owner.Type") ?? "",
      taxIdNumber: pickText(e, "Owner.TaxIdNumber") ?? "",
      name: pickText(e, "Owner.Name") ?? "",
      tradeName: pickText(e, "Owner.TradeName"),
    };

    this.charge("ENTRIES_WRITE", ispb, 1);

    if (account.participant !== ispb) throw new DictProblem("Forbidden", "Account.Participant deve ser o proprio requisitante");
    if (!KEY_PATTERNS[keyType]) throw new DictProblem("EntryInvalid", `KeyType invalido: ${keyType}`);
    let key = pickText(e, "Key");
    if (keyType === "EVP") {
      if (key) throw new DictProblem("EntryInvalid", "Chave EVP e gerada pelo DICT: nao envie Key");
      key = crypto.randomUUID();
    } else if (!key || !KEY_PATTERNS[keyType].test(key)) {
      throw new DictProblem("EntryInvalid", `Key nao corresponde ao formato de ${keyType}`);
    }
    if ((keyType === "CPF" || keyType === "CNPJ") && key !== owner.taxIdNumber) {
      throw new DictProblem("EntryInvalid", `Chave ${keyType} deve ser o documento do dono`);
    }

    const fingerprint = JSON.stringify([keyType, keyType === "EVP" ? "" : key, account, owner]);
    const previous = this.requests.get(`${ispb}:${requestId}`);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new DictProblem("RequestIdAlreadyUsed");
      const entry = this.entries.get(previous.key)!;
      return this.write(res, 201, "CreateEntryResponse", entryXml(entry));
    }

    const existing = this.entries.get(key);
    if (existing) {
      if (existing.owner.taxIdNumber !== owner.taxIdNumber) throw new DictProblem("EntryKeyOwnedByDifferentPerson");
      if (existing.account.participant !== ispb) throw new DictProblem("EntryKeyInCustodyOfDifferentParticipant");
      throw new DictProblem("EntryAlreadyExists");
    }

    const now = new Date().toISOString();
    const entry: Entry = { key, keyType, account, owner, creationDate: now, keyOwnershipDate: now };
    this.entries.set(key, entry);
    this.requests.set(`${ispb}:${requestId}`, { fingerprint, key });
    this.ctx.timeline.record("DICT", `Chave ${keyType} ${mask(key, keyType)} registrada para ${owner.name} em ${ispb}`, { ispb });
    this.write(res, 201, "CreateEntryResponse", entryXml(entry));
  }

  private remove(ispb: string, key: string, xml: string, res: ServerResponse): void {
    const doc = parseXml(xml);
    if (!doc.DeleteEntryRequest) throw new DictProblem("BadRequest", "Esperado DeleteEntryRequest");
    this.checkSignature(doc, "DeleteEntryRequest");
    this.charge("ENTRIES_WRITE", ispb, 1);
    const entry = this.entries.get(key);
    if (!entry) throw new DictProblem("NotFound", "Entry associated with given key does not exist");
    if (entry.account.participant !== ispb) throw new DictProblem("Forbidden", "Somente o participante que custodia a chave pode exclui-la");
    this.entries.delete(key);
    this.ctx.timeline.record("DICT", `Chave ${mask(key, entry.keyType)} excluida por ${ispb}`, { ispb });
    this.write(res, 200, "DeleteEntryResponse", `    <Key>${escapeXml(key)}</Key>`);
  }

  private get(ispb: string, key: string, req: IncomingMessage, res: ServerResponse): void {
    const payerId = String(req.headers["pi-payerid"] ?? "");
    const e2e = String(req.headers["pi-endtoendid"] ?? "");
    if (!/^(\d{11}|\d{14})$/.test(payerId)) throw new DictProblem("BadRequest", "PI-PayerId obrigatorio (CPF ou CNPJ)");
    if (!e2e) throw new DictProblem("BadRequest", "PI-EndToEndId obrigatorio");
    const keyType = detectKeyType(key);
    if (!keyType) throw new DictProblem("BadRequest", "Chave em formato desconhecido");

    const userPolicy = userAntiscanPolicy(keyType);
    const userOwner = `${payerId.length === 11 ? "PF" : "PJ"}:${payerId}`;
    const limiter = this.ctx.limiter;
    if (!limiter.allows(userPolicy, userOwner) || !limiter.allows("ENTRIES_READ_PARTICIPANT_ANTISCAN", ispb)) {
      this.ctx.timeline.record("DICT", `Consulta barrada pelo antiscan (${userPolicy} ou PARTICIPANT): 429`, { ispb, txId: e2e });
      throw new DictProblem("RateLimited", "Balde de antiscan vazio");
    }

    const entry = this.entries.get(key);
    const status = entry ? 200 : 404;
    if (entry && entry.account.participant === ispb) {
      throw new DictProblem("EntryCannotBeQueriedForBookTransfer", "Pagador e recebedor no mesmo PSP: faca a transferencia interna");
    }
    limiter.charge(userPolicy, userOwner, antiscanCost(status, "USER"));
    limiter.charge("ENTRIES_READ_PARTICIPANT_ANTISCAN", ispb, antiscanCost(status, "PSP"));
    const left = limiter.list(userOwner).find((b) => b.policy === userPolicy)?.tokens;

    if (!entry) {
      this.ctx.timeline.record("DICT", `Consulta de ${mask(key, keyType)} por ${ispb}: 404 (custou ${antiscanCost(404, "USER")} fichas ao pagador, restam ${left})`, { ispb, txId: e2e });
      throw new DictProblem("NotFound", "Entry associated with given key does not exist");
    }
    this.lookups.set(e2e, { userPolicy, userOwner, participant: ispb });
    this.ctx.timeline.record("DICT", `Consulta de ${mask(key, keyType)} por ${ispb}: 200, conta em ${entry.account.participant} (fichas do pagador: ${left})`, {
      ispb,
      txId: e2e,
    });
    this.write(res, 200, "GetEntryResponse", entryXml(entry));
  }

  private policy(ispb: string, name: string, res: ServerResponse): void {
    if (!POLICIES[name]) throw new DictProblem("NotFound", `Politica ${name} inexistente`);
    this.charge("POLICIES_READ", ispb, policyCost(200));
    const b = this.ctx.limiter.list(ispb).find((x) => x.policy === name);
    const def = POLICIES[name];
    this.write(res, 200, "GetPolicyResponse", `    <Category>${this.ctx.limiter.category}</Category>
    <Policy>
        <AvailableTokens>${b?.tokens ?? def.size}</AvailableTokens>
        <Capacity>${b?.size ?? def.size}</Capacity>
        <RefillTokens>${b?.refillPerMin ?? def.refillPerMin}</RefillTokens>
        <RefillPeriodSec>60</RefillPeriodSec>
        <Name>${name}</Name>
    </Policy>`);
  }

  reset(): void {
    this.entries.clear();
    this.requests.clear();
    this.lookups.clear();
  }
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.headers["content-encoding"]) {
        reject(new DictProblem("BadRequest", "O DICT nao aceita corpo de requisicao compactado"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function entryXml(e: Entry): string {
  const opt = (tag: string, v?: string) => (v ? `\n            <${tag}>${escapeXml(v)}</${tag}>` : "");
  return `    <Entry>
        <Key>${escapeXml(e.key)}</Key>
        <KeyType>${e.keyType}</KeyType>
        <Account>
            <Participant>${e.account.participant}</Participant>${opt("Branch", e.account.branch)}
            <AccountNumber>${escapeXml(e.account.accountNumber)}</AccountNumber>
            <AccountType>${e.account.accountType}</AccountType>
            <OpeningDate>${e.account.openingDate}</OpeningDate>
        </Account>
        <Owner>
            <Type>${e.owner.type}</Type>
            <TaxIdNumber>${e.owner.taxIdNumber}</TaxIdNumber>
            <Name>${escapeXml(e.owner.name)}</Name>${opt("TradeName", e.owner.tradeName)}
        </Owner>
        <CreationDate>${e.creationDate}</CreationDate>
        <KeyOwnershipDate>${e.keyOwnershipDate}</KeyOwnershipDate>
    </Entry>`;
}

/** Mascara a chave no log, como um app faria ao exibir dados de terceiros. */
export function mask(key: string, type?: string): string {
  if (type === "CPF") return `***.${key.slice(3, 6)}.${key.slice(6, 9)}-**`;
  if (type === "EMAIL") return key.replace(/^(.).*(@.*)$/, "$1***$2");
  if (type === "PHONE") return `${key.slice(0, 5)}*****${key.slice(-4)}`;
  return key.length > 12 ? `${key.slice(0, 8)}...` : key;
}
