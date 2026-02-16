/**
 * DICT Key Bulk Creator.
 *
 * Creates 1000+ keys per type (CPF, CNPJ, EMAIL, PHONE, EVP) in the DICT.
 * Used for DICT functionality testing and preparing for capacity tests.
 *
 * Key types and limits:
 * - CPF: 1 per natural person per participant
 * - CNPJ: 1 per legal person per participant
 * - EMAIL: up to 5 per account
 * - PHONE: up to 5 per account (Brazilian format: +55DDDNNNNNNNNN)
 * - EVP (random key): up to 20 per account
 *
 * Usage:
 *   npx tsx scripts/dict/key-bulk-creator.ts [keyType] [count]
 */

import { IcomClient } from "../utils/http-client.js";
import {
  generateNaturalPerson,
  generateLegalPerson,
  generateBankAccount,
  generateDictKey,
  type DictKeyType,
} from "../utils/test-data-generator.js";

interface CreateKeyRequest {
  keyType: DictKeyType;
  key: string;
  account: {
    participant: string;
    branch: string;
    accountNumber: string;
    accountType: string;
  };
  owner: {
    type: string;
    name: string;
    taxIdNumber: string;
  };
}

interface BulkCreateResult {
  total: number;
  created: number;
  failed: number;
  errors: Array<{ key: string; error: string }>;
}

function buildCreateKeyXml(req: CreateKeyRequest): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CreateKeyRequest xmlns="urn:bcb:pix:dict:api:v2">
  <KeyType>${req.keyType}</KeyType>
  <Key>${req.key}</Key>
  <Account>
    <Participant>${req.account.participant}</Participant>
    <Branch>${req.account.branch}</Branch>
    <AccountNumber>${req.account.accountNumber}</AccountNumber>
    <AccountType>${req.account.accountType}</AccountType>
  </Account>
  <Owner>
    <Type>${req.owner.type}</Type>
    <Name>${req.owner.name}</Name>
    <TaxIdNumber>${req.owner.taxIdNumber}</TaxIdNumber>
  </Owner>
</CreateKeyRequest>`;
}

export async function bulkCreateKeys(
  client: IcomClient,
  ispb: string,
  keyType: DictKeyType,
  count: number,
  concurrency = 10,
): Promise<BulkCreateResult> {
  const result: BulkCreateResult = {
    total: count,
    created: 0,
    failed: 0,
    errors: [],
  };

  const keys: CreateKeyRequest[] = [];

  for (let i = 0; i < count; i++) {
    const isNatural = keyType === "CPF" || Math.random() > 0.3;
    const holder = isNatural ? generateNaturalPerson() : generateLegalPerson();
    const account = generateBankAccount(ispb, holder);
    const dictKey = generateDictKey(keyType, account);

    keys.push({
      keyType,
      key: dictKey.value,
      account: {
        participant: ispb.padStart(8, "0"),
        branch: account.branch,
        accountNumber: account.accountNumber,
        accountType: account.accountType,
      },
      owner: {
        type: holder.type === "NATURAL_PERSON" ? "NATURAL_PERSON" : "LEGAL_PERSON",
        name: holder.name,
        taxIdNumber: holder.document,
      },
    });
  }

  // Process in batches with concurrency limit
  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency);
    const promises = batch.map(async (keyReq) => {
      try {
        const xml = buildCreateKeyXml(keyReq);
        await client.sendMessage(xml);
        result.created++;
      } catch (err) {
        result.failed++;
        result.errors.push({
          key: keyReq.key,
          error: (err as Error).message,
        });
      }
    });

    await Promise.all(promises);

    if ((i + concurrency) % 100 === 0 || i + concurrency >= keys.length) {
      const progress = Math.min(i + concurrency, keys.length);
      console.log(
        `  Progress: ${progress}/${count} (created: ${result.created}, failed: ${result.failed})`,
      );
    }
  }

  return result;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const keyType = (process.argv[2] as DictKeyType) || "EVP";
  const count = parseInt(process.argv[3] || "10", 10);

  console.log(`=== DICT Key Bulk Creator ===`);
  console.log(`Key type: ${keyType}, Count: ${count}\n`);

  const requiredVars = ["PSP_ISPB", "MTLS_CERT_PATH", "MTLS_KEY_PATH", "MTLS_CA_PATH"];
  const missing = requiredVars.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("Copy config/homolog.env.example to .env and configure.\n");

    // Demo mode: just generate the XML payloads
    console.log("--- Demo Mode (generating sample XMLs) ---\n");
    const holder = generateNaturalPerson();
    const account = generateBankAccount("12345678", holder);
    const dictKey = generateDictKey(keyType, account);

    const xml = buildCreateKeyXml({
      keyType,
      key: dictKey.value,
      account: {
        participant: "12345678",
        branch: account.branch,
        accountNumber: account.accountNumber,
        accountType: account.accountType,
      },
      owner: {
        type: "NATURAL_PERSON",
        name: holder.name,
        taxIdNumber: holder.document,
      },
    });
    console.log(xml);
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

  bulkCreateKeys(client, ispb, keyType, count)
    .then((result) => {
      console.log("\n=== Results ===");
      console.log(`Total:   ${result.total}`);
      console.log(`Created: ${result.created}`);
      console.log(`Failed:  ${result.failed}`);
      if (result.errors.length > 0) {
        console.log("\nFirst 10 errors:");
        result.errors.slice(0, 10).forEach((e) => {
          console.log(`  ${e.key}: ${e.error}`);
        });
      }
      client.destroy();
    })
    .catch((err) => {
      console.error("Bulk create failed:", err.message);
      client.destroy();
      process.exit(1);
    });
}
