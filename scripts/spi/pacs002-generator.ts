/**
 * pacs.002 (FIToFIPaymentStatusReport) XML Generator.
 *
 * The receiving PSP answers each pacs.008 with a pacs.002 addressed to the
 * SPI (catalog 5.13, pacs.002.spi.1.17). The SPI then settles and sends its
 * own pacs.002 (ACSC or RJCT) to both PSPs.
 *
 * Timing (Manual de Tempos do Pix 7.0):
 * - The whole cycle has a 40s limit counted from AccptncDtTm (t0') until
 *   settlement (t4). Past that, the SPI rejects with AB03 and the late
 *   pacs.002 is useless.
 * - The receiving PSP is measured on t3' - t2: 1.4s at p50 and 2.3s at p95.
 *   Aim for well under a second.
 *
 * Status sent by the receiving PSP:
 * - ACSP: accepted, settlement in process
 * - RJCT: rejected, with a reason code from ExternalStatusReason1Code
 *
 * Common rejection codes (full list in the XSD):
 * - AC03: invalid creditor account number
 * - AC06: blocked account
 * - AC07: closed account
 * - AG03: transaction type not supported
 * - AM18: invalid number of transactions
 * - BE01: creditor document inconsistent with the account
 * - DS04: order rejected by the creditor PSP
 * - FRAD: fraud
 * - SL02: specific service not offered
 */

import { generateBizMsgIdr } from "../utils/biz-message-id-generator.js";
import { END_TO_END_ID_PATTERN } from "../utils/endtoendid-generator.js";
import { SPI_ISPB, buildEnvelope, escapeXml, isoUtc } from "./spi-envelope.js";

export type Pacs002Status = "ACSP" | "RJCT" | "ACSC" | "ACCC";

export interface Pacs002Params {
  /** ISPB of the PSP answering (AppHdr/Fr). */
  senderIspb: string;
  /** Receiver of this message. For a PSP it is always the SPI. */
  receiverIspb?: string;
  originalEndToEndId: string;
  /**
   * OrgnlInstrId. For a normal Pix it repeats the EndToEndId; it differs
   * only when the original instruction has its own InstrId.
   */
  originalInstructionId?: string;
  status: Pacs002Status;
  rejectReasonCode?: string;
  additionalInfo?: string;
  bizMsgIdr?: string;
  /**
   * Set by the SPI on ACSC/ACCC: moment of settlement (FctvIntrBkSttlmDt)
   * and settlement date (OrgnlTxRef/IntrBkSttlmDt), as in the SPI examples.
   */
  settledAt?: Date;
}

export function generatePacs002(params: Pacs002Params): string {
  if (!END_TO_END_ID_PATTERN.test(params.originalEndToEndId)) {
    // OrgnlEndToEndId is always the E id, also when answering a pacs.004.
    throw new Error(`Invalid OrgnlEndToEndId: ${params.originalEndToEndId}`);
  }
  if (params.status === "RJCT" && !params.rejectReasonCode) {
    throw new Error("RJCT requires rejectReasonCode");
  }
  if (params.additionalInfo !== undefined && params.additionalInfo.length > 105) {
    throw new Error("AddtlInf must have up to 105 chars");
  }

  const bizMsgIdr = params.bizMsgIdr || generateBizMsgIdr(params.senderIspb);
  const createdAt = isoUtc();

  const reason =
    params.status === "RJCT"
      ? `
        <StsRsnInf>
            <Rsn>
                <Cd>${params.rejectReasonCode}</Cd>
            </Rsn>${params.additionalInfo ? `
            <AddtlInf>${escapeXml(params.additionalInfo)}</AddtlInf>` : ""}
        </StsRsnInf>`
      : "";

  // The settlement date follows the Brasilia calendar (assumption: the
  // catalog examples only show a date).
  const settlement = params.settledAt
    ? `
        <FctvIntrBkSttlmDt>
            <DtTm>${isoUtc(params.settledAt)}</DtTm>
        </FctvIntrBkSttlmDt>
        <OrgnlTxRef>
            <IntrBkSttlmDt>${new Date(params.settledAt.getTime() - 3 * 3600_000).toISOString().slice(0, 10)}</IntrBkSttlmDt>
        </OrgnlTxRef>`
    : "";

  const document = `<FIToFIPmtStsRpt>
    <GrpHdr>
        <MsgId>${bizMsgIdr}</MsgId>
        <CreDtTm>${createdAt}</CreDtTm>
    </GrpHdr>
    <TxInfAndSts>
        <OrgnlInstrId>${params.originalInstructionId ?? params.originalEndToEndId}</OrgnlInstrId>
        <OrgnlEndToEndId>${params.originalEndToEndId}</OrgnlEndToEndId>
        <TxSts>${params.status}</TxSts>${reason}${settlement}
    </TxInfAndSts>
</FIToFIPmtStsRpt>`;

  return buildEnvelope({
    type: "pacs.002",
    from: params.senderIspb,
    to: params.receiverIspb ?? SPI_ISPB,
    bizMsgIdr,
    createdAt,
    document,
  });
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const senderIspb = process.argv[2] || "12345678";
  const status = (process.argv[3] as Pacs002Status) || "ACSP";
  const originalEndToEndId = process.argv[4] || "E99999A0420260928143512345678900";

  console.log(
    generatePacs002({
      senderIspb,
      originalEndToEndId,
      status,
      rejectReasonCode: status === "RJCT" ? "AC03" : undefined,
    }),
  );
}
