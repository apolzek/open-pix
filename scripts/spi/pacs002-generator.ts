/**
 * pacs.002 (FIToFIPaymentStatusReport) XML Generator.
 *
 * Generates status response messages for incoming pacs.008 payments.
 * A pacs.002 must be sent back within ~10 seconds of receiving a pacs.008,
 * otherwise the SPI will automatically reject with AB03 (timeout).
 *
 * Status codes:
 * - ACSP: Accepted Settlement in Process (positive ack)
 * - RJCT: Rejected (with reason code)
 *
 * Common rejection codes:
 * - AB09: Invalid account
 * - AG03: Account blocked/inactive
 * - AM02: Amount exceeds limit
 * - BE01: Invalid beneficiary info
 * - DS04: Order rejected
 * - MD01: No mandate
 * - SL02: Specific service offered by Creditor Agent
 */

import { generateBizMsgIdr } from "../utils/biz-message-id-generator.js";

export type Pacs002Status = "ACSP" | "RJCT";

export interface Pacs002Params {
  senderIspb: string;
  receiverIspb: string;
  originalEndToEndId: string;
  originalBizMsgIdr: string;
  status: Pacs002Status;
  rejectReasonCode?: string;
  bizMsgIdr?: string;
}

function isoDateTime(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export function generatePacs002(params: Pacs002Params): string {
  const bizMsgIdr = params.bizMsgIdr || generateBizMsgIdr(params.senderIspb);
  const creationDateTime = isoDateTime();

  const statusInfo = params.status === "RJCT"
    ? `
          <TxInfAndSts>
            <OrgnlEndToEndId>${params.originalEndToEndId}</OrgnlEndToEndId>
            <TxSts>${params.status}</TxSts>
            <StsRsnInf>
              <Rsn>
                <Cd>${params.rejectReasonCode || "DS04"}</Cd>
              </Rsn>
            </StsRsnInf>
          </TxInfAndSts>`
    : `
          <TxInfAndSts>
            <OrgnlEndToEndId>${params.originalEndToEndId}</OrgnlEndToEndId>
            <TxSts>${params.status}</TxSts>
          </TxInfAndSts>`;

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
    <MsgDefIdr>pacs.002.spi.1.13</MsgDefIdr>
    <CreDt>${creationDateTime}</CreDt>
  </AppHdr>
  <Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.14.spi.1.13">
    <FIToFIPmtStsRpt>
      <GrpHdr>
        <MsgId>${bizMsgIdr}</MsgId>
        <CreDtTm>${creationDateTime}</CreDtTm>
      </GrpHdr>
      <OrgnlGrpInfAndSts>
        <OrgnlMsgId>${params.originalBizMsgIdr}</OrgnlMsgId>
        <OrgnlMsgNmId>pacs.008.spi.1.13</OrgnlMsgNmId>
      </OrgnlGrpInfAndSts>${statusInfo}
    </FIToFIPmtStsRpt>
  </Document>
</Envelope>`;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const senderIspb = process.argv[2] || "12345678";
  const receiverIspb = process.argv[3] || "99999004";
  const status = (process.argv[4] as Pacs002Status) || "ACSP";

  console.log("=== pacs.002 - Accepted ===\n");
  console.log(
    generatePacs002({
      senderIspb,
      receiverIspb,
      originalEndToEndId: "E1234567820240115143500000000001A",
      originalBizMsgIdr: "M12345678abcDEF01234567890123456",
      status: "ACSP",
    }),
  );

  if (status === "RJCT") {
    console.log("\n=== pacs.002 - Rejected ===\n");
    console.log(
      generatePacs002({
        senderIspb,
        receiverIspb,
        originalEndToEndId: "E1234567820240115143500000000001A",
        originalBizMsgIdr: "M12345678abcDEF01234567890123456",
        status: "RJCT",
        rejectReasonCode: "AB09",
      }),
    );
  }
}
