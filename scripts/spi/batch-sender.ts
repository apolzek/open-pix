/**
 * Batch Pix Sender - HTTP endpoint for k6 load tests.
 *
 * Starts a lightweight HTTP server that k6 calls to send Pix payments.
 * Each request generates a unique pacs.008 and sends it via ICOM.
 *
 * Architecture for SPI capacity test:
 * - k6 generates 2,000 requests/minute for 10 minutes
 * - This server receives requests and forwards to ICOM
 * - Multiple pods/workers recommended to avoid event loop blocking
 *
 * PITFALL: A single Node.js process will hit event loop limits around
 * 800-1000 concurrent XML generations. Use multiple pods or worker_threads.
 *
 * Usage:
 *   npx tsx scripts/spi/batch-sender.ts [port]
 */

import http from "node:http";
import { generatePacs008, type Pacs008Params, type PacsVersion } from "./pacs008-generator.js";
import { IcomClient } from "../utils/http-client.js";
import { generateBankAccount } from "../utils/test-data-generator.js";

interface BatchStats {
  sent: number;
  accepted: number;
  rejected: number;
  errors: number;
  startTime: number;
}

const stats: BatchStats = {
  sent: 0,
  accepted: 0,
  rejected: 0,
  errors: 0,
  startTime: 0,
};

function createServer(client: IcomClient, senderIspb: string, receiverIspb: string) {
  return http.createServer(async (req, res) => {
    // Stats endpoint
    if (req.url === "/stats") {
      const elapsed = stats.startTime ? (Date.now() - stats.startTime) / 1000 : 0;
      const rate = elapsed > 0 ? (stats.sent / elapsed) * 60 : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...stats,
        elapsedSeconds: Math.round(elapsed),
        ratePerMinute: Math.round(rate),
      }));
      return;
    }

    // Reset endpoint
    if (req.url === "/reset") {
      stats.sent = 0;
      stats.accepted = 0;
      stats.rejected = 0;
      stats.errors = 0;
      stats.startTime = Date.now();
      res.writeHead(200);
      res.end("Reset");
      return;
    }

    // Health check
    if (req.url === "/health") {
      res.writeHead(200);
      res.end("OK");
      return;
    }

    // Send Pix endpoint
    if (req.method === "POST" && req.url === "/send") {
      if (!stats.startTime) stats.startTime = Date.now();

      try {
        let body = "";
        for await (const chunk of req) body += chunk;

        const params = body ? JSON.parse(body) : {};
        const amount = params.amount || (Math.floor(Math.random() * 10000) + 1) / 100;
        const version: PacsVersion = params.version || "1.13";

        const debitAccount = generateBankAccount(senderIspb);
        const creditAccount = generateBankAccount(receiverIspb);

        const pacs008Params: Pacs008Params = {
          senderIspb,
          receiverIspb,
          amount,
          version,
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
        };

        const xml = generatePacs008(pacs008Params);
        const response = await client.sendMessage(xml, `pacs.008.spi.${version}`);

        stats.sent++;

        if (response.statusCode >= 200 && response.statusCode < 300) {
          stats.accepted++;
        } else {
          stats.rejected++;
        }

        res.writeHead(response.statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: response.statusCode,
          sent: stats.sent,
        }));
      } catch (err) {
        stats.errors++;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not Found. Endpoints: POST /send, GET /stats, GET /health, GET /reset");
  });
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.argv[2] || "3100", 10);

  console.log("=== Batch Pix Sender ===\n");

  const requiredVars = ["PSP_ISPB", "MTLS_CERT_PATH", "MTLS_KEY_PATH", "MTLS_CA_PATH"];
  const missing = requiredVars.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("Copy config/homolog.env.example to .env and configure.");
    process.exit(1);
  }

  const senderIspb = process.env.PSP_ISPB!;
  const receiverIspb = process.env.BACEN_SPI_ISPB || "99999004";

  const client = new IcomClient({
    baseUrl: process.env.ICOM_BASE_URL || "https://icom-h.pi.rsfn.net.br:16522",
    ispb: senderIspb,
    certPath: process.env.MTLS_CERT_PATH!,
    keyPath: process.env.MTLS_KEY_PATH!,
    caPath: process.env.MTLS_CA_PATH!,
    passphrase: process.env.MTLS_PASSPHRASE,
  });

  const server = createServer(client, senderIspb, receiverIspb);

  server.listen(port, () => {
    console.log(`Batch sender listening on http://localhost:${port}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /send     - Send a Pix payment`);
    console.log(`  GET  /stats    - View send statistics`);
    console.log(`  GET  /health   - Health check`);
    console.log(`  GET  /reset    - Reset statistics`);
    console.log(`\nk6 command:`);
    console.log(`  k6 run scripts/spi/k6-spi-capacity.js`);
  });

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    console.log(`Final stats: ${JSON.stringify(stats)}`);
    client.destroy();
    server.close();
    process.exit(0);
  });
}
