/**
 * DICT Claims Helper - portability and ownership claims.
 *
 * DICT API v2.12.1 (simulator/spec/dict-2.12.1/openapi.json, tag Claim):
 *   createClaim       POST /claims/                        <CreateClaimRequest>       201
 *   getClaim          GET  /claims/{ClaimId}                                          200
 *   acknowledgeClaim  POST /claims/{ClaimId}/acknowledge   <AcknowledgeClaimRequest>  200
 *   confirmClaim      POST /claims/{ClaimId}/confirm       <ConfirmClaimRequest>      200
 *   cancelClaim       POST /claims/{ClaimId}/cancel        <CancelClaimRequest>       200
 *   completeClaim     POST /claims/{ClaimId}/complete      <CompleteClaimRequest>     200
 *
 * Claim types:
 *   - PORTABILITY: the same owner moves the key to an account at another PSP.
 *   - OWNERSHIP:   a new owner claims a key registered to someone else
 *                  (donor and claimer PSP may be the same).
 * Key type compatibility (createClaim table in the spec):
 *   OWNERSHIP   -> PHONE only
 *   PORTABILITY -> CPF, CNPJ, PHONE, EMAIL
 *   EVP         -> cannot be claimed or ported
 *
 * Status: OPEN -> WAITING_RESOLUTION -> CONFIRMED -> COMPLETED, or CANCELLED.
 * Lifecycle:
 *   1. Claimer PSP creates the claim (OPEN).
 *   2. Donor PSP finds it by polling listClaims and acknowledges (WAITING_RESOLUTION).
 *   3. Donor confirms (CONFIRMED; the donor's entry is removed) or the claim is cancelled.
 *      - OWNERSHIP: after the resolution period (ResolutionPeriodEnd) the donor
 *        may confirm with DEFAULT_OPERATION; confirming earlier returns
 *        ClaimResolutionPeriodNotEnded. Confirming with USER_REQUESTED brings
 *        CompletionPeriodEnd forward.
 *      - PORTABILITY: after ResolutionPeriodEnd the donor may cancel with DEFAULT_OPERATION.
 *   4. Claimer completes (COMPLETED; the entry is created for the claimer).
 *      OWNERSHIP requires CompletionPeriodEnd to have passed
 *      (else ClaimCompletionPeriodNotEnded); PORTABILITY only requires CONFIRMED.
 *   Nothing completes automatically: each step is an API call by a PSP.
 * Periods: the resolution period is 7 days and, for ownership claims, the
 * completion period is also 7 days (DICT operational manual; the spec example
 * shows ResolutionPeriodEnd/CompletionPeriodEnd 7 days after creation). Always
 * use the dates the DICT returns in the Claim.
 *
 * Who may use which reason (spec tables):
 *   confirm: USER_REQUESTED (donor), ACCOUNT_CLOSURE (donor, portability only),
 *            DEFAULT_OPERATION (donor, ownership only).
 *   cancel:  USER_REQUESTED, ACCOUNT_CLOSURE, DEFAULT_OPERATION, FRAUD,
 *            RECONCILIATION, RFB_VALIDATION (see the spec for donor/claimer rules).
 *   PARTICIPANT_EXCLUSION is internal to the DICT.
 *
 * SIGNATURE: every write must carry an enveloped XMLDSig in <Signature>
 * (Manual de Seguranca do Pix). The XML built here leaves <Signature></Signature>
 * empty; it MUST be signed before sending or the DICT refuses it.
 *
 * Usage:
 *   npx tsx scripts/dict/claims-helper.ts create PORTABILITY EMAIL user@example.com
 *   npx tsx scripts/dict/claims-helper.ts create OWNERSHIP PHONE +5561988887777
 *   npx tsx scripts/dict/claims-helper.ts get <claimId>
 *   npx tsx scripts/dict/claims-helper.ts acknowledge <claimId>
 *   npx tsx scripts/dict/claims-helper.ts confirm <claimId> [reason]
 *   npx tsx scripts/dict/claims-helper.ts cancel <claimId> [reason]
 *   npx tsx scripts/dict/claims-helper.ts complete <claimId>
 */

import { DictClient } from "../utils/http-client.js";
import { generateBankAccount, generateNaturalPerson } from "../utils/test-data-generator.js";
import {
  type BrazilianAccount,
  type KeyType,
  type Person,
  DictValidationError,
  SIGNATURE_WARNING,
  accountNodes,
  assertEnum,
  assertKey,
  assertKeyType,
  assertParticipant,
  assertUuid,
  describeDictError,
  dictClientFromEnv,
  dictDocument,
  installCliErrorHandler,
  missingEnv,
  newRequestId,
  parseDictXml,
  personNodes,
  startOfDayBrt,
  validateAccount,
  validatePerson,
} from "./key-lookup.js";

export const CLAIM_TYPES = ["OWNERSHIP", "PORTABILITY"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Key types each claim type accepts (createClaim compatibility table). */
export const CLAIM_KEY_TYPES: Record<ClaimType, readonly KeyType[]> = {
  OWNERSHIP: ["PHONE"],
  PORTABILITY: ["CPF", "CNPJ", "PHONE", "EMAIL"],
};

/** ClaimOperationReason values valid for confirmClaim (confirm table). */
export const CONFIRM_CLAIM_REASONS = ["USER_REQUESTED", "ACCOUNT_CLOSURE", "DEFAULT_OPERATION"] as const;
export type ConfirmClaimReason = (typeof CONFIRM_CLAIM_REASONS)[number];

/** ClaimOperationReason values valid for cancelClaim (PARTICIPANT_EXCLUSION is DICT-internal). */
export const CANCEL_CLAIM_REASONS = [
  "USER_REQUESTED",
  "ACCOUNT_CLOSURE",
  "DEFAULT_OPERATION",
  "FRAUD",
  "RECONCILIATION",
  "RFB_VALIDATION",
] as const;
export type CancelClaimReason = (typeof CANCEL_CLAIM_REASONS)[number];

export type ClaimAction = "create" | "get" | "acknowledge" | "confirm" | "cancel" | "complete";

export interface CreateClaimParams {
  claimType: ClaimType;
  keyType: KeyType;
  key: string;
  /** Claimer's account (Participant = claimer PSP). */
  claimerAccount: BrazilianAccount;
  /** Claimer end user. */
  claimer: Person;
}

export interface ClaimOperationParams {
  claimId: string;
  /** ISPB of the participant performing the operation. */
  participant: string;
}

export function buildCreateClaimRequest(params: CreateClaimParams): string {
  const claimType = assertEnum(params.claimType, CLAIM_TYPES, "Claim.Type");
  const keyType = assertKeyType(params.keyType);
  if (!CLAIM_KEY_TYPES[claimType].includes(keyType)) {
    throw new DictValidationError(
      `${claimType} claims accept key types ${CLAIM_KEY_TYPES[claimType].join(", ")}; got ${keyType}`,
    );
  }
  assertKey(keyType, params.key);
  validateAccount(params.claimerAccount, "Claim.ClaimerAccount");
  validatePerson(params.claimer, "Claim.Claimer");

  return dictDocument("CreateClaimRequest", [
    ["Claim", [
      ["Type", claimType],
      ["Key", params.key],
      ["KeyType", keyType],
      ["ClaimerAccount", accountNodes(params.claimerAccount)],
      ["Claimer", personNodes(params.claimer)],
    ]],
  ]);
}

function claimOperationNodes(params: ClaimOperationParams): [string, string][] {
  return [
    ["ClaimId", assertUuid(params.claimId, "ClaimId")],
    ["Participant", assertParticipant(params.participant)],
  ];
}

export function buildAcknowledgeClaimRequest(params: ClaimOperationParams): string {
  return dictDocument("AcknowledgeClaimRequest", claimOperationNodes(params));
}

export function buildConfirmClaimRequest(params: ClaimOperationParams & { reason: ConfirmClaimReason }): string {
  return dictDocument("ConfirmClaimRequest", [
    ...claimOperationNodes(params),
    ["Reason", assertEnum(params.reason, CONFIRM_CLAIM_REASONS, "Reason")],
  ]);
}

export function buildCancelClaimRequest(params: ClaimOperationParams & { reason: CancelClaimReason }): string {
  return dictDocument("CancelClaimRequest", [
    ...claimOperationNodes(params),
    ["Reason", assertEnum(params.reason, CANCEL_CLAIM_REASONS, "Reason")],
  ]);
}

/** RequestId: UUID v4 idempotency key (same rules as createEntry). */
export function buildCompleteClaimRequest(params: ClaimOperationParams & { requestId?: string }): string {
  return dictDocument("CompleteClaimRequest", [
    ...claimOperationNodes(params),
    ["RequestId", assertUuid(params.requestId ?? newRequestId(), "RequestId")],
  ]);
}

function claimPath(claimId: string, action?: string): string {
  return `/claims/${encodeURIComponent(assertUuid(claimId, "ClaimId"))}${action ? `/${action}` : ""}`;
}

/** Returns the Claim element of a *ClaimResponse (Id, Status, periods...). */
function claimOf(xml: string): Record<string, any> {
  const doc = parseDictXml(xml);
  const root = Object.keys(doc).find((k) => k.endsWith("Response"));
  return (root && doc[root]?.Claim) ?? {};
}

export async function createClaim(client: DictClient, params: CreateClaimParams): Promise<Record<string, any>> {
  const res = await client.call("POST", "/claims/", buildCreateClaimRequest(params));
  return claimOf(res.body);
}

export async function getClaim(client: DictClient, claimId: string): Promise<Record<string, any>> {
  return claimOf((await client.call("GET", claimPath(claimId))).body);
}

export async function acknowledgeClaim(client: DictClient, params: ClaimOperationParams): Promise<Record<string, any>> {
  const res = await client.call("POST", claimPath(params.claimId, "acknowledge"), buildAcknowledgeClaimRequest(params));
  return claimOf(res.body);
}

export async function confirmClaim(
  client: DictClient,
  params: ClaimOperationParams & { reason: ConfirmClaimReason },
): Promise<Record<string, any>> {
  const res = await client.call("POST", claimPath(params.claimId, "confirm"), buildConfirmClaimRequest(params));
  return claimOf(res.body);
}

export async function cancelClaim(
  client: DictClient,
  params: ClaimOperationParams & { reason: CancelClaimReason },
): Promise<Record<string, any>> {
  const res = await client.call("POST", claimPath(params.claimId, "cancel"), buildCancelClaimRequest(params));
  return claimOf(res.body);
}

export async function completeClaim(
  client: DictClient,
  params: ClaimOperationParams & { requestId?: string },
): Promise<Record<string, any>> {
  const res = await client.call("POST", claimPath(params.claimId, "complete"), buildCompleteClaimRequest(params));
  return claimOf(res.body);
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  installCliErrorHandler();
  const action = (process.argv[2] || "create") as ClaimAction;
  const [arg1, arg2, arg3] = process.argv.slice(3);
  const ispb = process.env.PSP_ISPB || "12345678";
  const missing = missingEnv();
  const demoClaimId = "123e4567-e89b-12d3-a456-426655440000";

  console.log(`=== DICT Claims Helper ===`);
  console.log(`Action: ${action}`);
  console.log(`${SIGNATURE_WARNING}\n`);

  let method: "GET" | "POST" = "POST";
  let path: string;
  let xml: string | undefined;

  switch (action) {
    case "create": {
      const claimType = assertEnum(arg1 || "PORTABILITY", CLAIM_TYPES, "ClaimType");
      const keyType = assertKeyType(arg2 || "PHONE");
      const key = arg3 || "+5561988887777";
      const holder = generateNaturalPerson();
      const account = generateBankAccount(ispb, holder);
      path = "/claims/";
      xml = buildCreateClaimRequest({
        claimType,
        keyType,
        key,
        claimerAccount: {
          participant: ispb,
          branch: account.branch,
          accountNumber: account.accountNumber,
          accountType: account.accountType,
          openingDate: startOfDayBrt(),
        },
        claimer: { type: "NATURAL_PERSON", taxIdNumber: holder.document, name: holder.name },
      });
      break;
    }
    case "get":
      method = "GET";
      path = claimPath(arg1 || demoClaimId);
      break;
    case "acknowledge":
      path = claimPath(arg1 || demoClaimId, "acknowledge");
      xml = buildAcknowledgeClaimRequest({ claimId: arg1 || demoClaimId, participant: ispb });
      break;
    case "confirm":
      path = claimPath(arg1 || demoClaimId, "confirm");
      xml = buildConfirmClaimRequest({
        claimId: arg1 || demoClaimId,
        participant: ispb,
        reason: (arg2 || "USER_REQUESTED") as ConfirmClaimReason,
      });
      break;
    case "cancel":
      path = claimPath(arg1 || demoClaimId, "cancel");
      xml = buildCancelClaimRequest({
        claimId: arg1 || demoClaimId,
        participant: ispb,
        reason: (arg2 || "USER_REQUESTED") as CancelClaimReason,
      });
      break;
    case "complete":
      path = claimPath(arg1 || demoClaimId, "complete");
      xml = buildCompleteClaimRequest({ claimId: arg1 || demoClaimId, participant: ispb });
      break;
    default:
      console.error("Actions: create | get | acknowledge | confirm | cancel | complete");
      process.exit(1);
  }

  if (missing.length > 0 || (action !== "create" && !arg1)) {
    if (missing.length > 0) console.error(`Missing environment variables: ${missing.join(", ")}\n`);
    console.log(`--- Demo Mode: ${method} /api/v2${path} ---\n`);
    if (xml) console.log(xml);
    process.exit(0);
  }

  const client = dictClientFromEnv();
  client.call(method, path, xml)
    .then((res) => console.log(JSON.stringify(claimOf(res.body), null, 2)))
    .catch((err) => {
      console.error(`${action} failed:`, describeDictError(err));
      process.exitCode = 1;
    })
    .finally(() => client.destroy());
}
