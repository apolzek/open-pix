/**
 * HTTP clients for the Pix RSFN interfaces.
 *
 * IcomClient follows the Manual das Interfaces de Comunicacao 1.12 (ICOM):
 * - Send:    POST /api/v1/in/{ispb}/msgs       ("in" is the SPI's inbox)
 *            One message as application/xml, or up to 10 as multipart/mixed.
 *            201 Created + PI-ResourceId (comma separated for multipart).
 * - Receive: GET  /api/v1/out/{ispb}/stream/start
 *            then GET the path in PI-Pull-Next, repeatedly (long polling:
 *            200 with messages or 204 after some seconds without them),
 *            and finally DELETE the last PI-Pull-Next to confirm the reads.
 *            Accept: multipart/mixed returns up to 10 messages per response.
 * - Catalog: GET /api/v1/in/catalog and /api/v1/out/catalog
 * - Up to 6 simultaneous read streams per participant and channel; above
 *   that the API answers 429.
 * - gzip in Content-Encoding is mandatory to support and recommended on the
 *   primary channel.
 *
 * DictClient follows the DICT API 2.12.1 (base /api/v2/). The DICT does not
 * accept compressed request bodies, only compressed responses.
 *
 * Both interfaces:
 * - mTLS with the participant's RSFN certificate.
 * - Host header without the port (a port in Host may break the connection).
 * - Only a fixed set of headers is accepted; APM agents that inject tracing
 *   headers get requests refused.
 * - Errors are RFC 7807 problems in XML (application/problem+xml).
 */

import https from "node:https";
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

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
  /** Compress request bodies with gzip. Always false for the DICT. */
  gzipRequests?: boolean;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface ReceivedMessage {
  resourceId?: string;
  xml: string;
}

export interface StreamRead {
  statusCode: 200 | 204;
  messages: ReceivedMessage[];
  /** Path for the next read, or for the final DELETE. */
  pullNext: string;
}

/**
 * Headers the ICOM accepts (section 2.1.8). The DICT adds its own PI-*
 * headers, listed in DICT_HEADERS.
 */
const ICOM_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "max-forwards",
  "transfer-encoding",
  "user-agent",
  "via",
]);

const DICT_HEADERS = new Set(["pi-requestingparticipant", "pi-payerid", "pi-endtoendid"]);

export const XML_CONTENT_TYPE = "application/xml; charset=utf-8";
export const MAX_MESSAGES_PER_REQUEST = 10;
export const MAX_READ_STREAMS = 6;

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`HTTP ${statusCode}: ${body}`);
    this.name = "HttpError";
  }
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  pool?: "poll" | "send";
  /** Status codes that are not errors for this call. */
  okStatus?: number[];
}

class RsfnClient {
  protected pollAgent: https.Agent;
  protected sendAgent: https.Agent;
  protected config: Required<IcomClientConfig>;
  protected extraHeaders = new Set<string>();

  constructor(config: IcomClientConfig) {
    this.config = {
      maxSockets: 50,
      keepAlive: true,
      timeoutMs: 30000,
      maxRetries: 3,
      passphrase: "",
      gzipRequests: true,
      ...config,
    };

    const tlsOptions = {
      cert: fs.readFileSync(this.config.certPath),
      key: fs.readFileSync(this.config.keyPath),
      ca: fs.readFileSync(this.config.caPath),
      passphrase: this.config.passphrase || undefined,
    };

    // Reads use long polling and hold connections open; a separate pool keeps
    // them from starving sends.
    this.pollAgent = new https.Agent({
      ...tlsOptions,
      keepAlive: this.config.keepAlive,
      maxSockets: MAX_READ_STREAMS,
    });

    this.sendAgent = new https.Agent({
      ...tlsOptions,
      keepAlive: this.config.keepAlive,
      maxSockets: this.config.maxSockets,
    });
  }

  protected get ispb(): string {
    return this.config.ispb;
  }

  /** Request with retry on 429/502/503, honoring Retry-After. */
  protected async request(opts: RequestOptions): Promise<HttpResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await this.doRequest(opts);
      } catch (err) {
        lastError = err as Error;
        const statusCode = (err as HttpError).statusCode;
        if (statusCode && ![429, 502, 503].includes(statusCode)) throw err;
        if (attempt === this.config.maxRetries) break;
        const retryAfter = (err as HttpError).retryAfterSeconds;
        const delayMs = retryAfter !== undefined
          ? retryAfter * 1000
          : Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  private doRequest(opts: RequestOptions): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(opts.path, this.config.baseUrl);
      const agent = opts.pool === "poll" ? this.pollAgent : this.sendAgent;

      const headers: Record<string, string> = {
        host: url.hostname,
        "accept-encoding": "gzip",
      };

      for (const [key, value] of Object.entries(opts.headers ?? {})) {
        const name = key.toLowerCase();
        if (ICOM_HEADERS.has(name) || this.extraHeaders.has(name)) {
          headers[name] = value;
        }
      }

      let payload: Buffer | undefined;
      if (opts.body !== undefined) {
        payload = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, "utf-8");
        if (this.config.gzipRequests) {
          payload = zlib.gzipSync(payload);
          headers["content-encoding"] = "gzip";
        }
        headers["content-length"] = String(payload.length);
        headers["content-type"] ??= XML_CONTENT_TYPE;
      }

      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
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
            let body: string;
            try {
              body = res.headers["content-encoding"] === "gzip"
                ? zlib.gunzipSync(raw).toString("utf-8")
                : raw.toString("utf-8");
            } catch (err) {
              reject(err);
              return;
            }

            const statusCode = res.statusCode || 0;
            if (statusCode >= 400 && !opts.okStatus?.includes(statusCode)) {
              const retryAfter = Number(res.headers["retry-after"]);
              reject(new HttpError(statusCode, body, Number.isFinite(retryAfter) ? retryAfter : undefined));
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

      if (payload) req.write(payload);
      req.end();
    });
  }

  destroy(): void {
    this.pollAgent.destroy();
    this.sendAgent.destroy();
  }
}

function header(res: HttpResponse, name: string): string | undefined {
  const value = res.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : value;
}

/** Builds a multipart/mixed body with one application/xml part per message. */
export function buildMultipart(messages: string[], boundary = crypto.randomBytes(12).toString("hex")): {
  contentType: string;
  body: string;
} {
  const parts = messages.map(
    (xml) => `--${boundary}\r\nContent-Type: ${XML_CONTENT_TYPE}\r\n\r\n${xml}\r\n`,
  );
  return {
    contentType: `multipart/mixed; boundary="${boundary}"`,
    body: `${parts.join("")}--${boundary}--\r\n`,
  };
}

/** Splits a multipart/mixed body, keeping the PI-ResourceId of each part. */
export function parseMultipart(body: string, contentType: string): ReceivedMessage[] {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) throw new Error(`multipart without boundary: ${contentType}`);
  const boundary = match[1] ?? match[2];

  const messages: ReceivedMessage[] = [];
  for (const chunk of body.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith("--")) break;
    const part = chunk.replace(/^\r?\n/, "");
    const sep = part.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const head = part.slice(0, sep);
    const xml = part.slice(sep).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    const resourceId = /^PI-ResourceId:\s*(.+)$/im.exec(head)?.[1]?.trim();
    messages.push({ resourceId, xml });
  }
  return messages;
}

export class IcomClient extends RsfnClient {
  /**
   * Sends one or more messages to the SPI (POST /api/v1/in/{ispb}/msgs).
   * Returns the PI-ResourceId of each stored message.
   */
  async sendMessages(xml: string | string[]): Promise<{ statusCode: number; resourceIds: string[] }> {
    const messages = Array.isArray(xml) ? xml : [xml];
    if (messages.length === 0 || messages.length > MAX_MESSAGES_PER_REQUEST) {
      throw new Error(`Send between 1 and ${MAX_MESSAGES_PER_REQUEST} messages per request`);
    }

    let body = messages[0];
    let contentType = XML_CONTENT_TYPE;
    if (messages.length > 1) {
      ({ body, contentType } = buildMultipart(messages));
    }

    const res = await this.request({
      method: "POST",
      path: `/api/v1/in/${this.ispb}/msgs`,
      body,
      headers: { "content-type": contentType },
      pool: "send",
    });

    const ids = header(res, "pi-resourceid");
    return { statusCode: res.statusCode, resourceIds: ids ? ids.split(",").map((s) => s.trim()) : [] };
  }

  /** Kept for existing callers; prefer sendMessages. */
  async sendMessage(xml: string): Promise<HttpResponse> {
    const { statusCode, resourceIds } = await this.sendMessages(xml);
    return { statusCode, headers: { "pi-resourceid": resourceIds.join(",") }, body: "" };
  }

  /**
   * Reads the next batch of messages. Pass the PI-Pull-Next of the previous
   * read, or nothing to open a new stream.
   */
  async readStream(pullNext?: string, multipart = true): Promise<StreamRead> {
    const res = await this.request({
      method: "GET",
      path: pullNext ?? `/api/v1/out/${this.ispb}/stream/start`,
      headers: { accept: multipart ? "multipart/mixed" : "application/xml" },
      pool: "poll",
    });

    const next = header(res, "pi-pull-next");
    if (!next) throw new Error(`ICOM answered ${res.statusCode} without PI-Pull-Next`);

    if (res.statusCode === 204) {
      return { statusCode: 204, messages: [], pullNext: next };
    }

    const contentType = header(res, "content-type") ?? "";
    const messages = contentType.startsWith("multipart/")
      ? parseMultipart(res.body, contentType)
      : [{ resourceId: header(res, "pi-resourceid"), xml: res.body }];

    return { statusCode: 200, messages, pullNext: next };
  }

  /**
   * Ends a read stream and confirms the messages already delivered.
   * Skipping it causes duplicate or delayed deliveries.
   */
  async closeStream(pullNext: string): Promise<void> {
    await this.request({ method: "DELETE", path: pullNext, pool: "poll", okStatus: [410] });
  }

  /**
   * Convenience loop: reads until `until` returns true or the deadline
   * passes, then closes the stream. Returns every message read.
   */
  async readUntil(
    until: (msg: ReceivedMessage) => boolean,
    timeoutMs: number,
  ): Promise<ReceivedMessage[]> {
    const deadline = Date.now() + timeoutMs;
    const received: ReceivedMessage[] = [];
    let pullNext: string | undefined;
    try {
      while (Date.now() < deadline) {
        const read: StreamRead = await this.readStream(pullNext);
        pullNext = read.pullNext;
        received.push(...read.messages);
        if (read.messages.some(until)) break;
      }
    } finally {
      if (pullNext) await this.closeStream(pullNext);
    }
    return received;
  }

  async catalog(direction: "in" | "out"): Promise<string[]> {
    const res = await this.request({ method: "GET", path: `/api/v1/${direction}/catalog`, pool: "send" });
    return [...res.body.matchAll(/<Message>([^<]+)<\/Message>/g)].map((m) => m[1]);
  }
}

export interface DictRequestOptions {
  /** PI-PayerId: CPF/CNPJ of the payer, required on getEntry (rate limiting). */
  payerId?: string;
  /** PI-EndToEndId of the payment being prepared, required on getEntry. */
  endToEndId?: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Status codes returned instead of thrown, e.g. [404] on lookups. */
  okStatus?: number[];
}

export class DictClient extends RsfnClient {
  constructor(config: IcomClientConfig) {
    super({ ...config, gzipRequests: false });
    for (const h of DICT_HEADERS) this.extraHeaders.add(h);
  }

  /**
   * Calls the DICT API. `path` is relative to /api/v2, e.g. "/entries/".
   * Write operations must carry an XMLDSig in <Signature> (Manual de
   * Seguranca do Pix); this client does not sign.
   */
  async call(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: string,
    opts: DictRequestOptions = {},
  ): Promise<HttpResponse> {
    const url = new URL(`/api/v2${path}`, "http://x");
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      accept: "application/xml",
      "pi-requestingparticipant": this.ispb,
    };
    if (opts.payerId) headers["pi-payerid"] = opts.payerId;
    if (opts.endToEndId) headers["pi-endtoendid"] = opts.endToEndId;

    return this.request({
      method,
      path: url.pathname + url.search,
      body,
      headers,
      pool: "send",
      okStatus: opts.okStatus,
    });
  }
}

// CLI usage - print the protocol summary
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("=== RSFN HTTP clients ===");
  console.log("IcomClient: sendMessages, readStream, closeStream, readUntil, catalog");
  console.log("DictClient: call(method, '/entries/...', xml, { payerId, endToEndId })");
  console.log("\nUsage:");
  console.log("  import { IcomClient } from './http-client.js';");
  console.log("  const client = new IcomClient({ baseUrl: 'https://icom-h.pi.rsfn.net.br:16522', ... });");
  console.log("  const { resourceIds } = await client.sendMessages(xml);");
  console.log("  const msgs = await client.readUntil((m) => m.xml.includes('pacs.002'), 40_000);");
}
