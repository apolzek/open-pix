/**
 * Single Pix Payment Sender.
 *
 * Sends a single pacs.008 message to ICOM and waits for the pacs.002 response.
 * Used for:
 * - SPI functionality testing (basic send/receive)
 * - Verifying connectivity before capacity tests
 * - Debugging individual transactions
 *
 * Usage:
 *   npx tsx scripts/spi/send-pix.ts [amount] [receiverIspb]
 */

import { IcomClient, type IcomClientConfig } from "../utils/http-client.js";
import { generatePacs008, type Pacs008Params } from "./pacs008-generator.js";
import { generateBankAccount } from "../utils/test-data-generator.js";

interface SendPixConfig {
  icomConfig: IcomClientConfig;
  senderIspb: string;
  receiverIspb: string;
  amount: number;
  description?: string;
}

export async function sendPix(config: SendPixConfig): Promise<{
  endToEndId: string;
  bizMsgIdr: string;
  sendResponse: { statusCode: number; body: string };
  pacs002Response?: { statusCode: number; body: string };
}> {
  const client = new IcomClient(config.icomConfig);

  try {
    const debitAccount = generateBankAccount(config.senderIspb);
    const creditAccount = generateBankAccount(config.receiverIspb);

    const params: Pacs008Params = {
      senderIspb: config.senderIspb,
      receiverIspb: config.receiverIspb,
      amount: config.amount,
      debitParty: {
        name: debitAccount.holder.name,
        document: debitAccount.holder.document,
        documentType: debitAccount.holder.type === "NATURAL_PERSON" ? "CPF" : "CNPJ",
        branch: debitAccount.branch,
        accountNumber: debitAccount.accountNumber,
        accountType: debitAccount.accountType,
      },
      creditParty: {
        name: creditAccount.holder.name,
        document: creditAccount.holder.document,
        documentType: creditAccount.holder.type === "NATURAL_PERSON" ? "CPF" : "CNPJ",
        branch: creditAccount.branch,
        accountNumber: creditAccount.accountNumber,
        accountType: creditAccount.accountType,
      },
      description: config.description || "Pix test payment",
    };

    const xml = generatePacs008(params);
    console.log(`Sending pacs.008 | Amount: R$ ${config.amount.toFixed(2)}`);
    console.log(`  E2E ID: ${params.endToEndId || "(auto-generated)"}`);

    const sendResponse = await client.sendMessage(xml);
    console.log(`  Send response: ${sendResponse.statusCode}`);

    // Wait for pacs.002 response (poll for up to 15 seconds)
    let pacs002Response;
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      try {
        const pollResponse = await client.pollMessages();
        if (pollResponse.body && pollResponse.body.includes("pacs.002")) {
          pacs002Response = pollResponse;
          console.log(`  pacs.002 received: ${pollResponse.statusCode}`);

          if (pollResponse.body.includes("ACSP")) {
            console.log("  Status: ACCEPTED");
          } else if (pollResponse.body.includes("RJCT")) {
            console.log("  Status: REJECTED");
          }
          break;
        }
      } catch {
        // No messages yet, keep polling
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!pacs002Response) {
      console.log("  WARNING: No pacs.002 received within 15s (possible AB03 timeout)");
    }

    return {
      endToEndId: params.endToEndId || "auto",
      bizMsgIdr: params.bizMsgIdr || "auto",
      sendResponse: { statusCode: sendResponse.statusCode, body: sendResponse.body },
      pacs002Response: pacs002Response
        ? { statusCode: pacs002Response.statusCode, body: pacs002Response.body }
        : undefined,
    };
  } finally {
    client.destroy();
  }
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const amount = parseFloat(process.argv[2] || "1.00");
  const receiverIspb = process.argv[3] || "99999004";

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
