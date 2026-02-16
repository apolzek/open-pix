/**
 * CPF/CNPJ Generator with proper check-digit validation.
 *
 * Generates valid Brazilian CPF and CNPJ numbers for Pix homologation tests.
 * IMPORTANT: Always use validated documents — invalid check digits cause
 * silent failures in Bacen's test environment.
 */

function computeCpfDigits(base: number[]): [number, number] {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += base[i] * (10 - i);
  const d1 = sum % 11 < 2 ? 0 : 11 - (sum % 11);

  sum = 0;
  for (let i = 0; i < 9; i++) sum += base[i] * (11 - i);
  sum += d1 * 2;
  const d2 = sum % 11 < 2 ? 0 : 11 - (sum % 11);

  return [d1, d2];
}

function computeCnpjDigits(base: number[]): [number, number] {
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += base[i] * w1[i];
  const d1 = sum % 11 < 2 ? 0 : 11 - (sum % 11);

  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  sum = 0;
  for (let i = 0; i < 12; i++) sum += base[i] * w2[i];
  sum += d1 * w2[12];
  const d2 = sum % 11 < 2 ? 0 : 11 - (sum % 11);

  return [d1, d2];
}

export function generateCpf(): string {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  // Avoid all-same-digit CPFs (e.g. 111.111.111-11) which are technically invalid
  if (base.every((d) => d === base[0])) base[8] = (base[8] + 1) % 10;

  const [d1, d2] = computeCpfDigits(base);
  return [...base, d1, d2].join("");
}

export function generateCnpj(): string {
  const base = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10));
  // Branch number: 0001
  base.push(0, 0, 0, 1);
  const [d1, d2] = computeCnpjDigits(base);
  return [...base, d1, d2].join("");
}

export function validateCpf(cpf: string): boolean {
  const digits = cpf.replace(/\D/g, "");
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const base = digits.split("").map(Number);
  const [d1, d2] = computeCpfDigits(base.slice(0, 9));
  return base[9] === d1 && base[10] === d2;
}

export function validateCnpj(cnpj: string): boolean {
  const digits = cnpj.replace(/\D/g, "");
  if (digits.length !== 14) return false;

  const base = digits.split("").map(Number);
  const [d1, d2] = computeCnpjDigits(base.slice(0, 12));
  return base[12] === d1 && base[13] === d2;
}

export function formatCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function formatCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "");
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const count = parseInt(process.argv[2] || "5", 10);
  const type = process.argv[3] || "both";

  console.log("=== CPF/CNPJ Generator ===\n");

  if (type === "cpf" || type === "both") {
    console.log("CPFs:");
    for (let i = 0; i < count; i++) {
      const cpf = generateCpf();
      console.log(`  ${formatCpf(cpf)} (raw: ${cpf}, valid: ${validateCpf(cpf)})`);
    }
  }

  if (type === "cnpj" || type === "both") {
    console.log("\nCNPJs:");
    for (let i = 0; i < count; i++) {
      const cnpj = generateCnpj();
      console.log(`  ${formatCnpj(cnpj)} (raw: ${cnpj}, valid: ${validateCnpj(cnpj)})`);
    }
  }
}
