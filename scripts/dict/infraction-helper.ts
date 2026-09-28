/**
 * DICT Infraction Report Helper (MED - Mecanismo Especial de Devolucao).
 *
 * DICT API v2.12.1 (simulator/spec/dict-2.12.1/openapi.json, tag InfractionReport):
 *   createInfractionReport       POST /infraction-reports/                         <CreateInfractionReportRequest>      201
 *   getInfractionReport          GET  /infraction-reports/{InfractionReportId}                                          200
 *   acknowledgeInfractionReport  POST /infraction-reports/{InfractionReportId}/acknowledge  <AcknowledgeInfractionReportRequest> 200
 *   cancelInfractionReport       POST /infraction-reports/{InfractionReportId}/cancel       <CancelInfractionReportRequest>      200
 *   closeInfractionReport        POST /infraction-reports/{InfractionReportId}/close        <CloseInfractionReportRequest>       200
 *
 * An infraction report is created when there is well-founded suspicion of
 * fraud in a transaction settled in the SPI, identified by its EndToEndId
 * (<TransactionId>). Reason:
 *   - REFUND_REQUEST:   created by the PAYER's PSP to ask for a refund.
 *   - REFUND_CANCELLED: created by the RECEIVER's PSP to cancel a refund
 *                       (SituationType must then be OTHER).
 * SituationType: SCAM, ACCOUNT_TAKEOVER, COERCION, FRAUDULENT_ACCESS, OTHER
 *   (UNKNOWN only appears on reports created in API v1). ReportDetails
 *   (max 2000) is required when SituationType=OTHER. ContactInformation is
 *   optional, but when sent both Email and Phone are required.
 *
 * Status: OPEN -> ACKNOWLEDGED (counterparty received it) -> CLOSED (analysed),
 *   or CANCELLED (only by the PSP that created it, at any time).
 * Closing (counterparty, status ACKNOWLEDGED): AnalysisResult AGREED | DISAGREED.
 *   With AGREED, FraudType is mandatory (APPLICATION_FRAUD, MULE_ACCOUNT,
 *   SCAMMER_ACCOUNT, OTHER; UNKNOWN is not valid in v2) and a fraud marker is
 *   created automatically. AnalysisDetails (max 2000) is required when
 *   FraudType=OTHER. Closing with AGREED is a precondition to create a refund.
 * The counterparty discovers new reports by polling listInfractionReports.
 * Deadlines are in the Manual Operacional do DICT and Manual de Tempos do Pix.
 *
 * SIGNATURE: every write must carry an enveloped XMLDSig in <Signature>
 * (Manual de Seguranca do Pix). The XML built here leaves <Signature></Signature>
 * empty; it MUST be signed before sending or the DICT refuses it.
 *
 * Usage:
 *   npx tsx scripts/dict/infraction-helper.ts create <endToEndId> [situationType] [reason]
 *   npx tsx scripts/dict/infraction-helper.ts get <infractionReportId>
 *   npx tsx scripts/dict/infraction-helper.ts acknowledge <infractionReportId>
 *   npx tsx scripts/dict/infraction-helper.ts close <infractionReportId> AGREED <fraudType> [details]
 *   npx tsx scripts/dict/infraction-helper.ts close <infractionReportId> DISAGREED [details]
 *   npx tsx scripts/dict/infraction-helper.ts cancel <infractionReportId>
 *   ("accept"/"reject" are kept as aliases of close AGREED/DISAGREED.)
 */

import { DictClient } from "../utils/http-client.js";
import { generateEndToEndId } from "../utils/endtoendid-generator.js";
import {
  DictValidationError,
  SIGNATURE_WARNING,
  assertEnum,
  assertMaxLength,
  assertParticipant,
  assertPattern,
  assertUuid,
  describeDictError,
  dictClientFromEnv,
  dictDocument,
  installCliErrorHandler,
  missingEnv,
  parseDictXml,
  type XmlNode,
} from "./key-lookup.js";

export const INFRACTION_REASONS = ["REFUND_REQUEST", "REFUND_CANCELLED"] as const;
export type InfractionReason = (typeof INFRACTION_REASONS)[number];

/** SituationType values accepted on creation (UNKNOWN is v1-only). */
export const SITUATION_TYPES = ["SCAM", "ACCOUNT_TAKEOVER", "COERCION", "FRAUDULENT_ACCESS", "OTHER"] as const;
export type SituationType = (typeof SITUATION_TYPES)[number];

/** FraudType values accepted on close (UNKNOWN is not valid in v2). */
export const FRAUD_TYPES = ["APPLICATION_FRAUD", "MULE_ACCOUNT", "SCAMMER_ACCOUNT", "OTHER"] as const;
export type FraudType = (typeof FRAUD_TYPES)[number];

export const ANALYSIS_RESULTS = ["AGREED", "DISAGREED"] as const;
export type AnalysisResult = (typeof ANALYSIS_RESULTS)[number];

/** InfractionReport.TransactionId (spec pattern \w{8,32}). */
export const INFRACTION_TRANSACTION_ID_PATTERN = /^\w{8,32}$/;
export const CONTACT_EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const CONTACT_PHONE_PATTERN = /^\+[0-9]\d{1,14}$/;

export type InfractionAction = "create" | "get" | "acknowledge" | "close" | "cancel" | "accept" | "reject";

export interface CreateInfractionReportParams {
  /** ISPB of the reporting participant. */
  participant: string;
  /** EndToEndId of the settled SPI transaction. */
  transactionId: string;
  reason: InfractionReason;
  situationType: SituationType;
  reportDetails?: string;
  contactInformation?: { email: string; phone: string };
}

export interface InfractionOperationParams {
  infractionReportId: string;
  participant: string;
}

export interface CloseInfractionReportParams extends InfractionOperationParams {
  analysisResult: AnalysisResult;
  fraudType?: FraudType;
  analysisDetails?: string;
}

export function buildCreateInfractionReportRequest(params: CreateInfractionReportParams): string {
  assertParticipant(params.participant);
  assertPattern(params.transactionId, INFRACTION_TRANSACTION_ID_PATTERN, "InfractionReport.TransactionId");
  const reason = assertEnum(params.reason, INFRACTION_REASONS, "InfractionReport.Reason");
  const situationType = assertEnum(params.situationType, SITUATION_TYPES, "InfractionReport.SituationType");
  if (reason === "REFUND_CANCELLED" && situationType !== "OTHER") {
    throw new DictValidationError("SituationType must be OTHER when Reason=REFUND_CANCELLED");
  }
  if (situationType === "OTHER" && !params.reportDetails) {
    throw new DictValidationError("ReportDetails is required when SituationType=OTHER");
  }
  if (params.reportDetails !== undefined) assertMaxLength(params.reportDetails, 2000, "ReportDetails");

  let contact: XmlNode[] | undefined;
  if (params.contactInformation) {
    contact = [
      ["Email", assertPattern(params.contactInformation.email, CONTACT_EMAIL_PATTERN, "ContactInformation.Email")],
      ["Phone", assertPattern(params.contactInformation.phone, CONTACT_PHONE_PATTERN, "ContactInformation.Phone")],
    ];
  }

  return dictDocument("CreateInfractionReportRequest", [
    ["Participant", params.participant],
    ["InfractionReport", [
      ["TransactionId", params.transactionId],
      ["Reason", reason],
      ["SituationType", situationType],
      ["ReportDetails", params.reportDetails],
      ["ContactInformation", contact],
    ]],
  ]);
}

function operationNodes(params: InfractionOperationParams): XmlNode[] {
  return [
    ["InfractionReportId", assertUuid(params.infractionReportId, "InfractionReportId")],
    ["Participant", assertParticipant(params.participant)],
  ];
}

export function buildAcknowledgeInfractionReportRequest(params: InfractionOperationParams): string {
  return dictDocument("AcknowledgeInfractionReportRequest", operationNodes(params));
}

export function buildCancelInfractionReportRequest(params: InfractionOperationParams): string {
  return dictDocument("CancelInfractionReportRequest", operationNodes(params));
}

export function buildCloseInfractionReportRequest(params: CloseInfractionReportParams): string {
  const result = assertEnum(params.analysisResult, ANALYSIS_RESULTS, "AnalysisResult");
  if (params.fraudType !== undefined) assertEnum(params.fraudType, FRAUD_TYPES, "FraudType");
  if (result === "AGREED" && !params.fraudType) {
    throw new DictValidationError("FraudType is required when AnalysisResult=AGREED");
  }
  if (params.fraudType === "OTHER" && !params.analysisDetails) {
    throw new DictValidationError("AnalysisDetails is required when FraudType=OTHER");
  }
  if (params.analysisDetails !== undefined) assertMaxLength(params.analysisDetails, 2000, "AnalysisDetails");

  // Schema order: InfractionReportId, Participant, FraudType, AnalysisResult, AnalysisDetails.
  return dictDocument("CloseInfractionReportRequest", [
    ...operationNodes(params),
    ["FraudType", params.fraudType],
    ["AnalysisResult", result],
    ["AnalysisDetails", params.analysisDetails],
  ]);
}

function reportPath(id: string, action?: string): string {
  return `/infraction-reports/${encodeURIComponent(assertUuid(id, "InfractionReportId"))}${action ? `/${action}` : ""}`;
}

/** Returns the InfractionReport element of a *InfractionReportResponse. */
function reportOf(xml: string): Record<string, any> {
  const doc = parseDictXml(xml);
  const root = Object.keys(doc).find((k) => k.endsWith("Response"));
  return (root && doc[root]?.InfractionReport) ?? {};
}

export async function createInfractionReport(
  client: DictClient,
  params: CreateInfractionReportParams,
): Promise<Record<string, any>> {
  return reportOf((await client.call("POST", "/infraction-reports/", buildCreateInfractionReportRequest(params))).body);
}

export async function getInfractionReport(client: DictClient, id: string): Promise<Record<string, any>> {
  return reportOf((await client.call("GET", reportPath(id))).body);
}

export async function acknowledgeInfractionReport(
  client: DictClient,
  params: InfractionOperationParams,
): Promise<Record<string, any>> {
  const xml = buildAcknowledgeInfractionReportRequest(params);
  return reportOf((await client.call("POST", reportPath(params.infractionReportId, "acknowledge"), xml)).body);
}

export async function cancelInfractionReport(
  client: DictClient,
  params: InfractionOperationParams,
): Promise<Record<string, any>> {
  const xml = buildCancelInfractionReportRequest(params);
  return reportOf((await client.call("POST", reportPath(params.infractionReportId, "cancel"), xml)).body);
}

export async function closeInfractionReport(
  client: DictClient,
  params: CloseInfractionReportParams,
): Promise<Record<string, any>> {
  const xml = buildCloseInfractionReportRequest(params);
  return reportOf((await client.call("POST", reportPath(params.infractionReportId, "close"), xml)).body);
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  installCliErrorHandler();
  const action = (process.argv[2] || "create") as InfractionAction;
  const [arg1, arg2, arg3, arg4] = process.argv.slice(3);
  const ispb = process.env.PSP_ISPB || "12345678";
  const missing = missingEnv();
  const demoId = "91d65e98-97c0-4b0f-b577-73625da1f9fc";
  const id = arg1 || demoId;

  console.log(`=== DICT Infraction Report Helper (MED) ===`);
  console.log(`Action: ${action}`);
  console.log(`${SIGNATURE_WARNING}\n`);

  let method: "GET" | "POST" = "POST";
  let path: string;
  let xml: string | undefined;

  switch (action) {
    case "create": {
      const situationType = (arg2 || "SCAM") as SituationType;
      path = "/infraction-reports/";
      xml = buildCreateInfractionReportRequest({
        participant: ispb,
        transactionId: arg1 || generateEndToEndId(ispb),
        reason: (arg3 || "REFUND_REQUEST") as InfractionReason,
        situationType,
        reportDetails: situationType === "OTHER" || !arg1
          ? "Suspected fraudulent transaction reported by the account holder"
          : undefined,
      });
      break;
    }
    case "get":
      method = "GET";
      path = reportPath(id);
      break;
    case "acknowledge":
      path = reportPath(id, "acknowledge");
      xml = buildAcknowledgeInfractionReportRequest({ infractionReportId: id, participant: ispb });
      break;
    case "cancel":
      path = reportPath(id, "cancel");
      xml = buildCancelInfractionReportRequest({ infractionReportId: id, participant: ispb });
      break;
    case "close":
    case "accept":
    case "reject": {
      const result = (action === "accept" ? "AGREED" : action === "reject" ? "DISAGREED" : arg2 || "AGREED") as AnalysisResult;
      const rest = action === "close" ? [arg3, arg4] : [arg2, arg3];
      const fraudType = result === "AGREED" ? ((rest[0] || "SCAMMER_ACCOUNT") as FraudType) : undefined;
      const details = result === "AGREED" ? rest[1] : rest[0];
      path = reportPath(id, "close");
      xml = buildCloseInfractionReportRequest({
        infractionReportId: id,
        participant: ispb,
        analysisResult: result,
        fraudType,
        analysisDetails: details ?? (fraudType === "OTHER" ? "Analysis details" : undefined),
      });
      break;
    }
    default:
      console.error("Actions: create | get | acknowledge | close | cancel");
      process.exit(1);
  }

  if (missing.length > 0 || !arg1) {
    if (missing.length > 0) console.error(`Missing environment variables: ${missing.join(", ")}\n`);
    console.log(`--- Demo Mode: ${method} /api/v2${path} ---\n`);
    if (xml) console.log(xml);
    process.exit(0);
  }

  const client = dictClientFromEnv();
  client.call(method, path, xml)
    .then((res) => console.log(JSON.stringify(reportOf(res.body), null, 2)))
    .catch((err) => {
      console.error(`${action} failed:`, describeDictError(err));
      process.exitCode = 1;
    })
    .finally(() => client.destroy());
}
