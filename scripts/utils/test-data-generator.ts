/**
 * Test Data Generator for Pix homologation.
 *
 * Generates complete test data sets including:
 * - Account holders (natural + legal persons)
 * - Bank accounts (checking, savings)
 * - DICT keys (all 5 types: CPF, CNPJ, email, phone, EVP)
 * - Transaction data (amounts, descriptions)
 *
 * All CPFs/CNPJs are generated with valid check digits.
 * All phone numbers follow Brazilian format (+55...).
 */

import { generateCpf, generateCnpj, formatCpf, formatCnpj } from "./cpf-cnpj-generator.js";
import { generateEndToEndId } from "./endtoendid-generator.js";
import { randomUUID } from "node:crypto";

export interface AccountHolder {
  type: "NATURAL_PERSON" | "LEGAL_PERSON";
  name: string;
  document: string;
  documentFormatted: string;
}

export interface BankAccount {
  ispb: string;
  branch: string;
  accountNumber: string;
  accountType: "CACC" | "SVGS"; // Checking or Savings
  holder: AccountHolder;
}

export type DictKeyType = "CPF" | "CNPJ" | "EMAIL" | "PHONE" | "EVP";

export interface DictKey {
  type: DictKeyType;
  value: string;
  account: BankAccount;
}

export interface TransactionData {
  endToEndId: string;
  amount: number;
  currency: string;
  description: string;
  debitParty: BankAccount;
  creditParty: BankAccount;
}

// Brazilian first/last names for realistic test data
const FIRST_NAMES = [
  "Ana", "Bruno", "Carlos", "Diana", "Eduardo", "Fernanda",
  "Gustavo", "Helena", "Igor", "Julia", "Kleber", "Larissa",
  "Marcos", "Natalia", "Oscar", "Patricia", "Rafael", "Sandra",
  "Thiago", "Vanessa",
];

const LAST_NAMES = [
  "Silva", "Santos", "Oliveira", "Souza", "Rodrigues", "Ferreira",
  "Alves", "Pereira", "Lima", "Gomes", "Costa", "Ribeiro",
  "Martins", "Carvalho", "Araujo", "Melo", "Barbosa", "Cardoso",
  "Nascimento", "Moreira",
];

const COMPANY_SUFFIXES = [
  "Tecnologia Ltda", "Comercio SA", "Servicos EIRELI",
  "Industria Ltda", "Pagamentos SA", "Financeira Ltda",
  "Digital SA", "Solucoes Ltda",
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateNaturalPerson(): AccountHolder {
  const cpf = generateCpf();
  return {
    type: "NATURAL_PERSON",
    name: `${randomItem(FIRST_NAMES)} ${randomItem(LAST_NAMES)}`,
    document: cpf,
    documentFormatted: formatCpf(cpf),
  };
}

export function generateLegalPerson(): AccountHolder {
  const cnpj = generateCnpj();
  return {
    type: "LEGAL_PERSON",
    name: `${randomItem(LAST_NAMES)} ${randomItem(COMPANY_SUFFIXES)}`,
    document: cnpj,
    documentFormatted: formatCnpj(cnpj),
  };
}

export function generateBankAccount(
  ispb: string,
  holder?: AccountHolder,
): BankAccount {
  return {
    ispb: ispb.padStart(8, "0"),
    branch: String(randomInt(1, 9999)).padStart(4, "0"),
    accountNumber: String(randomInt(10000, 9999999)),
    accountType: Math.random() > 0.3 ? "CACC" : "SVGS",
    holder: holder || (Math.random() > 0.3 ? generateNaturalPerson() : generateLegalPerson()),
  };
}

export function generateDictKey(
  type: DictKeyType,
  account: BankAccount,
): DictKey {
  let value: string;

  switch (type) {
    case "CPF":
      value = account.holder.type === "NATURAL_PERSON"
        ? account.holder.document
        : generateCpf();
      break;
    case "CNPJ":
      value = account.holder.type === "LEGAL_PERSON"
        ? account.holder.document
        : generateCnpj();
      break;
    case "EMAIL":
      value = `${account.holder.name.toLowerCase().replace(/\s+/g, ".")}${randomInt(1, 999)}@test.pix.com`;
      break;
    case "PHONE":
      value = `+5511${String(randomInt(900000000, 999999999))}`;
      break;
    case "EVP":
      value = randomUUID();
      break;
  }

  return { type, value, account };
}

export function generateTransactionData(
  senderIspb: string,
  receiverIspb: string,
): TransactionData {
  const debitParty = generateBankAccount(senderIspb);
  const creditParty = generateBankAccount(receiverIspb);

  return {
    endToEndId: generateEndToEndId(senderIspb),
    amount: randomInt(1, 100000) / 100, // R$ 0.01 to R$ 1,000.00
    currency: "BRL",
    description: `Pix test ${Date.now()}`,
    debitParty,
    creditParty,
  };
}

/**
 * Generate a batch of Bacen DICT email keys for capacity testing.
 * Bacen provides keys in format: cliente-NNNNNN@pix.bcb.gov.br
 */
export function generateBacenDictEmails(count: number, startIndex = 0): string[] {
  const emails: string[] = [];
  for (let i = startIndex; i < startIndex + count; i++) {
    emails.push(`cliente-${String(i).padStart(6, "0")}@pix.bcb.gov.br`);
  }
  return emails;
}

/**
 * Generate a batch of Bacen DICT phone keys for capacity testing.
 * Bacen provides keys in format: +5561900NNNNNN
 */
export function generateBacenDictPhones(count: number, startIndex = 0): string[] {
  const phones: string[] = [];
  for (let i = startIndex; i < startIndex + count; i++) {
    phones.push(`+5561900${String(i).padStart(6, "0")}`);
  }
  return phones;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const ispb = process.argv[2] || "12345678";
  const partnerIspb = process.argv[3] || "99999004";
  const count = parseInt(process.argv[4] || "3", 10);

  console.log(`=== Test Data Generator (ISPB: ${ispb}) ===\n`);

  console.log("--- Natural Persons ---");
  for (let i = 0; i < count; i++) {
    const holder = generateNaturalPerson();
    console.log(`  ${holder.name} | CPF: ${holder.documentFormatted}`);
  }

  console.log("\n--- Legal Persons ---");
  for (let i = 0; i < count; i++) {
    const holder = generateLegalPerson();
    console.log(`  ${holder.name} | CNPJ: ${holder.documentFormatted}`);
  }

  console.log("\n--- Bank Accounts ---");
  for (let i = 0; i < count; i++) {
    const account = generateBankAccount(ispb);
    console.log(
      `  ${account.holder.name} | ${account.branch}-${account.accountNumber} (${account.accountType})`,
    );
  }

  console.log("\n--- DICT Keys (all types) ---");
  const account = generateBankAccount(ispb);
  for (const type of ["CPF", "CNPJ", "EMAIL", "PHONE", "EVP"] as DictKeyType[]) {
    const key = generateDictKey(type, account);
    console.log(`  ${type}: ${key.value}`);
  }

  console.log("\n--- Transaction Data ---");
  for (let i = 0; i < count; i++) {
    const txn = generateTransactionData(ispb, partnerIspb);
    console.log(`  E2E: ${txn.endToEndId} | R$ ${txn.amount.toFixed(2)} | ${txn.description}`);
  }

  console.log("\n--- Bacen DICT Emails (sample) ---");
  const emails = generateBacenDictEmails(5);
  emails.forEach((e) => console.log(`  ${e}`));

  console.log("\n--- Bacen DICT Phones (sample) ---");
  const phones = generateBacenDictPhones(5);
  phones.forEach((p) => console.log(`  ${p}`));
}
