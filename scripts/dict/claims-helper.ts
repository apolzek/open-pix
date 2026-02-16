/**
 * DICT Claims Helper - Portability and Ownership Flows.
 *
 * Manages Pix key claim processes:
 * - PORTABILITY: Move a key from one PSP to another (same owner)
 * - OWNERSHIP: Transfer key ownership to a different person
 *
 * IMPORTANT (Resolution 457/2025):
 * Ownership claims only work for PHONE keys. EMAIL ownership claims
 * are NOT supported due to regulatory restrictions. This was discovered
 * during real homologation — Bacen does not document this well.
 *
 * Claim lifecycle:
 * 1. Claimer creates claim (CreateClaim)
 * 2. Donor receives notification
 * 3. Donor confirms or cancels (ConfirmClaim / CancelClaim)
 * 4. If donor doesn't respond within 7 days, claim auto-completes
 *
 * Usage:
 *   npx tsx scripts/dict/claims-helper.ts create PORTABILITY EMAIL user@example.com
 *   npx tsx scripts/dict/claims-helper.ts confirm <claimId>
 *   npx tsx scripts/dict/claims-helper.ts cancel <claimId>
 */

import { IcomClient } from "../utils/http-client.js";
import { generateBankAccount, generateNaturalPerson } from "../utils/test-data-generator.js";
import type { DictKeyType } from "../utils/test-data-generator.js";

export type ClaimType = "PORTABILITY" | "OWNERSHIP";
export type ClaimAction = "create" | "confirm" | "cancel";

interface CreateClaimParams {
  claimType: ClaimType;
  keyType: DictKeyType;
  key: string;
  claimerIspb: string;
  claimerAccount: {
    branch: string;
    accountNumber: string;
    accountType: string;
  };
  claimerOwner: {
    type: string;
    name: string;
    taxIdNumber: string;
  };
}

function buildCreateClaimXml(params: CreateClaimParams): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CreateClaimRequest xmlns="urn:bcb:pix:dict:api:v2">
  <ClaimType>${params.claimType}</ClaimType>
  <KeyType>${params.keyType}</KeyType>
  <Key>${params.key}</Key>
  <Claimer>
    <Account>
      <Participant>${params.claimerIspb.padStart(8, "0")}</Participant>
      <Branch>${params.claimerAccount.branch}</Branch>
      <AccountNumber>${params.claimerAccount.accountNumber}</AccountNumber>
      <AccountType>${params.claimerAccount.accountType}</AccountType>
    </Account>
    <Owner>
      <Type>${params.claimerOwner.type}</Type>
      <Name>${params.claimerOwner.name}</Name>
      <TaxIdNumber>${params.claimerOwner.taxIdNumber}</TaxIdNumber>
    </Owner>
  </Claimer>
</CreateClaimRequest>`;
}

function buildConfirmClaimXml(claimId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ConfirmClaimRequest xmlns="urn:bcb:pix:dict:api:v2">
  <ClaimId>${claimId}</ClaimId>
</ConfirmClaimRequest>`;
}

function buildCancelClaimXml(claimId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CancelClaimRequest xmlns="urn:bcb:pix:dict:api:v2">
  <ClaimId>${claimId}</ClaimId>
</CancelClaimRequest>`;
}

export async function createClaim(
  client: IcomClient,
  params: CreateClaimParams,
): Promise<string> {
  // Validate: ownership claims only work for PHONE keys
  if (params.claimType === "OWNERSHIP" && params.keyType !== "PHONE") {
    console.warn(
      `WARNING: Ownership claims only work for PHONE keys (Resolution 457/2025). ` +
      `Key type ${params.keyType} will likely fail.`,
    );
  }

  const xml = buildCreateClaimXml(params);
  const response = await client.sendMessage(xml);

  // Extract claim ID from response
  const match = response.body.match(/<ClaimId>([^<]+)<\/ClaimId>/);
  const claimId = match ? match[1] : "unknown";

  console.log(`Claim created: ${claimId}`);
  return claimId;
}

export async function confirmClaim(
  client: IcomClient,
  claimId: string,
): Promise<void> {
  const xml = buildConfirmClaimXml(claimId);
  await client.sendMessage(xml);
  console.log(`Claim confirmed: ${claimId}`);
}

export async function cancelClaim(
  client: IcomClient,
  claimId: string,
): Promise<void> {
  const xml = buildCancelClaimXml(claimId);
  await client.sendMessage(xml);
  console.log(`Claim cancelled: ${claimId}`);
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const action = (process.argv[2] as ClaimAction) || "create";
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];
  const arg3 = process.argv[5];

  console.log(`=== DICT Claims Helper ===`);
  console.log(`Action: ${action}\n`);

  if (action === "create") {
    const claimType = (arg1 as ClaimType) || "PORTABILITY";
    const keyType = (arg2 as DictKeyType) || "PHONE";
    const key = arg3 || "+5511999999999";

    console.log(`Claim type: ${claimType}`);
    console.log(`Key type: ${keyType}`);
    console.log(`Key: ${key}\n`);

    if (claimType === "OWNERSHIP" && keyType !== "PHONE") {
      console.warn("⚠  WARNING: Ownership claims only work for PHONE keys (Resolution 457/2025)");
      console.warn("   EMAIL ownership claims will be silently rejected by Bacen.\n");
    }

    const holder = generateNaturalPerson();
    const account = generateBankAccount("12345678", holder);

    console.log("--- Sample XML ---\n");
    console.log(buildCreateClaimXml({
      claimType,
      keyType,
      key,
      claimerIspb: "12345678",
      claimerAccount: {
        branch: account.branch,
        accountNumber: account.accountNumber,
        accountType: account.accountType,
      },
      claimerOwner: {
        type: "NATURAL_PERSON",
        name: holder.name,
        taxIdNumber: holder.document,
      },
    }));
  } else if (action === "confirm") {
    console.log(`Claim ID: ${arg1 || "<required>"}\n`);
    console.log("--- Sample XML ---\n");
    console.log(buildConfirmClaimXml(arg1 || "CLAIM-ID-HERE"));
  } else if (action === "cancel") {
    console.log(`Claim ID: ${arg1 || "<required>"}\n`);
    console.log("--- Sample XML ---\n");
    console.log(buildCancelClaimXml(arg1 || "CLAIM-ID-HERE"));
  }
}
