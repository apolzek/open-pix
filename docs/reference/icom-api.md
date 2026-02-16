# ICOM API Reference

Reference documentation for the ICOM (Interface de Comunicacao) API used by Pix Direct Participants to exchange ISO 20022 messages with the SPI (Sistema de Pagamentos Instantaneos).

ICOM is the communication layer between PSPs and Bacen's SPI. All message exchange -- sending pacs.008, pacs.002, pacs.004, and receiving the same -- flows through ICOM.

---

## Overview

- **Base URL (Homologation):** `https://icom-h.pi.rsfn.net.br`
- **Base URL (Production):** `https://icom.pi.rsfn.net.br`
- **Authentication:** mTLS with RSFN client certificate
- **Network:** RSFN (private financial network)
- **Protocol:** HTTPS 1.1

---

## Endpoints

### Send Message

Sends an ISO 20022 message (pacs.008, pacs.002, pacs.004, etc.) to the SPI.

**URL:** `POST /api/v2/messages`

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/xml` |
| `Content-Encoding` | No | `gzip` if the request body is gzip-compressed |
| `PI-ResourceId` | Yes | Identifies the resource/message type being sent |
| `PI-PayloadType` | Yes | Payload type identifier |

**Request Body:** XML-encoded ISO 20022 message wrapped in `BizMsg` envelope (AppHdr + Document).

**Response:**

| Status | Description |
|--------|-------------|
| 200 | Message accepted by the SPI |
| 400 | Malformed request or schema validation error |
| 403 | Authentication failure or disallowed headers |
| 502 | Bacen infrastructure error (transient) |
| 503 | Service unavailable (transient) |

---

### Poll for Messages

Retrieves queued messages from the SPI addressed to your institution.

**URL:** `GET /api/v2/messages`

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Accept` | Yes | `application/xml` |
| `Accept-Encoding` | No | `gzip` to receive compressed responses |

**Response:**
- **200 with body:** One or more messages available. Body contains the ISO 20022 message(s).
- **200 with empty body / 204:** No messages currently queued.

**Important:** After processing a message received via polling, you must acknowledge it. Unacknowledged messages may be redelivered.

---

## Connection Limits

| Connection Type | Max Concurrent Connections |
|-----------------|---------------------------|
| Polling | **6** |
| Sending | Limited by RSFN capacity (typically higher than polling) |

**Critical:** Do not exceed 6 concurrent polling connections. Bacen will reject connections beyond this limit.

---

## mTLS Requirements

All ICOM communication requires mutual TLS (mTLS):

1. **Client Certificate:** Must be a valid certificate issued by the RSFN PKI (Public Key Infrastructure). The certificate identifies your institution by its ISPB.

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

4. **Certificate Renewal:** Monitor certificate expiration dates. RSFN certificates have a limited validity period and must be renewed through the RSFN PKI process before they expire.

---

## URL Format

The full URL for ICOM operations follows this pattern:

```
https://{host}/api/v2/messages
```

Where `{host}` is:
- `icom-h.pi.rsfn.net.br` for homologation
- `icom.pi.rsfn.net.br` for production

All paths are relative to the base URL. There are no path parameters for the core message exchange endpoints.

---

## Gzip Compression

ICOM supports gzip compression for both requests and responses to reduce bandwidth usage and improve throughput.

### Sending Compressed Requests

```
Content-Type: application/xml
Content-Encoding: gzip
Body: [gzip-compressed XML]
```

### Receiving Compressed Responses

```
Accept-Encoding: gzip
```

When `Accept-Encoding: gzip` is sent, ICOM may return gzip-compressed responses with the `Content-Encoding: gzip` header.

**Node.js Considerations:**
- `axios` automatically decompresses gzip responses by default.
- Raw `https` module does NOT auto-decompress. You must pipe through `zlib.createGunzip()`.
- When sending gzip requests, compress the full XML body using `zlib.gzipSync()` before sending.

---

## Multipart Messages

When polling for messages, ICOM may return multiple messages in a single response as a multipart payload. This is common during high-volume periods.

### Handling Multipart Responses

1. Check the `Content-Type` header for multipart boundary:
   ```
   Content-Type: multipart/related; boundary="----=_Part_12345"
   ```

2. Parse each part as a separate ISO 20022 message.

3. Process ALL parts from the response. Do not stop after the first message.

4. After processing a batch, immediately poll again. Continue polling until you receive an empty response.

**Common Mistake:** Processing only the first message in a multipart response and missing subsequent messages. See [Known Pitfalls](../playbook/pitfalls.md#4-single-polling-instead-of-batchmultipart-consumption).

---

## Header Whitelist

Bacen's ICOM gateway enforces a strict HTTP header whitelist. Sending any header not on the whitelist will result in a `403 Forbidden` response.

### Allowed Headers

- `Content-Type`
- `Content-Encoding`
- `Accept`
- `Accept-Encoding`
- `PI-ResourceId`
- `PI-PayloadType`
- `Host`
- `Content-Length`
- `Connection`
- Standard HTTP/TLS headers

### Commonly Rejected Headers (from APM/monitoring tools)

- `x-datadog-trace-id`, `x-datadog-parent-id`, `x-datadog-sampling-priority`
- `x-newrelic-id`, `x-newrelic-transaction`
- `traceparent`, `tracestate` (OpenTelemetry)
- `x-b3-traceid`, `x-b3-spanid` (Zipkin)
- `sentry-trace`, `baggage` (Sentry)
- Any custom `x-` headers injected by infrastructure

**Solution:** Disable APM instrumentation on the ICOM HTTP client or use a dedicated agent/client without middleware. See [Known Pitfalls](../playbook/pitfalls.md#2-extra-http-headers-rejected-by-bacen).

---

## Connection Pooling Best Practices

Efficient connection management is critical for meeting SPI throughput and latency requirements.

### Recommended Configuration

```js
// Separate agents for polling and sending
const pollingAgent = new https.Agent({
  cert: clientCert,
  key: clientKey,
  ca: bacenCA,
  keepAlive: true,
  maxSockets: 6,        // Match ICOM polling limit
  maxFreeSockets: 6,
  timeout: 30000,
});

const sendingAgent = new https.Agent({
  cert: clientCert,
  key: clientKey,
  ca: bacenCA,
  keepAlive: true,
  maxSockets: 50,       // Higher limit for sending
  maxFreeSockets: 10,
  timeout: 10000,
});
```

### Key Principles

1. **Reuse connections.** Never create a new `https.Agent` per request. The mTLS handshake is expensive.

2. **Separate polling and sending agents.** Polling has a hard limit of 6 connections. Sending can use more. Using separate agents prevents sending requests from consuming polling connection slots and vice versa.

3. **Enable keep-alive.** Set `keepAlive: true` to reuse TCP connections across requests. This eliminates repeated TLS handshake overhead.

4. **Size the pool appropriately.** For load tests (2,000+ messages/minute), the sending agent needs at least `maxSockets: 50`. Monitor queue depth to determine if the pool needs to be larger.

5. **Handle socket exhaustion.** If all sockets are in use, new requests will queue. Monitor the queue length and scale up if it grows unboundedly.

6. **Socket timeout.** Set appropriate timeouts to reclaim hung connections. A 10-second timeout for sending (matching the SPI response deadline) and 30 seconds for polling are reasonable defaults.

---

## Polling Loop Architecture

```
   +-------------------+
   |   Start Polling   |
   +-------------------+
            |
            v
   +-------------------+
   |   GET /messages    |
   +-------------------+
            |
       +---------+
       | Has     |
       | messages|
       +---------+
        /       \
      Yes        No
      /            \
     v              v
+----------+   +----------+
| Process  |   | Sleep    |
| all msgs |   | 500ms-1s |
+----------+   +----------+
     |              |
     v              |
+----------+        |
| Send     |        |
| pacs.002 |        |
+----------+        |
     |              |
     +--->----------+
            |
            v
   +-------------------+
   |   Poll again      |
   +-------------------+
```

- When messages are available: process immediately, respond, and poll again with no delay.
- When no messages: wait 500ms to 1 second before polling again to avoid busy-looping.
- Use multiple polling connections (up to 6) for higher throughput.
- Each polling connection should run its own independent loop.

---

## Error Handling

| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 200 | Success | Process the message(s) |
| 204 | No messages | Wait and poll again |
| 400 | Bad request | Fix the request. Do not retry without changes |
| 403 | Forbidden | Check headers and certificate. May be transient (APM headers) |
| 500 | Server error | Retry with backoff |
| 502 | Bad gateway | Retry with backoff. Transient Bacen infrastructure issue |
| 503 | Service unavailable | Retry with backoff. Bacen may be in maintenance |
| 504 | Gateway timeout | Retry with backoff |

For transient errors (502, 503, 504, and sometimes 403), implement exponential backoff:

```js
const TRANSIENT_CODES = [403, 502, 503, 504];
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try {
    const response = await sendMessage(payload);
    return response;
  } catch (err) {
    if (attempt < MAX_RETRIES && TRANSIENT_CODES.includes(err.statusCode)) {
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
      continue;
    }
    throw err;
  }
}
```
