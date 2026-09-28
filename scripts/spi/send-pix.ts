/**
 * Single Pix Payment Sender.
 *
 * Sends one pacs.008 to the SPI through ICOM and reads the stream until the
 * pacs.002 for that EndToEndId arrives. Used for:
 * - SPI functionality testing (basic send/receive)
 * - Verifying connectivity before capacity tests
 * - Debugging individual transactions
 *
 * In homologation, ISPB 99999A04 (Bacen's virtual credit union) answers any
 * HIGH priority pacs.008 with ACSP.
 *
 * The SPI settles or rejects within 40s counted from AccptncDtTm (Manual de
 * Tempos do Pix); after that it rejects with AB03, so this script waits 40s.
 *
 * Usage:
 *   npx tsx scripts/spi/send-pix.ts [amount] [receiverIspb]
 */

import { IcomClient, type IcomClientConfig } from "../utils/http-client.js";
import { generatePacs008, type Pacs008Params } from "./pacs008-generator.js";
import { generateBankAccount } from "../utils/test-data-generator.js";
import { generateEndToEndId } from "../utils/endtoendid-generator.js";
import { generateBizMsgIdr } from "../utils/biz-message-id-generator.js";

/** End-to-end limit of the SPI primary channel. */
export const SETTLEMENT_LIMIT_MS = 40_000;

interface SendPixConfig {
  icomConfig: IcomClientConfig;
  senderIspb: string;
  receiverIspb: string;
  amount: number;
  description?: string;
}

export interface Pacs002Outcome {
  status: string;
  reason?: string;
  xml: string;
}

/** Extracts TxSts and the reason code of the pacs.002 for one EndToEndId. */
export function readPacs002(xml: string, endToEndId: string): Pacs002Outcome | undefined {
  if (!xml.includes("https://www.bcb.gov.br/pi/pacs.002/")) return undefined;
  if (!xml.includes(`<OrgnlEndToEndId>${endToEndId}</OrgnlEndToEndId>`)) return undefined;
  const status = /<TxSts>(\w+)<\/TxSts>/.exec(xml)?.[1] ?? "?";
  const reason = /<Rsn>\s*<Cd>(\w+)<\/Cd>/.exec(xml)?.[1];
  return { status, reason, xml };
}

export async function sendPix(config: SendPixConfig): Promise<{
  endToEndId: string;
  bizMsgIdr: string;
  resourceIds: string[];
  pacs002?: Pacs002Outcome;
}> {
  const client = new IcomClient(config.icomConfig);

  try {
    const debitAccount = generateBankAccount(config.senderIspb);
    const creditAccount = generateBankAccount(config.receiverIspb);
    const acceptedAt = new Date();

    const params: Pacs008Params = {
      senderIspb: config.senderIspb,
      receiverIspb: config.receiverIspb,
      amount: config.amount,
      endToEndId: generateEndToEndId(config.senderIspb, acceptedAt),
      bizMsgIdr: generateBizMsgIdr(config.senderIspb),
      acceptedAt,
      debitParty: {
        name: debitAccount.holder.name,
        document: debitAccount.holder.document,
        documentType: debitAccount.holder.type === "NATURAL_PERSON" ? "CPF" : "CNPJ",
        branch: debitAccount.branch,
        accountNumber: debitAccount.accountNumber,
        accountType: debitAccount.accountType,
      },
      creditParty: {
        document: creditAccount.holder.document,
        documentType: creditAccount.holder.type === "NATURAL_PERSON" ? "CPF" : "CNPJ",
        branch: creditAccount.branch,
        accountNumber: creditAccount.accountNumber,
        accountType: creditAccount.accountType,
      },
      description: config.description || "Pix test payment",
    };

    const xml = generatePacs008(params);
    const endToEndId = params.endToEndId!;
    console.log(`Sending pacs.008 | Amount: R$ ${config.amount.toFixed(2)}`);
    console.log(`  E2E ID: ${endToEndId}`);

    const { statusCode, resourceIds } = await client.sendMessages(xml);
    console.log(`  ICOM: ${statusCode} PI-ResourceId=${resourceIds.join(",")}`);

    const remaining = SETTLEMENT_LIMIT_MS - (Date.now() - acceptedAt.getTime());
    const messages = await client.readUntil((m) => readPacs002(m.xml, endToEndId) !== undefined, remaining);
    const pacs002 = messages
      .map((m) => readPacs002(m.xml, endToEndId))
      .find((o): o is Pacs002Outcome => o !== undefined);

    if (pacs002) {
      console.log(`  pacs.002: ${pacs002.status}${pacs002.reason ? ` (${pacs002.reason})` : ""}`);
    } else {
      console.log("  WARNING: no pacs.002 within the 40s settlement limit");
    }

    return { endToEndId, bizMsgIdr: params.bizMsgIdr!, resourceIds, pacs002 };
  } finally {
    client.destroy();
  }
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const amount = parseFloat(process.argv[2] || "1.00");
  const receiverIspb = process.argv[3] || "99999A04";

  console.log("=== Send Pix ===\n");
  console.log("This script requires mTLS certificates and ICOM connectivity.");
  console.log("Configure via .env or config/psp-config.json\n");

  const requiredVars = ["PSP_ISPB", "MTLS_CERT_PATH", "MTLS_KEY_PATH", "MTLS_CA_PATH"];
  const missing = requiredVars.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("Copy config/homolog.env.example to .env and configure.");
    process.exit(1);
  }

  const senderIspb = process.env.PSP_ISPB!;

  sendPix({
    icomConfig: {
      baseUrl: process.env.ICOM_BASE_URL || "https://icom-h.pi.rsfn.net.br:16522",
      ispb: senderIspb,
      certPath: process.env.MTLS_CERT_PATH!,
      keyPath: process.env.MTLS_KEY_PATH!,
      caPath: process.env.MTLS_CA_PATH!,
      passphrase: process.env.MTLS_PASSPHRASE,
    },
    senderIspb,
    receiverIspb,
    amount,
    description: `Test Pix R$ ${amount.toFixed(2)}`,
  }).catch((err) => {
    console.error("Failed to send Pix:", err.message);
    process.exit(1);
  });
}
