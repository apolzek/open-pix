/**
 * DICT Infraction Report Helper (MED - Mecanismo Especial de Devolucao).
 *
 * Manages infraction reports for Pix fraud and operational errors.
 * MED is the mechanism that allows PSPs to flag and resolve fraudulent
 * or erroneous Pix transactions.
 *
 * Infraction types:
 * - FRAUD: Suspected fraud (triggers MED flow)
 * - OPERATIONAL_FLAW: Operational error by the PSP
 *
 * Report lifecycle:
 * 1. Reporter creates infraction report (Create)
 * 2. Counter-party receives notification
 * 3. Counter-party can accept or reject (Accept / Reject)
 * 4. Reporter can cancel before resolution (Cancel)
 *
 * MED 2.0 notes:
 * - Enhanced fraud detection with more fields
 * - Faster resolution timelines
 * - Integration with DICT fraud markers
 *
 * Usage:
 *   npx tsx scripts/dict/infraction-helper.ts create <endToEndId> FRAUD
 *   npx tsx scripts/dict/infraction-helper.ts accept <infractionId>
 *   npx tsx scripts/dict/infraction-helper.ts reject <infractionId>
 *   npx tsx scripts/dict/infraction-helper.ts cancel <infractionId>
 */

import { IcomClient } from "../utils/http-client.js";

export type InfractionType = "FRAUD" | "OPERATIONAL_FLAW";
export type InfractionAction = "create" | "accept" | "reject" | "cancel";

interface CreateInfractionParams {
  endToEndId: string;
  infractionType: InfractionType;
  reporterIspb: string;
  reportDetails?: string;
}

function buildCreateInfractionXml(params: CreateInfractionParams): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CreateInfractionReportRequest xmlns="urn:bcb:pix:dict:api:v2">
  <EndToEndId>${params.endToEndId}</EndToEndId>
  <InfractionType>${params.infractionType}</InfractionType>
  <ReporterIspb>${params.reporterIspb.padStart(8, "0")}</ReporterIspb>${params.reportDetails ? `
  <ReportDetails>${params.reportDetails}</ReportDetails>` : ""}
</CreateInfractionReportRequest>`;
}

function buildAcceptInfractionXml(infractionId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<AcceptInfractionReportRequest xmlns="urn:bcb:pix:dict:api:v2">
  <InfractionReportId>${infractionId}</InfractionReportId>
  <Analysis>AGREED</Analysis>
</AcceptInfractionReportRequest>`;
}

function buildRejectInfractionXml(infractionId: string, reason?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<AcceptInfractionReportRequest xmlns="urn:bcb:pix:dict:api:v2">
  <InfractionReportId>${infractionId}</InfractionReportId>
  <Analysis>DISAGREED</Analysis>${reason ? `
  <AnalysisDetails>${reason}</AnalysisDetails>` : ""}
</AcceptInfractionReportRequest>`;
}

function buildCancelInfractionXml(infractionId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CancelInfractionReportRequest xmlns="urn:bcb:pix:dict:api:v2">
  <InfractionReportId>${infractionId}</InfractionReportId>
</CancelInfractionReportRequest>`;
}

export async function createInfraction(
  client: IcomClient,
  params: CreateInfractionParams,
): Promise<string> {
  const xml = buildCreateInfractionXml(params);
  const response = await client.sendMessage(xml);

  const match = response.body.match(/<InfractionReportId>([^<]+)<\/InfractionReportId>/);
  const infractionId = match ? match[1] : "unknown";

  console.log(`Infraction report created: ${infractionId}`);
  return infractionId;
}

export async function acceptInfraction(
  client: IcomClient,
  infractionId: string,
): Promise<void> {
  const xml = buildAcceptInfractionXml(infractionId);
  await client.sendMessage(xml);
  console.log(`Infraction report accepted: ${infractionId}`);
}

export async function rejectInfraction(
  client: IcomClient,
  infractionId: string,
  reason?: string,
): Promise<void> {
  const xml = buildRejectInfractionXml(infractionId, reason);
  await client.sendMessage(xml);
  console.log(`Infraction report rejected: ${infractionId}`);
}

export async function cancelInfraction(
  client: IcomClient,
  infractionId: string,
): Promise<void> {
  const xml = buildCancelInfractionXml(infractionId);
  await client.sendMessage(xml);
  console.log(`Infraction report cancelled: ${infractionId}`);
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const action = (process.argv[2] as InfractionAction) || "create";
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  console.log(`=== DICT Infraction Report Helper (MED) ===`);
  console.log(`Action: ${action}\n`);

  switch (action) {
    case "create": {
      const endToEndId = arg1 || "E1234567820240115143500000000001A";
      const infractionType = (arg2 as InfractionType) || "FRAUD";
      console.log(`E2E ID: ${endToEndId}`);
      console.log(`Type: ${infractionType}\n`);
      console.log("--- Sample XML ---\n");
      console.log(buildCreateInfractionXml({
        endToEndId,
        infractionType,
        reporterIspb: "12345678",
        reportDetails: "Suspected fraudulent transaction reported by account holder",
      }));
      break;
    }
    case "accept":
      console.log(`Infraction ID: ${arg1 || "<required>"}\n`);
      console.log("--- Sample XML ---\n");
      console.log(buildAcceptInfractionXml(arg1 || "INFRACTION-ID-HERE"));
      break;
    case "reject":
      console.log(`Infraction ID: ${arg1 || "<required>"}\n`);
      console.log("--- Sample XML ---\n");
      console.log(buildRejectInfractionXml(arg1 || "INFRACTION-ID-HERE", "No evidence of fraud"));
      break;
    case "cancel":
      console.log(`Infraction ID: ${arg1 || "<required>"}\n`);
      console.log("--- Sample XML ---\n");
      console.log(buildCancelInfractionXml(arg1 || "INFRACTION-ID-HERE"));
      break;
  }
}
