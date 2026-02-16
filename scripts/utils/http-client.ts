/**
 * ICOM HTTP Client for SPI/DICT communication.
 *
 * Key design decisions based on real homologation experience:
 * - TCP keepAlive with maxSockets: 50 (Bacen supports up to 6 polling connections)
 * - Separate agent pools for polling vs sending to avoid connection starvation
 * - gzip compression (Accept-Encoding: gzip)
 * - mTLS certificate authentication (required for RSFN network)
 * - Strict header whitelist: Bacen rejects requests with unknown headers
 *   (APM tools like DataDog/NewRelic inject headers that cause 403 errors)
 * - Retry with exponential backoff for transient 502/403 errors
 */

import https from "node:https";
import fs from "node:fs";
import zlib from "node:zlib";

export interface IcomClientConfig {
  baseUrl: string;
  ispb: string;
  certPath: string;
  keyPath: string;
  caPath: string;
  passphrase?: string;
  maxSockets?: number;
  keepAlive?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  body?: string;
  headers?: Record<string, string>;
  pool?: "poll" | "send";
}

interface IcomResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// Only these headers are safe to send to ICOM.
// Any additional headers (from APM, proxies, etc.) will cause 403 rejections.
const ALLOWED_HEADERS = new Set([
  "content-type",
  "accept",
  "accept-encoding",
  "content-encoding",
  "content-length",
  "pi-resource-id",
  "pi-pacs-version",
]);

export class IcomClient {
  private pollAgent: https.Agent;
  private sendAgent: https.Agent;
  private config: Required<IcomClientConfig>;

  constructor(config: IcomClientConfig) {
    this.config = {
      maxSockets: 50,
      keepAlive: true,
      timeoutMs: 30000,
      maxRetries: 3,
      passphrase: "",
      ...config,
    };

    const tlsOptions = {
      cert: fs.readFileSync(this.config.certPath),
      key: fs.readFileSync(this.config.keyPath),
      ca: fs.readFileSync(this.config.caPath),
      passphrase: this.config.passphrase || undefined,
    };

    // Separate connection pools prevent polling from starving send operations
    this.pollAgent = new https.Agent({
      ...tlsOptions,
      keepAlive: this.config.keepAlive,
      maxSockets: 6, // ICOM max polling connections
    });

    this.sendAgent = new https.Agent({
      ...tlsOptions,
      keepAlive: this.config.keepAlive,
      maxSockets: this.config.maxSockets,
    });
  }

  /**
   * Poll ICOM for incoming messages.
   * Returns XML messages from Bacen/partner PSPs.
   */
  async pollMessages(): Promise<IcomResponse> {
    return this.request({
      method: "GET",
      path: `/api/v1/in/${this.config.ispb}/msgs`,
      pool: "poll",
    });
  }

  /**
   * Send an XML message to ICOM.
   */
  async sendMessage(xml: string, pacsVersion?: string): Promise<IcomResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/xml",
    };
    if (pacsVersion) {
      headers["pi-pacs-version"] = pacsVersion;
    }

    return this.request({
      method: "POST",
      path: `/api/v1/out/${this.config.ispb}/msgs`,
      body: xml,
      headers,
      pool: "send",
    });
  }

  /**
   * Low-level request with retry, gzip, and strict header filtering.
   */
  private async request(opts: RequestOptions): Promise<IcomResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise((r) => setTimeout(r, delayMs));
      }

      try {
        return await this.doRequest(opts);
      } catch (err) {
        lastError = err as Error;
        const statusCode = (err as { statusCode?: number }).statusCode;
        // Only retry on transient errors
        if (statusCode && statusCode !== 502 && statusCode !== 503 && statusCode !== 429) {
          throw err;
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  private doRequest(opts: RequestOptions): Promise<IcomResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(opts.path, this.config.baseUrl);
      const agent = opts.pool === "poll" ? this.pollAgent : this.sendAgent;

      // Build headers — only whitelisted ones
      const headers: Record<string, string> = {
        accept: "application/xml",
        "accept-encoding": "gzip",
      };

      if (opts.body) {
        const compressed = zlib.gzipSync(Buffer.from(opts.body, "utf-8"));
        headers["content-encoding"] = "gzip";
        headers["content-length"] = String(compressed.length);
        headers["content-type"] = opts.headers?.["content-type"] || "application/xml";
      }

      // Merge custom headers, but filter to whitelist
      if (opts.headers) {
        for (const [key, value] of Object.entries(opts.headers)) {
          if (ALLOWED_HEADERS.has(key.toLowerCase())) {
            headers[key.toLowerCase()] = value;
          }
        }
      }

      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 16522,
          path: url.pathname,
          method: opts.method,
          agent,
          headers,
          timeout: this.config.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            const encoding = res.headers["content-encoding"];

            let body: string;
            if (encoding === "gzip") {
              body = zlib.gunzipSync(raw).toString("utf-8");
            } else {
              body = raw.toString("utf-8");
            }

            const statusCode = res.statusCode || 0;
            if (statusCode >= 400) {
              const err = Object.assign(new Error(`ICOM ${statusCode}: ${body}`), { statusCode });
              reject(err);
              return;
            }

            resolve({
              statusCode,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body,
            });
          });
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("Request timeout"));
      });

      if (opts.body) {
        const compressed = zlib.gzipSync(Buffer.from(opts.body, "utf-8"));
        req.write(compressed);
      }

      req.end();
    });
  }

  destroy(): void {
    this.pollAgent.destroy();
    this.sendAgent.destroy();
  }
}

// CLI usage - test connectivity
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("=== ICOM HTTP Client ===");
  console.log("This module exports the IcomClient class.");
  console.log("Configure via environment variables or psp-config.json.");
  console.log("\nUsage:");
  console.log("  import { IcomClient } from './http-client.js';");
  console.log("  const client = new IcomClient({ ... });");
  console.log("  const response = await client.pollMessages();");
}
