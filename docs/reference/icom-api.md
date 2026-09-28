# ICOM API Reference

Reference documentation for the ICOM (Interface de Comunicacao) API used by Pix Direct Participants to exchange ISO 20022 messages with the SPI (Sistema de Pagamentos Instantaneos). Based on the *Manual das Interfaces de Comunicacao* 1.12 (see [Sources](#sources)).

ICOM is the communication layer between PSPs and Bacen's SPI. All message exchange -- sending pacs.008, pacs.002, pacs.004, and receiving the same -- flows through ICOM. The PSP never exposes an HTTP server: it always **sends** with `POST` to the SPI's input (`/in`) and **pulls** its messages from the SPI's output (`/out`).

---

## Overview

| Environment | Channel | Base URL |
|-------------|---------|----------|
| Homologation | Primary | `https://icom-h.pi.rsfn.net.br:16522` |
| Homologation | Secondary | `https://icom-sec-h.pi.rsfn.net.br:17522` |
| Production | Primary | `https://icom.pi.rsfn.net.br:16422` |
| Production | Secondary | `https://icom-sec.pi.rsfn.net.br:17422` |

- **Primary channel:** orders the user expects to settle immediately (regular Pix, returns). **Secondary channel:** scheduled payments, large batches.
- **Authentication:** mTLS (TLS 1.2, mutual authentication mandatory) with an ICP-Brasil certificate in the SPB standard. Cipher suite `ECDHE-RSA-AES-128-GCM-SHA256` (0xc02f) must be supported.
- **Network:** RSFN (private financial network). Respect DNS TTLs: Bacen may re-point names or use DNS round-robin.
- **Protocol:** HTTP/1.1
- **Encoding:** XML in UTF-8; every request with a body carries `Content-Type: application/xml; charset=utf-8` (otherwise 415).

---

## Endpoints

| Operation | Method and path |
|-----------|-----------------|
| Send one or more messages to the SPI | `POST /api/v1/in/{ispb}/msgs` |
| Open a read stream | `GET /api/v1/out/{ispb}/stream/start` |
| Continue reading | `GET {PI-Pull-Next}` |
| Close the stream (confirm reads) | `DELETE {PI-Pull-Next}` |
| Message versions accepted on input | `GET /api/v1/in/catalog` |
| Message versions sent on output | `GET /api/v1/out/catalog` |

`{ispb}` is always **your own** ISPB (8 characters, `[0-9A-Z]{8}`). There is no `GET /api/v1/in/{ispb}/msgs` polling endpoint and no `/api/v1/out/{ispb}/msgs`.

### Send Messages

Sends one or more ISO 20022 messages (pacs.008, pacs.002, pacs.004, etc.) to the SPI.

**URL:** `POST /api/v1/in/{ispb}/msgs`

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/xml; charset=utf-8` for one message; `multipart/mixed; boundary=...` for up to 10 messages (each part with `Content-Type: application/xml; charset=utf-8`) |
| `Content-Length` or `Transfer-Encoding: chunked` | Yes | Otherwise 411 |
| `Content-Encoding` | No | `gzip` if the body is compressed (mandatory on the secondary channel) |
| `Host` | Yes | Host name **without the port** |

**Request Body:** the SPI message `Envelope` (AppHdr + Document), see [ISO Messages](iso-messages.md). ICOM does not validate syntax or signature at this point; it stores the message for processing. Validation errors come back later as an asynchronous message from the SPI.

**Response:**

| Status | Description |
|--------|-------------|
| 201 | Stored. `PI-ResourceId` carries the id of each stored message (comma separated for multipart) |
| 4xx | PSP error. **Nothing was stored.** Fix and resend if appropriate |
| 429 | Token bucket exhausted, see [Rate Limiting](#rate-limiting-token-bucket). Honor `Retry-After` |
| 503 | Too many simultaneous connections, or connections opened/closed too often. Nothing stored |
| other 5xx | API error. The message(s) may or may not have been stored; resend (the SPI handles duplicates by its idempotency rules) |

Example:

```
POST /api/v1/in/11111111/msgs HTTP/1.1
Host: icom-h.pi.rsfn.net.br
Content-Type: application/xml; charset=utf-8
Content-Encoding: gzip
Content-Length: 1234

[gzip-compressed XML]

HTTP/1.1 201 Created
PI-ResourceId: UEkBbgR78VqKK/uvuq9O0r9bqXyBH9Ur
```

---

### Receive Messages (stream)

Receiving is a long-polling stream. The PSP opens it, keeps following the `PI-Pull-Next` header, and closes it with `DELETE`.

1. **Open:** `GET /api/v1/out/{ispb}/stream/start`
2. **Response:**
   - **200** with one message (`Accept: application/xml` or no `Accept`) or up to **10** messages (`Accept: multipart/mixed`). `PI-ResourceId` identifies the message (in multipart, each part carries its own `PI-ResourceId`).
   - **204** after "some seconds" without messages (long polling -- the API holds the request instead of answering immediately).
   - Both 200 and 204 carry **`PI-Pull-Next`**: the path (relative or absolute) for the next read. Do not assume any format for it.
3. **Continue:** `GET` the exact `PI-Pull-Next` from the immediately previous response. Repeat while you want to keep reading. Not following `PI-Pull-Next` causes errors and excessive duplicates.
4. **Close:** `DELETE` the last `PI-Pull-Next`. Returns 200 or 410 (both are success). The DELETE also **confirms that the last delivered messages were stored** -- skipping it causes duplicates or delayed deliveries.

```
GET /api/v1/out/11111111/stream/start HTTP/1.1
Accept: multipart/mixed
Accept-Encoding: gzip

HTTP/1.1 200 OK
PI-Pull-Next: /api/v1/out/11111111/stream/f0d744d792d6
Content-Type: multipart/mixed; boundary="simple boundary"
...

GET /api/v1/out/11111111/stream/f0d744d792d6 HTTP/1.1
...
HTTP/1.1 204 No Content
PI-Pull-Next: /api/v1/out/11111111/stream/e839cf0015bb

DELETE /api/v1/out/11111111/stream/e839cf0015bb HTTP/1.1
HTTP/1.1 200 OK
```

**Duplicates:** a message can occasionally be delivered again even when the PSP follows `PI-Pull-Next` correctly. It keeps the same ResourceId -- deduplicate by it.

**Simultaneous reads:** each parallel consumer opens its own stream with `GET .../stream/start`. Limit: **6 read streams per participant per channel**; above that the API answers **429**.

Using the toolkit client (`scripts/utils/http-client.ts`):

```ts
import { IcomClient } from "../scripts/utils/http-client.js";

const client = new IcomClient({
  baseUrl: "https://icom-h.pi.rsfn.net.br:16522",
  ispb: "12345678",
  certPath: "/path/to/client-cert.pem",
  keyPath: "/path/to/client-key.pem",
  caPath: "/path/to/bacen-ca.pem",
});

// Send (1 message, or an array of up to 10 -> multipart/mixed)
const { resourceIds } = await client.sendMessages(xml);

// Manual stream loop
let read = await client.readStream();          // GET .../stream/start
while (running) {
  for (const msg of read.messages) store(msg); // dedupe by msg.resourceId
  read = await client.readStream(read.pullNext);
}
await client.closeStream(read.pullNext);       // DELETE, confirms the reads

// Or: read until a condition, then close the stream
const msgs = await client.readUntil((m) => m.xml.includes(endToEndId), 40_000);
```

---

### Catalog

`GET /api/v1/in/catalog` lists the message versions ICOM accepts on input; `GET /api/v1/out/catalog` lists the versions it sends. Both return XML:

```xml
<Catalog>
    <Message>pacs.002.spi.1.17</Message>
    <Message>pacs.004.spi.1.5</Message>
    <Message>pacs.008.spi.1.16</Message>
    ...
</Catalog>
```

(The values above are the catalog 5.13 versions; the live response is authoritative.) If the SPI answers "Schema desconhecido ou nao habilitado para uso", the `MsgDefIdr`/namespace version you sent is not enabled -- check the catalog instead of guessing a version. Toolkit: `await client.catalog("in")`.

---

## Connection Limits

| Connection Type | Limit |
|-----------------|-------|
| Read streams | **6** per participant per channel (429 above that) |
| Sending | No fixed number published; too many simultaneous connections, or opening/closing connections too often, causes **503** |

**Critical:** Do not exceed 6 concurrent read streams. Prefer persistent connections (RFC 7230 section 6.3).

---

## mTLS Requirements

All ICOM communication requires mutual TLS (mTLS):

1. **Client Certificate:** ICP-Brasil certificate in the SPB standard, generated as specified in the *Manual de Seguranca do SFN*. It identifies your institution by its ISPB.

2. **CA Certificate:** You must trust Bacen's CA certificate chain for server verification.

3. **Configuration Example (Node.js):**

```js
const https = require('https');
const fs = require('fs');

const agent = new https.Agent({
  cert: fs.readFileSync('/path/to/client-cert.pem'),
  key: fs.readFileSync('/path/to/client-key.pem'),
  ca: fs.readFileSync('/path/to/bacen-ca.pem'),
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
});
```

4. **Certificate Renewal:** Monitor certificate expiration dates. Certificates have a limited validity period and must be renewed before they expire.

---

## URL Format

```
https://{host}:{port}/api/v1/in/{ispb}/msgs              (send)
https://{host}:{port}/api/v1/out/{ispb}/stream/start     (receive)
https://{host}:{port}/api/v1/in/catalog                  (catalog)
```

See the [Overview](#overview) table for hosts and ports. The `Host` header must be sent **without the port** (`Host: icom-h.pi.rsfn.net.br`); sending the port may break the connection.

---

## Gzip Compression

Support for gzip is **mandatory** for both the PSP and the API. Using it is recommended on the primary channel and **mandatory on the secondary channel**.

### Sending Compressed Requests

```
Content-Type: application/xml; charset=utf-8
Content-Encoding: gzip
Body: [gzip-compressed XML]
```

Use `Content-Encoding: gzip`. `Transfer-Encoding` with `gzip, chunked` is not supported.

### Receiving Compressed Responses

```
Accept-Encoding: gzip
```

When `Accept-Encoding: gzip` is sent, ICOM may return gzip-compressed responses with the `Content-Encoding: gzip` header. With multipart, the whole response is compressed.

**Node.js Considerations:**
- `axios` automatically decompresses gzip responses by default.
- Raw `https` module does NOT auto-decompress. You must pipe through `zlib.createGunzip()` (or `gunzipSync`, as `IcomClient` does).
- When sending gzip requests, compress the full XML body using `zlib.gzipSync()` before sending.

---

## Multipart Messages

Multipart (`multipart/mixed`) works in both directions, with at most **10 messages** per request or response.

### Handling Multipart Responses

1. Request it with `Accept: multipart/mixed` on every read.

2. Check the `Content-Type` header for the boundary:
   ```
   Content-Type: multipart/mixed; boundary="simple boundary"
   ```

3. Parse each part as a separate message; each part carries its own `PI-ResourceId`.

4. Process ALL parts from the response. Do not stop after the first message.

5. The API answers as soon as at least one message is available -- it does not wait to accumulate. With low volume, many multipart responses carry a single message.

**Common Mistake:** Processing only the first message in a multipart response and missing subsequent messages. See [Known Pitfalls](../playbook/pitfalls.md#4-single-message-reads-instead-of-multipart-streams).

---

## Header Whitelist

The API may refuse a request carrying headers other than those listed in the ICOM manual (section 2.1.8).

### Allowed Headers

- `Accept` -- if present, only `application/xml`, `multipart/mixed` or `*/*`
- `Accept-Encoding` -- if present, only `gzip`
- `Connection`
- `Content-Encoding`
- `Content-Length`
- `Content-Type`
- `Cookie`
- `Host` (without port)
- `Max-Forwards`
- `Transfer-Encoding`
- `User-Agent` (logged by Bacen; useful for diagnosis)
- `Via`

`PI-ResourceId` and `PI-Pull-Next` are **response** headers; do not send them, nor any custom `PI-*`/`x-*` header (e.g. a `pi-pacs-version`).

### Commonly Rejected Headers (from APM/monitoring tools)

- `x-datadog-trace-id`, `x-datadog-parent-id`, `x-datadog-sampling-priority`
- `x-newrelic-id`, `x-newrelic-transaction`
- `traceparent`, `tracestate` (OpenTelemetry)
- `x-b3-traceid`, `x-b3-spanid` (Zipkin)
- `sentry-trace`, `baggage` (Sentry)
- Any custom `x-` headers injected by infrastructure

**Solution:** Disable APM instrumentation on the ICOM HTTP client or use a dedicated agent/client without middleware. `IcomClient` drops any header outside the whitelist. See [Known Pitfalls](../playbook/pitfalls.md#2-extra-http-headers-rejected-by-bacen).

---

## Connection Pooling Best Practices

Efficient connection management is critical for meeting SPI throughput and latency requirements.

### Recommended Configuration

```js
// Separate agents for reading and sending
const readAgent = new https.Agent({
  cert: clientCert,
  key: clientKey,
  ca: bacenCA,
  keepAlive: true,
  maxSockets: 6,        // Match the ICOM limit of 6 read streams
  maxFreeSockets: 6,
  timeout: 60000,       // Long polling holds the request for some seconds
});

const sendingAgent = new https.Agent({
  cert: clientCert,
  key: clientKey,
  ca: bacenCA,
  keepAlive: true,
  maxSockets: 50,       // Higher limit for sending
  maxFreeSockets: 10,
  timeout: 30000,
});
```

### Key Principles

1. **Reuse connections.** Never create a new `https.Agent` per request. The mTLS handshake is expensive, and opening/closing connections too often causes 503.

2. **Separate reading and sending agents.** Reads are long-polled and limited to 6 streams. Using separate agents prevents sends from waiting behind held read connections and vice versa. `IcomClient` does this internally.

3. **Enable keep-alive.** Set `keepAlive: true` to reuse TCP connections across requests.

4. **Size the pool appropriately.** For capacity tests (1,000 to 4,000 pacs.008 per minute, plus the pacs.002 you send as receiver), the sending agent needs enough sockets; `multipart/mixed` with up to 10 messages per request reduces the request count by up to 10x. Monitor queue depth to decide whether the pool needs to be larger.

5. **Handle socket exhaustion.** If all sockets are in use, new requests will queue. Monitor the queue length and scale up if it grows unboundedly.

6. **Socket timeout.** Set timeouts to reclaim hung connections. The read timeout must be longer than the long-polling wait (the manual only says "some seconds"; 30--60 s is a practical choice). Timeouts are client-side choices, not Bacen deadlines; the Bacen limit that matters is the **40 s** end-to-end settlement limit counted from `AccptncDtTm` (Manual de Tempos do Pix).

---

## Reading Loop Architecture

```
   +------------------------------+
   | GET /api/v1/out/{ispb}/      |
   |     stream/start             |
   +------------------------------+
                  |
                  v
   +------------------------------+
   | 200: store all messages      |<------------------+
   |      (dedupe by ResourceId), |                   |
   |      hand off async          |                   |
   | 204: nothing (long poll)     |                   |
   +------------------------------+                   |
                  |                                   |
                  v                                   |
   +------------------------------+     keep reading  |
   | GET {PI-Pull-Next}           |-------------------+
   +------------------------------+
                  | stop / shutdown
                  v
   +------------------------------+
   | DELETE {last PI-Pull-Next}   |
   +------------------------------+
```

- No sleep is needed between reads: the API itself waits (long polling) before answering 204.
- Store the messages and process them asynchronously; delays between reads increase latency and cause duplicate deliveries.
- Run up to 6 independent streams (each started with its own `stream/start`) for higher throughput. If you get 429 often, reduce the number.
- Always close each stream with `DELETE` (on shutdown too).

---

## Rate Limiting (Token Bucket)

ICOM limits traffic per PSP with a token bucket. When the balance is exhausted, new messages are rejected with **429** and a `Retry-After` header (seconds). The balance is debited during processing, not on reception, so it can go negative.

| Channel | Time | Max bucket size | Refill per second |
|---------|------|-----------------|-------------------|
| Primary | -- | 3750 | 750 |
| Secondary (general rule) | 08:00:00 -- 23:59:59 | 350 | 35 |
| Secondary (general rule) | 00:00:00 -- 07:59:59 | 5000 | 350 |
| Secondary (trck.002, booktransfer) | -- | 1500 | 500 |

Cost: 1 token per operation in pacs.008 and trck.002; 0.2 token per operation in pacs.002; 1 token per other message. Bacen may change these parameters per participant.

---

## Error Handling

Errors follow RFC 7807 as `application/problem+xml` (exceptionally `text/plain` on severe 5xx):

```xml
<problem xmlns="urn:ietf:rfc:7807">
  <type>https://icom.pi.rsfn.net.br/api/v1/error/forbidden</type>
  <title>Acesso não permitido.</title>
</problem>
```

| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 200 | Messages delivered (read) / stream closed (DELETE) | Store and process |
| 201 | Messages stored (send) | Keep the `PI-ResourceId` |
| 204 | No messages after the long-polling wait | GET the new `PI-Pull-Next` immediately |
| 400 | Bad request (e.g. wrong charset) | Fix the request. Do not resend unchanged |
| 403 | Forbidden | Check certificate, ISPB in the path and headers |
| 406 | `Accept` not supported | Use `application/xml`, `multipart/mixed` or `*/*` |
| 410 | Gone (resource already removed) | Success on `DELETE`; otherwise restart with `stream/start` |
| 411 | Missing `Content-Length`/`Transfer-Encoding` | Fix the request |
| 413 | Payload too large | Split the request |
| 415 | Wrong `Content-Type` or `Content-Encoding` | Use `application/xml; charset=utf-8`, `Content-Encoding: gzip` |
| 429 | Token bucket exhausted, or more than 6 read streams | Wait `Retry-After`; reduce streams |
| 500 | Server error | Retry with backoff; report 5xx to SPI support |
| 502 | Bad gateway | Retry with backoff |
| 503 | Too many simultaneous connections / too frequent reconnects / unavailability | Reuse connections, reduce concurrency, retry with backoff |

4xx means nothing was stored and the same request should not be resent. 5xx on a send means the message may or may not have been stored; resending is safe. Bacen asks that 5xx errors be reported to SPI support unless the manual says otherwise (e.g. some 503 cases).

```js
const TRANSIENT_CODES = [429, 502, 503];
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try {
    return await client.sendMessages(xml);
  } catch (err) {
    if (attempt < MAX_RETRIES && TRANSIENT_CODES.includes(err.statusCode)) {
      const delay = err.retryAfterSeconds !== undefined
        ? err.retryAfterSeconds * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
      continue;
    }
    throw err;
  }
}
```

`IcomClient` already retries 429/502/503 (honoring `Retry-After`) up to `maxRetries`.

---

## Sources

- Manual das Interfaces de Comunicacao (ICOM) 1.12: https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf
- Manual de Tempos do Pix 7.0: https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf
- Catalogo de Mensagens e Servicos do SPI 5.13.1: https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip
