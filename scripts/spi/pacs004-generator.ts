/**
 * pacs.004 (PaymentReturn) XML Generator.
 *
 * Generates devolution (return/refund) messages for Pix payments.
 * Used when the receiving PSP needs to return funds after accepting a pacs.008.
 *
 * Key differences from pacs.008:
 * - E2E ID starts with 'D' instead of 'E' (devolution prefix)
 * - References the original transaction's E2E ID
 * - Sender/receiver are reversed from the original transaction
 *
 * Devolution types:
 * - MD06: Customer request (within 90 days)
 * - SL02: Operational error by creditor PSP
 * - FOCR: Following cancellation request
 * - FRAD: Fraud (MED)
 */

import { generateDevolutionEndToEndId } from "../utils/endtoendid-generator.js";
import { generateBizMsgIdr } from "../utils/biz-message-id-generator.js";

export interface Pacs004Params {
  senderIspb: string;
  receiverIspb: string;
  originalEndToEndId: string;
  amount: number;
  returnReasonCode: "MD06" | "SL02" | "FOCR" | "FRAD" | string;
  devolutionEndToEndId?: string;
  bizMsgIdr?: string;
  returnInfo?: string;
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

export function generatePacs004(params: Pacs004Params): string {
  const bizMsgIdr = params.bizMsgIdr || generateBizMsgIdr(params.senderIspb);
  const devolutionId = params.devolutionEndToEndId || generateDevolutionEndToEndId(params.senderIspb);
  const creationDateTime = isoDateTime();
  const settlementDate = isoDate();

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
    <MsgDefIdr>pacs.004.spi.1.13</MsgDefIdr>
    <CreDt>${creationDateTime}</CreDt>
  </AppHdr>
  <Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.004.001.13.spi.1.13">
    <PmtRtr>
      <GrpHdr>
        <MsgId>${bizMsgIdr}</MsgId>
        <CreDtTm>${creationDateTime}</CreDtTm>
        <NbOfTxs>1</NbOfTxs>
        <SttlmInf>
          <SttlmMtd>CLRG</SttlmMtd>
        </SttlmInf>
      </GrpHdr>
      <TxInf>
        <RtrId>${devolutionId}</RtrId>
        <OrgnlEndToEndId>${params.originalEndToEndId}</OrgnlEndToEndId>
        <RtrdIntrBkSttlmAmt Ccy="BRL">${formatAmount(params.amount)}</RtrdIntrBkSttlmAmt>
        <IntrBkSttlmDt>${settlementDate}</IntrBkSttlmDt>
        <RtrRsnInf>
          <Rsn>
            <Cd>${params.returnReasonCode}</Cd>
          </Rsn>${params.returnInfo ? `
          <AddtlInf>${params.returnInfo}</AddtlInf>` : ""}
        </RtrRsnInf>
      </TxInf>
    </PmtRtr>
  </Document>
</Envelope>`;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const senderIspb = process.argv[2] || "12345678";
  const receiverIspb = process.argv[3] || "99999004";

  console.log("=== pacs.004 - Devolution (MD06 - Customer Request) ===\n");
  console.log(
    generatePacs004({
      senderIspb,
      receiverIspb,
      originalEndToEndId: "E9999900420240115143500000000001A",
      amount: 10.50,
      returnReasonCode: "MD06",
      returnInfo: "Customer requested return",
    }),
  );
}
