/**
 * DICT Key Lookup Utility.
 *
 * Looks up a Pix key in the DICT directory to resolve the account owner.
 * Used for:
 * - DICT functionality testing
 * - Verifying key registrations
 * - Pre-lookup before sending a Pix payment (DICT local instrument)
 *
 * The DICT lookup returns the full account information for a given key,
 * allowing the sender to confirm the recipient before initiating the payment.
 *
 * Usage:
 *   npx tsx scripts/dict/key-lookup.ts <keyType> <keyValue>
 *   npx tsx scripts/dict/key-lookup.ts EMAIL user@example.com
 *   npx tsx scripts/dict/key-lookup.ts CPF 12345678901
 */

import { IcomClient } from "../utils/http-client.js";
import type { DictKeyType } from "../utils/test-data-generator.js";

interface LookupResult {
  keyType: string;
  key: string;
  account?: {
    participant: string;
    branch: string;
    accountNumber: string;
    accountType: string;
  };
  owner?: {
    type: string;
    name: string;
    taxIdNumber: string;
  };
  createdAt?: string;
  error?: string;
}

function buildLookupXml(keyType: DictKeyType, key: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<GetKeyRequest xmlns="urn:bcb:pix:dict:api:v2">
  <KeyType>${keyType}</KeyType>
  <Key>${key}</Key>
</GetKeyRequest>`;
}

function parseLookupResponse(xml: string): Partial<LookupResult> {
  // Simple XML extraction (avoid heavy XML parser dependency)
  const extract = (tag: string): string | undefined => {
    const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match ? match[1] : undefined;
  };

  if (xml.includes("Error") || xml.includes("Fault")) {
    return { error: extract("Message") || extract("Reason") || "Unknown error" };
  }

  return {
    account: {
      participant: extract("Participant") || "",
      branch: extract("Branch") || "",
      accountNumber: extract("AccountNumber") || "",
      accountType: extract("AccountType") || "",
    },
    owner: {
      type: extract("Type") || "",
      name: extract("Name") || "",
      taxIdNumber: extract("TaxIdNumber") || "",
    },
    createdAt: extract("KeyCreationDate") || extract("CreatedAt"),
  };
}

export async function lookupKey(
  client: IcomClient,
  keyType: DictKeyType,
  key: string,
): Promise<LookupResult> {
  const xml = buildLookupXml(keyType, key);
  const response = await client.sendMessage(xml);
  const parsed = parseLookupResponse(response.body);

  return {
    keyType,
    key,
    ...parsed,
  };
}

export async function batchLookup(
  client: IcomClient,
  keys: Array<{ type: DictKeyType; value: string }>,
  concurrency = 10,
): Promise<LookupResult[]> {
  const results: LookupResult[] = [];

  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((k) => lookupKey(client, k.type, k.value).catch((err) => ({
        keyType: k.type,
        key: k.value,
        error: (err as Error).message,
      }))),
    );
    results.push(...batchResults);

    if ((i + concurrency) % 100 === 0 || i + concurrency >= keys.length) {
      console.log(`  Lookup progress: ${Math.min(i + concurrency, keys.length)}/${keys.length}`);
    }
  }

  return results;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const keyType = (process.argv[2] as DictKeyType) || "EMAIL";
  const key = process.argv[3] || "cliente-000000@pix.bcb.gov.br";

  console.log(`=== DICT Key Lookup ===`);
  console.log(`Key type: ${keyType}`);
  console.log(`Key: ${key}\n`);

  const requiredVars = ["PSP_ISPB", "MTLS_CERT_PATH", "MTLS_KEY_PATH", "MTLS_CA_PATH"];
  const missing = requiredVars.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("Copy config/homolog.env.example to .env and configure.\n");

    console.log("--- Demo Mode (generating sample XML) ---\n");
    console.log(buildLookupXml(keyType, key));
    process.exit(0);
  }

  const ispb = process.env.PSP_ISPB!;
  const client = new IcomClient({
    baseUrl: process.env.DICT_BASE_URL || "https://dict-h.pi.rsfn.net.br",
    ispb,
    certPath: process.env.MTLS_CERT_PATH!,
    keyPath: process.env.MTLS_KEY_PATH!,
    caPath: process.env.MTLS_CA_PATH!,
    passphrase: process.env.MTLS_PASSPHRASE,
  });

  lookupKey(client, keyType, key)
    .then((result) => {
      console.log("Result:", JSON.stringify(result, null, 2));
      client.destroy();
    })
    .catch((err) => {
      console.error("Lookup failed:", err.message);
      client.destroy();
      process.exit(1);
    });
}
