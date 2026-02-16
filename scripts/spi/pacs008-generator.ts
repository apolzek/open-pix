/**
 * pacs.008 (FIToFICustomerCreditTransfer) XML Generator.
 *
 * Generates the payment initiation message used for all Pix payments.
 * Supports multiple ISO 20022 schema versions:
 * - 1.11 (legacy)
 * - 1.12 (transitional)
 * - 1.13 (current as of 2025)
 *
 * PITFALL: Bacen may silently change the required version without updating
 * the catalog. If you get "Schema desconhecido ou nao habilitado para uso",
 * try the next version up.
 *
 * The XML is wrapped in a BusinessApplicationHeader (BAH) envelope.
 */

import { generateEndToEndId } from "../utils/endtoendid-generator.js";
import { generateBizMsgIdr } from "../utils/biz-message-id-generator.js";

export type PacsVersion = "1.11" | "1.12" | "1.13";

export interface Pacs008Params {
  senderIspb: string;
  receiverIspb: string;
  amount: number;
  endToEndId?: string;
  bizMsgIdr?: string;
  version?: PacsVersion;
  debitParty: {
    name: string;
    document: string;
    documentType: "CPF" | "CNPJ";
    branch: string;
    accountNumber: string;
    accountType: "CACC" | "SVGS";
  };
  creditParty: {
    name: string;
    document: string;
    documentType: "CPF" | "CNPJ";
    branch: string;
    accountNumber: string;
    accountType: "CACC" | "SVGS";
  };
  purpose?: string;
  description?: string;
  localInstrument?: "MANU" | "DICT" | "QRDN" | "QRES" | "INIC";
}

function getNamespace(version: PacsVersion): string {
  const map: Record<PacsVersion, string> = {
    "1.11": "urn:iso:std:iso:20022:tech:xsd:pacs.008.001.11.spi.1.11",
    "1.12": "urn:iso:std:iso:20022:tech:xsd:pacs.008.001.11.spi.1.12",
    "1.13": "urn:iso:std:iso:20022:tech:xsd:pacs.008.001.11.spi.1.13",
  };
  return map[version];
}

function getMsgDefIdr(version: PacsVersion): string {
  return `pacs.008.spi.${version}`;
}

function isoDateTime(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function isoDate(): string {
  return new Date().toISOString().split("T")[0];
}

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

function documentTag(docType: "CPF" | "CNPJ"): string {
  return docType === "CPF" ? "Othr" : "Othr";
}

export function generatePacs008(params: Pacs008Params): string {
  const version = params.version || "1.13";
  const namespace = getNamespace(version);
  const msgDefIdr = getMsgDefIdr(version);
  const endToEndId = params.endToEndId || generateEndToEndId(params.senderIspb);
  const bizMsgIdr = params.bizMsgIdr || generateBizMsgIdr(params.senderIspb);
  const creationDateTime = isoDateTime();
  const settlementDate = isoDate();
  const localInstrument = params.localInstrument || "MANU";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="urn:iso:std:iso:20022:tech:xsd:envelope:1">
  <AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
    <Fr>
      <FIId>
        <FinInstnId>
          <Othr>
            <Id>${params.senderIspb.padStart(8, "0")}</Id>
          </Othr>
        </FinInstnId>
      </FIId>
    </Fr>
    <To>
      <FIId>
        <FinInstnId>
          <Othr>
            <Id>${params.receiverIspb.padStart(8, "0")}</Id>
          </Othr>
        </FinInstnId>
      </FIId>
    </To>
    <BizMsgIdr>${bizMsgIdr}</BizMsgIdr>
    <MsgDefIdr>${msgDefIdr}</MsgDefIdr>
    <CreDt>${creationDateTime}</CreDt>
  </AppHdr>
  <Document xmlns="${namespace}">
    <FIToFICstmrCdtTrf>
      <GrpHdr>
        <MsgId>${bizMsgIdr}</MsgId>
        <CreDtTm>${creationDateTime}</CreDtTm>
        <NbOfTxs>1</NbOfTxs>
        <SttlmInf>
          <SttlmMtd>CLRG</SttlmMtd>
        </SttlmInf>
      </GrpHdr>
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>${endToEndId}</EndToEndId>
          <TxId>${endToEndId}</TxId>
        </PmtId>
        <PmtTpInf>
          <SvcLvl>
            <Prtry>DICT</Prtry>
          </SvcLvl>
          <LclInstrm>
            <Prtry>${localInstrument}</Prtry>
          </LclInstrm>
        </PmtTpInf>
        <IntrBkSttlmAmt Ccy="BRL">${formatAmount(params.amount)}</IntrBkSttlmAmt>
        <IntrBkSttlmDt>${settlementDate}</IntrBkSttlmDt>
        <ChrgBr>SLEV</ChrgBr>
        <Dbtr>
          <Nm>${params.debitParty.name}</Nm>
          <Id>
            <PrvtId>
              <${documentTag(params.debitParty.documentType)}>
                <Id>${params.debitParty.document}</Id>
              </${documentTag(params.debitParty.documentType)}>
            </PrvtId>
          </Id>
        </Dbtr>
        <DbtrAcct>
          <Id>
            <Othr>
              <Id>${params.debitParty.accountNumber}</Id>
            </Othr>
          </Id>
          <Tp>
            <Cd>${params.debitParty.accountType}</Cd>
          </Tp>
        </DbtrAcct>
        <DbtrAgt>
          <FinInstnId>
            <ClrSysMmbId>
              <MmbId>${params.senderIspb.padStart(8, "0")}</MmbId>
            </ClrSysMmbId>
          </FinInstnId>
        </DbtrAgt>
        <CdtrAgt>
          <FinInstnId>
            <ClrSysMmbId>
              <MmbId>${params.receiverIspb.padStart(8, "0")}</MmbId>
            </ClrSysMmbId>
          </FinInstnId>
        </CdtrAgt>
        <Cdtr>
          <Nm>${params.creditParty.name}</Nm>
          <Id>
            <PrvtId>
              <${documentTag(params.creditParty.documentType)}>
                <Id>${params.creditParty.document}</Id>
              </${documentTag(params.creditParty.documentType)}>
            </PrvtId>
          </Id>
        </Cdtr>
        <CdtrAcct>
          <Id>
            <Othr>
              <Id>${params.creditParty.accountNumber}</Id>
            </Othr>
          </Id>
          <Tp>
            <Cd>${params.creditParty.accountType}</Cd>
          </Tp>
        </CdtrAcct>${params.purpose ? `
        <Purp>
          <Prtry>${params.purpose}</Prtry>
        </Purp>` : ""}${params.description ? `
        <RmtInf>
          <Ustrd>${params.description}</Ustrd>
        </RmtInf>` : ""}
      </CdtTrfTxInf>
    </FIToFICstmrCdtTrf>
  </Document>
</Envelope>`;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const senderIspb = process.argv[2] || "12345678";
  const receiverIspb = process.argv[3] || "99999004";
  const version = (process.argv[4] as PacsVersion) || "1.13";

  const xml = generatePacs008({
    senderIspb,
    receiverIspb,
    amount: 1.50,
    version,
    localInstrument: "MANU",
    debitParty: {
      name: "Fernando Cruz",
      document: "12345678901",
      documentType: "CPF",
      branch: "0001",
      accountNumber: "123456",
      accountType: "CACC",
    },
    creditParty: {
      name: "Maria Silva",
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
