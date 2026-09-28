/**
 * pacs.004 (PaymentReturn) XML Generator.
 *
 * Returns (devolucoes) of a settled Pix, following catalog 5.13
 * (pacs.004.spi.1.5). The return goes from the PSP of the original receiver
 * to the SPI.
 *
 * - RtrId: new identifier with 'D' prefix + ISPB of who returns + UTC stamp.
 * - OrgnlEndToEndId: the 'E' id of the original pacs.008, unchanged.
 * - OrgnlTxRef keeps the agents of the ORIGINAL transaction: DbtrAgt is the
 *   original payer's PSP and CdtrAgt the original receiver's PSP.
 *
 * Return reasons accepted by the XSD (ExternalReturnReason1Code):
 * - BE08: bank error, return by the receiving PSP
 * - FR01: fraud (MED - Mecanismo Especial de Devolucao)
 * - MD06: return requested by the receiving user
 * - SL02: Pix Saque/Troco return
 */

import { generateDevolutionEndToEndId, END_TO_END_ID_PATTERN } from "../utils/endtoendid-generator.js";
import { generateBizMsgIdr } from "../utils/biz-message-id-generator.js";
import { SPI_ISPB, agentXml, buildEnvelope, escapeXml, formatAmount, indent, isoUtc } from "./spi-envelope.js";

export type ReturnReason = "BE08" | "FR01" | "MD06" | "SL02";

export interface Pacs004Params {
  /** ISPB of the PSP that returns (the original receiver's PSP). */
  senderIspb: string;
  /** ISPB of the original payer's PSP, which receives the funds back. */
  originalPayerIspb: string;
  originalEndToEndId: string;
  amount: number;
  returnReasonCode: ReturnReason;
  priority?: "HIGH" | "NORM";
  devolutionEndToEndId?: string;
  bizMsgIdr?: string;
  /** Up to 105 chars. */
  returnInfo?: string;
  /** Free text from the returning user to the payer, up to 140 chars. */
  description?: string;
}

export function generatePacs004(params: Pacs004Params): string {
  if (!END_TO_END_ID_PATTERN.test(params.originalEndToEndId)) {
    throw new Error(`Invalid OrgnlEndToEndId: ${params.originalEndToEndId}`);
  }
  if (params.returnInfo !== undefined && params.returnInfo.length > 105) {
    throw new Error("AddtlInf must have up to 105 chars");
  }

  const bizMsgIdr = params.bizMsgIdr || generateBizMsgIdr(params.senderIspb);
  const returnId = params.devolutionEndToEndId || generateDevolutionEndToEndId(params.senderIspb);
  const createdAt = isoUtc();

  const addtlInf = params.returnInfo ? `\n            <AddtlInf>${escapeXml(params.returnInfo)}</AddtlInf>` : "";
  const rmtInf = params.description
    ? `
            <RmtInf>
                <Ustrd>${escapeXml(params.description)}</Ustrd>
            </RmtInf>`
    : "";

  const document = `<PmtRtr>
    <GrpHdr>
        <MsgId>${bizMsgIdr}</MsgId>
        <CreDtTm>${createdAt}</CreDtTm>
        <NbOfTxs>1</NbOfTxs>
        <SttlmInf>
            <SttlmMtd>CLRG</SttlmMtd>
        </SttlmInf>
    </GrpHdr>
    <TxInf>
        <RtrId>${returnId}</RtrId>
        <OrgnlEndToEndId>${params.originalEndToEndId}</OrgnlEndToEndId>
        <RtrdIntrBkSttlmAmt Ccy="BRL">${formatAmount(params.amount)}</RtrdIntrBkSttlmAmt>
        <SttlmPrty>${params.priority ?? "HIGH"}</SttlmPrty>
        <ChrgBr>SLEV</ChrgBr>
        <RtrRsnInf>
            <Rsn>
                <Cd>${params.returnReasonCode}</Cd>
            </Rsn>${addtlInf}
        </RtrRsnInf>
        <OrgnlTxRef>${rmtInf}
${indent(agentXml("DbtrAgt", params.originalPayerIspb), 12)}
${indent(agentXml("CdtrAgt", params.senderIspb), 12)}
        </OrgnlTxRef>
    </TxInf>
</PmtRtr>`;

  return buildEnvelope({
    type: "pacs.004",
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
  const originalPayerIspb = process.argv[3] || "99999A03";
  const originalEndToEndId = process.argv[4] || "E99999A0320260928143512345678900";

  console.log(
    generatePacs004({
      senderIspb,
      originalPayerIspb,
      originalEndToEndId,
      amount: 10.5,
      returnReasonCode: "MD06",
      returnInfo: "Devolucao solicitada pelo recebedor",
    }),
  );
}
