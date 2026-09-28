/**
 * DICT Refund Solicitation Helper.
 *
 * DICT API v2.12.1 (simulator/spec/dict-2.12.1/openapi.json, tag Refund):
 *   createRefund  POST /refunds/                   <CreateRefundRequest>  201
 *   getRefund     GET  /refunds/{RefundId}                                200
 *   cancelRefund  POST /refunds/{RefundId}/cancel  <CancelRefundRequest>  200
 *   closeRefund   POST /refunds/{RefundId}/close   <CloseRefundRequest>   200
 *
 * A refund solicitation is created by the PAYER's PSP (only the debited
 * participant) when there is well-founded suspicion of fraud or an operational
 * flaw in any participant's system. For fraud, closing the infraction report
 * with AGREED is a precondition (see infraction-helper.ts). The request does
 * not reference the infraction report; it references the transaction.
 *   RefundReason: FRAUD, OPERATIONAL_FLAW, PIX_AUTOMATICO
 *     ("REFUND_CANCELLED (DEPRECATED)" is listed in the enum but deprecated).
 *   RefundDetails (max 2000) is required when RefundReason=OPERATIONAL_FLAW.
 *   RefundAmount: amount requested, decimal with 2 places (e.g. 100.00).
 *
 * Status: OPEN -> CLOSED (analysed by the receiver's PSP, the contested
 *   participant) or CANCELLED (by the creator; not possible after CLOSED).
 * Closing (status OPEN): RefundAnalysisResult TOTALLY_ACCEPTED |
 *   PARTIALLY_ACCEPTED | REJECTED; RefundRejectionReason NO_BALANCE,
 *   ACCOUNT_CLOSURE, INVALID_REQUEST (only for OPERATIONAL_FLAW refunds), OTHER
 *   (PARTICIPANT_EXCLUSION is DICT-internal); RefundAnalysisDetails is required
 *   when rejecting with INVALID_REQUEST. RefundTransactionId is the return
 *   (pacs.004 RtrId, "D..." id). EffectiveRefundedAmount is only used for
 *   Funds Recovery (Recuperacao de Valores), where it is mandatory.
 *
 * SIGNATURE: every write must carry an enveloped XMLDSig in <Signature>
 * (Manual de Seguranca do Pix). The XML built here leaves <Signature></Signature>
 * empty; it MUST be signed before sending or the DICT refuses it.
 *
 * Usage:
 *   npx tsx scripts/dict/refund-helper.ts create <endToEndId> [reason] [amount] [details]
 *   npx tsx scripts/dict/refund-helper.ts get <refundId>
 *   npx tsx scripts/dict/refund-helper.ts cancel <refundId>
 *   npx tsx scripts/dict/refund-helper.ts close <refundId> TOTALLY_ACCEPTED <refundTransactionId>
 *   npx tsx scripts/dict/refund-helper.ts close <refundId> REJECTED <rejectionReason> [details]
 */

import { DictClient } from "../utils/http-client.js";
import { generateDevolutionEndToEndId, generateEndToEndId } from "../utils/endtoendid-generator.js";
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

/** RefundReason values accepted on creation (the deprecated one excluded). */
export const REFUND_REASONS = ["FRAUD", "OPERATIONAL_FLAW", "PIX_AUTOMATICO"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_ANALYSIS_RESULTS = ["TOTALLY_ACCEPTED", "PARTIALLY_ACCEPTED", "REJECTED"] as const;
export type RefundAnalysisResult = (typeof REFUND_ANALYSIS_RESULTS)[number];

/** PARTICIPANT_EXCLUSION is DICT-internal and not accepted here. */
export const REFUND_REJECTION_REASONS = ["NO_BALANCE", "ACCOUNT_CLOSURE", "INVALID_REQUEST", "OTHER"] as const;
export type RefundRejectionReason = (typeof REFUND_REJECTION_REASONS)[number];

/** Refund.TransactionId and RefundTransactionId (spec pattern \w{32}). */
export const REFUND_TRANSACTION_ID_PATTERN = /^\w{32}$/;

export type RefundAction = "create" | "get" | "cancel" | "close";

export interface CreateRefundParams {
  /** ISPB of the requesting (debited) participant. */
  participant: string;
  /** EndToEndId of the contested transaction. */
  transactionId: string;
  refundReason: RefundReason;
  refundAmount: number;
  refundDetails?: string;
}

export interface RefundOperationParams {
  refundId: string;
  participant: string;
}

export interface CloseRefundParams extends RefundOperationParams {
  refundAnalysisResult: RefundAnalysisResult;
  refundAnalysisDetails?: string;
  refundRejectionReason?: RefundRejectionReason;
  /** Return transaction id (pacs.004 RtrId). */
  refundTransactionId?: string;
  /** Funds Recovery only. */
  effectiveRefundedAmount?: number;
}

export function formatAmount(amount: number, field = "RefundAmount"): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new DictValidationError(`${field} must be a positive amount, got ${amount}`);
  }
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    throw new DictValidationError(`${field} must have at most 2 decimal places, got ${amount}`);
  }
  return amount.toFixed(2);
}

export function buildCreateRefundRequest(params: CreateRefundParams): string {
  assertParticipant(params.participant);
  assertPattern(params.transactionId, REFUND_TRANSACTION_ID_PATTERN, "Refund.TransactionId");
  const reason = assertEnum(params.refundReason, REFUND_REASONS, "Refund.RefundReason");
  if (reason === "OPERATIONAL_FLAW" && !params.refundDetails) {
    throw new DictValidationError("RefundDetails is required when RefundReason=OPERATIONAL_FLAW");
  }
  if (params.refundDetails !== undefined) assertMaxLength(params.refundDetails, 2000, "RefundDetails");

  return dictDocument("CreateRefundRequest", [
    ["Participant", params.participant],
    ["Refund", [
      ["TransactionId", params.transactionId],
      ["RefundReason", reason],
      ["RefundAmount", formatAmount(params.refundAmount)],
      ["RefundDetails", params.refundDetails],
    ]],
  ]);
}

function operationNodes(params: RefundOperationParams): XmlNode[] {
  return [
    ["RefundId", assertUuid(params.refundId, "RefundId")],
    ["Participant", assertParticipant(params.participant)],
  ];
}

export function buildCancelRefundRequest(params: RefundOperationParams): string {
  return dictDocument("CancelRefundRequest", operationNodes(params));
}

export function buildCloseRefundRequest(params: CloseRefundParams): string {
  const result = assertEnum(params.refundAnalysisResult, REFUND_ANALYSIS_RESULTS, "RefundAnalysisResult");
  if (params.refundRejectionReason !== undefined) {
    if (result !== "REJECTED") {
      throw new DictValidationError("RefundRejectionReason only applies when RefundAnalysisResult=REJECTED");
    }
    assertEnum(params.refundRejectionReason, REFUND_REJECTION_REASONS, "RefundRejectionReason");
  }
  if (params.refundRejectionReason === "INVALID_REQUEST" && !params.refundAnalysisDetails) {
    throw new DictValidationError("RefundAnalysisDetails is required when rejecting with INVALID_REQUEST");
  }
  if (params.refundAnalysisDetails !== undefined) {
    assertMaxLength(params.refundAnalysisDetails, 2000, "RefundAnalysisDetails");
  }
  if (params.refundTransactionId !== undefined) {
    assertPattern(params.refundTransactionId, REFUND_TRANSACTION_ID_PATTERN, "RefundTransactionId");
  }

  return dictDocument("CloseRefundRequest", [
    ...operationNodes(params),
    ["RefundAnalysisResult", result],
    ["RefundAnalysisDetails", params.refundAnalysisDetails],
    ["RefundRejectionReason", params.refundRejectionReason],
    ["RefundTransactionId", params.refundTransactionId],
    ["EffectiveRefundedAmount", params.effectiveRefundedAmount === undefined
      ? undefined
      : formatAmount(params.effectiveRefundedAmount, "EffectiveRefundedAmount")],
  ]);
}

function refundPath(id: string, action?: string): string {
  return `/refunds/${encodeURIComponent(assertUuid(id, "RefundId"))}${action ? `/${action}` : ""}`;
}

/** Returns the Refund element of a *RefundResponse. */
function refundOf(xml: string): Record<string, any> {
  const doc = parseDictXml(xml);
  const root = Object.keys(doc).find((k) => k.endsWith("Response"));
  return (root && doc[root]?.Refund) ?? {};
}

export async function createRefund(client: DictClient, params: CreateRefundParams): Promise<Record<string, any>> {
  return refundOf((await client.call("POST", "/refunds/", buildCreateRefundRequest(params))).body);
}

export async function getRefund(client: DictClient, refundId: string): Promise<Record<string, any>> {
  return refundOf((await client.call("GET", refundPath(refundId))).body);
}

export async function cancelRefund(client: DictClient, params: RefundOperationParams): Promise<Record<string, any>> {
  return refundOf((await client.call("POST", refundPath(params.refundId, "cancel"), buildCancelRefundRequest(params))).body);
}

export async function closeRefund(client: DictClient, params: CloseRefundParams): Promise<Record<string, any>> {
  return refundOf((await client.call("POST", refundPath(params.refundId, "close"), buildCloseRefundRequest(params))).body);
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  installCliErrorHandler();
  const action = (process.argv[2] || "create") as RefundAction;
  const [arg1, arg2, arg3, arg4] = process.argv.slice(3);
  const ispb = process.env.PSP_ISPB || "12345678";
  const missing = missingEnv();
  const demoId = "91d65e98-97c0-4b0f-b577-73625da1f9fc";
  const id = arg1 || demoId;

  console.log(`=== DICT Refund Solicitation Helper ===`);
  console.log(`Action: ${action}`);
  console.log(`${SIGNATURE_WARNING}\n`);

  let method: "GET" | "POST" = "POST";
  let path: string;
  let xml: string | undefined;

  switch (action) {
    case "create": {
      const refundReason = (arg2 || "FRAUD") as RefundReason;
      path = "/refunds/";
      xml = buildCreateRefundRequest({
        participant: ispb,
        transactionId: arg1 || generateEndToEndId(ispb),
        refundReason,
        refundAmount: parseFloat(arg3 || "100.00"),
        refundDetails: arg4 ?? (refundReason === "OPERATIONAL_FLAW" || !arg1
          ? "Refund requested after infraction report closed with AGREED"
          : undefined),
      });
      break;
    }
    case "get":
      method = "GET";
      path = refundPath(id);
      break;
    case "cancel":
      path = refundPath(id, "cancel");
      xml = buildCancelRefundRequest({ refundId: id, participant: ispb });
      break;
    case "close": {
      const result = (arg2 || "TOTALLY_ACCEPTED") as RefundAnalysisResult;
      path = refundPath(id, "close");
      xml = result === "REJECTED"
        ? buildCloseRefundRequest({
          refundId: id,
          participant: ispb,
          refundAnalysisResult: result,
          refundRejectionReason: (arg3 || "NO_BALANCE") as RefundRejectionReason,
          refundAnalysisDetails: arg4,
        })
        : buildCloseRefundRequest({
          refundId: id,
          participant: ispb,
          refundAnalysisResult: result,
          refundTransactionId: arg3 || generateDevolutionEndToEndId(ispb),
        });
      break;
    }
    default:
      console.error("Actions: create | get | cancel | close");
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
    .then((res) => console.log(JSON.stringify(refundOf(res.body), null, 2)))
    .catch((err) => {
      console.error(`${action} failed:`, describeDictError(err));
      process.exitCode = 1;
    })
    .finally(() => client.destroy());
}
