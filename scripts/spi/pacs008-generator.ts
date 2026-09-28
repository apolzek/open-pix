/**
 * pacs.008 (FIToFICustomerCreditTransfer) XML Generator.
 *
 * Generates the payment order used for every Pix, following the SPI catalog
 * 5.13 (pacs.008.spi.1.16). The output validates against Bacen's official XSD
 * (see simulator/spec/spi-5.13.1).
 *
 * Main rules from the catalog, enforced here:
 * - AppHdr goes from the payer's PSP to the SPI (00038166). The receiving PSP
 *   is identified only by CdtrAgt.
 * - AccptncDtTm (t0') is when the payer's PSP accepted the order. The 40s
 *   settlement limit (Manual de Tempos) counts from it.
 * - InstrPrty HIGH requires SvcLvl PAGPRI; NORM requires PAGAGD or PAGFRD.
 * - LclInstrm MANU/AUTO must not carry Prxy; DICT, QRDN, QRES, APDN, APES and
 *   INIC must carry the Pix key in CdtrAcct/Prxy.
 * - The creditor has no name in the message, only CPF/CNPJ and account.
 *
 * PITFALL: Bacen rejects versions that are not enabled in the ICOM catalog
 * ("Schema desconhecido ou nao habilitado para uso"). Check
 * GET /api/v1/in/catalog instead of guessing the next version.
 */

import { generateEndToEndId, END_TO_END_ID_PATTERN } from "../utils/endtoendid-generator.js";
import { generateBizMsgIdr } from "../utils/biz-message-id-generator.js";
import {
  SPI_ISPB,
  agentXml,
  buildEnvelope,
  escapeXml,
  formatAmount,
  indent,
  isoUtc,
} from "./spi-envelope.js";

export type AccountType = "CACC" | "SVGS" | "TRAN" | "SLRY" | "OTHR";
export type LocalInstrument = "MANU" | "DICT" | "QRDN" | "QRES" | "INIC" | "AUTO" | "APDN" | "APES";
export type Purpose = "IPAY" | "GSCB" | "OTHR" | "REFU" | "IPRT";
export type ServiceLevel = "PAGPRI" | "PAGAGD" | "PAGFRD";

export interface Pacs008Party {
  /** Required for the debtor. The pacs.008 carries no creditor name. */
  name?: string;
  /** CPF (11 digits) or CNPJ (14 chars, alphanumeric CNPJ accepted). */
  document: string;
  documentType?: "CPF" | "CNPJ";
  /** Branch without check digit, up to 4 digits. Omit for accounts without branch. */
  branch?: string;
  /** Up to 20 chars [0-9A-Z]. */
  accountNumber: string;
  accountType: AccountType;
}

export interface Pacs008Params {
  /** ISPB of the payer's PSP (DbtrAgt and AppHdr/Fr). */
  senderIspb: string;
  /** ISPB of the receiver's PSP (CdtrAgt). */
  receiverIspb: string;
  amount: number;
  endToEndId?: string;
  bizMsgIdr?: string;
  /** When the payer's PSP accepted the order (AccptncDtTm). Defaults to now. */
  acceptedAt?: Date;
  priority?: "HIGH" | "NORM";
  serviceLevel?: ServiceLevel;
  localInstrument?: LocalInstrument;
  /** Pix key of the receiver, required for key and QR code based payments. */
  proxy?: string;
  /** idConciliacaoRecebedor, from QR codes and payment initiation. */
  txId?: string;
  purpose?: Purpose;
  /** CNPJ of the payment initiation service provider (InitgPty). */
  initiatingPartyCnpj?: string;
  debitParty: Pacs008Party;
  creditParty: Pacs008Party;
  /** Free text between users (RmtInf/Ustrd), up to 140 chars. */
  description?: string;
}

const DOCUMENT_PATTERN = /^(\d{11}|[0-9A-Z]{12}\d{2})$/;
const ACCOUNT_PATTERN = /^[0-9A-Z]{1,20}$/;
const BRANCH_PATTERN = /^\d{1,4}$/;
const PROXY_REQUIRED: LocalInstrument[] = ["DICT", "QRDN", "QRES", "APDN", "APES", "INIC"];

function checkParty(role: string, party: Pacs008Party, needsName: boolean): void {
  if (needsName && (!party.name || party.name.length > 140)) {
    throw new Error(`${role}: name is required, up to 140 chars`);
  }
  if (!DOCUMENT_PATTERN.test(party.document)) {
    throw new Error(`${role}: document must be a CPF (11 digits) or CNPJ (14 chars), got "${party.document}"`);
  }
  if (!ACCOUNT_PATTERN.test(party.accountNumber)) {
    throw new Error(`${role}: account must match [0-9A-Z]{1,20}, got "${party.accountNumber}"`);
  }
  if (party.branch !== undefined && !BRANCH_PATTERN.test(party.branch)) {
    throw new Error(`${role}: branch must have up to 4 digits, got "${party.branch}"`);
  }
}

export function validatePacs008Params(params: Pacs008Params): void {
  const priority = params.priority ?? "HIGH";
  const serviceLevel = params.serviceLevel ?? (priority === "HIGH" ? "PAGPRI" : "PAGAGD");
  if (priority === "HIGH" && serviceLevel !== "PAGPRI") {
    throw new Error("InstrPrty HIGH requires SvcLvl PAGPRI");
  }
  if (priority === "NORM" && serviceLevel === "PAGPRI") {
    throw new Error("InstrPrty NORM requires SvcLvl PAGAGD or PAGFRD");
  }

  const instrument = params.localInstrument ?? "MANU";
  if ((instrument === "MANU" || instrument === "AUTO") && params.proxy) {
    throw new Error(`LclInstrm ${instrument} must not carry Prxy`);
  }
  if (PROXY_REQUIRED.includes(instrument) && !params.proxy) {
    throw new Error(`LclInstrm ${instrument} requires the Pix key in proxy`);
  }
  if (params.proxy && params.proxy.length > 77) {
    throw new Error("Prxy/Id must have up to 77 chars");
  }
  if (params.txId !== undefined && !/^[a-zA-Z0-9]{1,35}$/.test(params.txId)) {
    throw new Error("TxId must match [a-zA-Z0-9]{1,35}");
  }
  if (params.endToEndId && !END_TO_END_ID_PATTERN.test(params.endToEndId)) {
    throw new Error(`Invalid EndToEndId: ${params.endToEndId}`);
  }
  if (params.description !== undefined && (params.description.length < 1 || params.description.length > 140)) {
    throw new Error("RmtInf/Ustrd must have 1 to 140 chars");
  }
  if (params.creditParty.accountType === "SLRY") {
    throw new Error("SLRY is not accepted as creditor account type (reserved for STN)");
  }

  checkParty("debitParty", params.debitParty, true);
  checkParty("creditParty", params.creditParty, false);
}

function accountXml(tag: "DbtrAcct" | "CdtrAcct", party: Pacs008Party, proxy?: string): string {
  const issuer = party.branch !== undefined ? `\n            <Issr>${party.branch}</Issr>` : "";
  const prxy = proxy ? `\n    <Prxy>\n        <Id>${escapeXml(proxy)}</Id>\n    </Prxy>` : "";
  return `<${tag}>
    <Id>
        <Othr>
            <Id>${party.accountNumber}</Id>${issuer}
        </Othr>
    </Id>
    <Tp>
        <Cd>${party.accountType}</Cd>
    </Tp>${prxy}
</${tag}>`;
}

function personIdXml(document: string): string {
  return `<Id>
    <PrvtId>
        <Othr>
            <Id>${document}</Id>
        </Othr>
    </PrvtId>
</Id>`;
}

export function generatePacs008(params: Pacs008Params): string {
  validatePacs008Params(params);

  const priority = params.priority ?? "HIGH";
  const serviceLevel = params.serviceLevel ?? (priority === "HIGH" ? "PAGPRI" : "PAGAGD");
  const localInstrument = params.localInstrument ?? "MANU";
  const endToEndId = params.endToEndId || generateEndToEndId(params.senderIspb);
  const bizMsgIdr = params.bizMsgIdr || generateBizMsgIdr(params.senderIspb);
  const createdAt = isoUtc();
  const acceptedAt = isoUtc(params.acceptedAt ?? new Date());

  const txId = params.txId ? `\n            <TxId>${params.txId}</TxId>` : "";
  const initiatingParty = params.initiatingPartyCnpj
    ? `
    <InitgPty>
        <Id>
            <OrgId>
                <Othr>
                    <Id>${params.initiatingPartyCnpj}</Id>
                </Othr>
            </OrgId>
        </Id>
    </InitgPty>`
    : "";
  const remittance = params.description
    ? `
    <RmtInf>
        <Ustrd>${escapeXml(params.description)}</Ustrd>
    </RmtInf>`
    : "";

  const document = `<FIToFICstmrCdtTrf>
    <GrpHdr>
        <MsgId>${bizMsgIdr}</MsgId>
        <CreDtTm>${createdAt}</CreDtTm>
        <NbOfTxs>1</NbOfTxs>
        <SttlmInf>
            <SttlmMtd>CLRG</SttlmMtd>
        </SttlmInf>
        <PmtTpInf>
            <InstrPrty>${priority}</InstrPrty>
            <SvcLvl>
                <Prtry>${serviceLevel}</Prtry>
            </SvcLvl>
        </PmtTpInf>
    </GrpHdr>
    <CdtTrfTxInf>
        <PmtId>
            <EndToEndId>${endToEndId}</EndToEndId>${txId}
        </PmtId>
        <IntrBkSttlmAmt Ccy="BRL">${formatAmount(params.amount)}</IntrBkSttlmAmt>
        <AccptncDtTm>${acceptedAt}</AccptncDtTm>
        <ChrgBr>SLEV</ChrgBr>
        <MndtRltdInf>
            <Tp>
                <LclInstrm>
                    <Prtry>${localInstrument}</Prtry>
                </LclInstrm>
            </Tp>
        </MndtRltdInf>${indent(initiatingParty, 4)}
        <Dbtr>
            <Nm>${escapeXml(params.debitParty.name!)}</Nm>
${indent(personIdXml(params.debitParty.document), 12)}
        </Dbtr>
${indent(accountXml("DbtrAcct", params.debitParty), 8)}
${indent(agentXml("DbtrAgt", params.senderIspb), 8)}
${indent(agentXml("CdtrAgt", params.receiverIspb), 8)}
        <Cdtr>
${indent(personIdXml(params.creditParty.document), 12)}
        </Cdtr>
${indent(accountXml("CdtrAcct", params.creditParty, params.proxy), 8)}
        <Purp>
            <Cd>${params.purpose ?? "IPAY"}</Cd>
        </Purp>${indent(remittance, 4)}
    </CdtTrfTxInf>
</FIToFICstmrCdtTrf>`;

  return buildEnvelope({
    type: "pacs.008",
    from: params.senderIspb,
    to: SPI_ISPB,
    bizMsgIdr,
    createdAt,
    document,
  });
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const senderIspb = process.argv[2] || "12345678";
  // 99999A04 is Bacen's virtual credit union in homologation; it answers any
  // pacs.008 with an ACSP pacs.002.
  const receiverIspb = process.argv[3] || "99999A04";

  const xml = generatePacs008({
    senderIspb,
    receiverIspb,
    amount: 1.5,
    localInstrument: "MANU",
    debitParty: {
      name: "Fulano da Silva",
      document: "12345678901",
      documentType: "CPF",
      branch: "0001",
      accountNumber: "123456",
      accountType: "CACC",
    },
    creditParty: {
      document: "98765432100",
      documentType: "CPF",
      branch: "0001",
      accountNumber: "654321",
      accountType: "CACC",
    },
    description: "Test payment",
  });

  console.log(xml);
}
