/**
 * DICT Refund Solicitation Helper.
 *
 * Manages refund requests for Pix transactions through the DICT API.
 * Used after an infraction report (MED) has been accepted, or for
 * operational failures.
 *
 * Refund types:
 * - FRAUD: Refund due to confirmed fraud (linked to infraction report)
 * - OPERATIONAL_FLAW: Refund due to PSP operational error
 *
 * Refund lifecycle:
 * 1. Create refund solicitation (linked to original transaction)
 * 2. Counter-party PSP processes the refund
 * 3. Refund confirmed or rejected
 * 4. If confirmed, a pacs.004 devolution is initiated
 *
 * Usage:
 *   npx tsx scripts/dict/refund-helper.ts create <endToEndId> FRAUD <amount>
 *   npx tsx scripts/dict/refund-helper.ts close <refundId>
 */

import { IcomClient } from "../utils/http-client.js";

export type RefundType = "FRAUD" | "OPERATIONAL_FLAW";
export type RefundAction = "create" | "close";

interface CreateRefundParams {
  endToEndId: string;
  refundType: RefundType;
  contestedAmount: number;
  requesterIspb: string;
  infractionReportId?: string;
  refundDetails?: string;
}

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

function buildCreateRefundXml(params: CreateRefundParams): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CreateRefundRequest xmlns="urn:bcb:pix:dict:api:v2">
  <EndToEndId>${params.endToEndId}</EndToEndId>
  <RefundType>${params.refundType}</RefundType>
  <ContestedAmount>${formatAmount(params.contestedAmount)}</ContestedAmount>
  <RequesterIspb>${params.requesterIspb.padStart(8, "0")}</RequesterIspb>${params.infractionReportId ? `
  <InfractionReportId>${params.infractionReportId}</InfractionReportId>` : ""}${params.refundDetails ? `
  <RefundDetails>${params.refundDetails}</RefundDetails>` : ""}
</CreateRefundRequest>`;
}

function buildCloseRefundXml(refundId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CloseRefundRequest xmlns="urn:bcb:pix:dict:api:v2">
  <RefundId>${refundId}</RefundId>
</CloseRefundRequest>`;
}

export async function createRefund(
  client: IcomClient,
  params: CreateRefundParams,
): Promise<string> {
  const xml = buildCreateRefundXml(params);
  const response = await client.sendMessage(xml);

  const match = response.body.match(/<RefundId>([^<]+)<\/RefundId>/);
  const refundId = match ? match[1] : "unknown";

  console.log(`Refund solicitation created: ${refundId}`);
  return refundId;
}

export async function closeRefund(
  client: IcomClient,
  refundId: string,
): Promise<void> {
  const xml = buildCloseRefundXml(refundId);
  await client.sendMessage(xml);
  console.log(`Refund closed: ${refundId}`);
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const action = (process.argv[2] as RefundAction) || "create";
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];
  const arg3 = process.argv[5];

  console.log(`=== DICT Refund Solicitation Helper ===`);
  console.log(`Action: ${action}\n`);

  switch (action) {
    case "create": {
      const endToEndId = arg1 || "E1234567820240115143500000000001A";
      const refundType = (arg2 as RefundType) || "FRAUD";
      const amount = parseFloat(arg3 || "100.00");

      console.log(`E2E ID: ${endToEndId}`);
      console.log(`Type: ${refundType}`);
      console.log(`Amount: R$ ${formatAmount(amount)}\n`);

      console.log("--- Sample XML ---\n");
      console.log(buildCreateRefundXml({
        endToEndId,
        refundType,
        contestedAmount: amount,
        requesterIspb: "12345678",
        infractionReportId: "INFRACTION-ID-123",
        refundDetails: "Refund after confirmed fraud via MED",
      }));
      break;
    }
    case "close":
      console.log(`Refund ID: ${arg1 || "<required>"}\n`);
      console.log("--- Sample XML ---\n");
      console.log(buildCloseRefundXml(arg1 || "REFUND-ID-HERE"));
      break;
  }
}
