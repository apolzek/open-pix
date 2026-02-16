# Known Pitfalls and Solutions

Hard-won lessons from real Pix Direct Participant homologation with Bacen. Every pitfall below has been encountered in production homologation runs and can cost days of debugging if not anticipated.

---

## 1. Wrong ISO Message Version

**Symptom:** Bacen returns `"Schema desconhecido ou nao habilitado para uso"` when sending any ISO 20022 message (pacs.008, pacs.002, pacs.004, etc.).

**Root Cause:** The XML namespace version in the `AppHdr` or document body does not match the version Bacen currently expects. For example, you may be sending `spi.1.11` when Bacen has already rolled forward to `spi.1.13`.

**Solution:**
- Try the next version up (e.g., bump from `1.11` to `1.12` or `1.13`).
- Bacen does NOT always announce version changes in the catalog ahead of time. They can silently activate a new version.
- Implement a version detection mechanism: on first startup or after failure, try sending with incrementally higher versions until one is accepted.
- Keep a configurable version constant so you can change it without redeploying.

---

## 2. Extra HTTP Headers Rejected by Bacen

**Symptom:** Bacen returns HTTP `403 Forbidden` on ICOM requests that were previously working. No change was made to the request body.

**Root Cause:** APM and monitoring tools (DataDog, New Relic, Dynatrace, Elastic APM, etc.) inject custom HTTP headers (e.g., `x-datadog-trace-id`, `x-newrelic-id`, `traceparent`) into outgoing requests. Bacen's ICOM gateway has a strict header whitelist and rejects requests carrying any unknown headers.

**Solution:**
- Configure a strict header whitelist for ICOM requests. Only send the headers explicitly documented in the ICOM manual:
  - `Content-Type`
  - `Content-Encoding` (if using gzip)
  - `PI-ResourceId`
  - `PI-PayloadType`
  - Standard TLS/HTTP headers
- Disable APM instrumentation on the HTTP client used for Bacen communication, or use a dedicated HTTP agent with no middleware.
- Test with `curl` using `--verbose` to compare headers between your application and a known-good request.

---

## 3. pacs.002 Response Too Slow -- AB03 Timeout

**Symptom:** The counterpart PSP receives `AB03` (Transaction timed out) even though your system eventually processes the pacs.008 and sends a pacs.002 with `ACSP`.

**Root Cause:** The SPI has a hard timeout of approximately 10 seconds. If your pacs.002 acknowledgment is not received by Bacen within this window, the SPI automatically generates a rejection with reason code `AB03` and returns it to the originating PSP. Your late pacs.002 is silently discarded.

**Solution:**
- Optimize the entire processing pipeline from ICOM poll to pacs.002 send. Target under 3 seconds end-to-end.
- Pre-generate response templates. Do not build XML from scratch for every response.
- Perform account validation and fraud checks asynchronously or with pre-cached data.
- Use connection pooling so you do not pay TLS handshake cost on each response.
- Monitor your p95 and p99 response times aggressively during load tests.

---

## 4. Single Polling Instead of Batch/Multipart Consumption

**Symptom:** Under high volume, messages are missed or processed with increasing delay. The backlog keeps growing.

**Root Cause:** Polling ICOM once and processing a single message per poll cycle. When Bacen queues multiple messages, you only consume one at a time while new ones keep arriving.

**Solution:**
- After each poll response, check if the response is multipart. If so, parse and process ALL message parts.
- Implement a tight polling loop: after consuming a batch, immediately poll again rather than waiting for the next scheduled interval.
- Only introduce a delay (e.g., 500ms-1s) when a poll returns zero messages.
- During load tests (2,000 messages/minute), a single-message-per-poll approach will fail the throughput requirement.

---

## 5. Not Reusing TCP Connections

**Symptom:** Performance degrades under load. Latency increases as volume increases. TLS handshake errors or connection exhaustion may occur.

**Root Cause:** Each ICOM request opens a new TCP+TLS connection. The mTLS handshake to Bacen is expensive (client certificate exchange, RSFN network latency).

**Solution:**
- Enable HTTP keep-alive on the HTTPS agent:
  ```js
  const agent = new https.Agent({
    keepAlive: true,
    cert: clientCert,
    key: clientKey,
    ca: bacenCA,
    maxSockets: 50,
  });
  ```
- Reuse the same agent instance across all ICOM requests.
- Monitor active socket counts to ensure connections are being reused.

---

## 6. Node.js HTTPS Agent Pool Limits Too Low

**Symptom:** Load tests stall or produce timeouts at high concurrency even though the system is not CPU-bound.

**Root Cause:** The default `https.Agent` in Node.js has `maxSockets` set to `Infinity` but per-host limits and default behavior can throttle concurrency. In many configurations the effective limit is much lower than needed for 2,000 transactions/minute.

**Solution:**
- Explicitly set `maxSockets` to at least 50 (or higher based on your load profile):
  ```js
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
  });
  ```
- During load tests, log active and pending socket counts to identify bottlenecks.
- Consider separate agent pools for polling (max 6 connections) and sending (higher limit).

---

## 7. Bacen Silently Changes Message Versions

**Symptom:** Tests that passed yesterday suddenly fail with schema validation errors. No Bacen communication or catalog update preceded the failure.

**Root Cause:** Bacen can activate new schema versions on the SPI without prior notice. The old version may be deactivated simultaneously.

**Solution:**
- Implement automatic version detection: on schema-related errors, retry with the next version.
- Subscribe to Bacen communication channels and check the SPI catalog regularly.
- Keep a mapping of message type to version and make it hot-configurable (environment variable or config service).
- Log the version used in every outgoing message for debugging.

---

## 8. DICT Email Ownership Claims Broken

**Symptom:** Attempting an ownership claim (`CreateClaim` with type `OWNERSHIP`) on an EMAIL key fails or is rejected.

**Root Cause:** Bacen Resolution 457/2025 restricts ownership claims to PHONE keys only. Email keys cannot be claimed via ownership; they must be deleted at the donor PSP and re-registered at the claimer PSP.

**Solution:**
- For homologation tests requiring ownership claims, use PHONE key type exclusively.
- If you need to transfer an email key, use the portability flow instead (if applicable), or instruct the user to delete and re-register.
- Update your test data generators to produce valid Brazilian phone numbers (+55...) for ownership claim test cases.

---

## 9. PI Account Starts with Zero Balance

**Symptom:** Cannot send a Pix (pacs.008 origination) because the PI (Pix Indirect/Direct participant) settlement account has no balance. Bacen rejects with `AM04` (insufficient funds) or the settlement fails.

**Root Cause:** Newly created PI accounts in the SPI start with zero balance. You cannot send Pix without funds to settle.

**Solution:**
- **Option A:** Coordinate with your homologation partner PSP to send a Pix TO your account first, crediting your PI balance.
- **Option B:** Use STR Web (Sistema de Transferencia de Reservas) to transfer funds from your bank reserves account to your PI settlement account.
- Verify your balance before starting send tests. Bacen provides balance query capabilities through specific messages.

---

## 10. Event Loop Blocking During Load Tests

**Symptom:** Node.js process becomes unresponsive during load tests. XML generation throughput plateaus well below 2,000 messages/minute. Event loop lag spikes to hundreds of milliseconds.

**Root Cause:** XML generation (building ISO 20022 documents, serializing, signing) is CPU-intensive. A single Node.js event loop thread cannot sustain the required throughput.

**Solution:**
- Deploy multiple pods/replicas behind a load balancer. Distribute polling and sending across instances.
- Use `worker_threads` for CPU-intensive XML operations:
  ```js
  const { Worker } = require('worker_threads');
  // Offload XML generation to a worker pool
  ```
- Pre-compile XML templates. Avoid rebuilding the full document tree for every message.
- Profile with `--inspect` and look for synchronous operations blocking the event loop.
- Consider using a streaming XML writer instead of building a full DOM in memory.

---

## 11. No Retry Logic for Transient Bacen Errors

**Symptom:** Messages are lost during Bacen infrastructure maintenance windows or peak-hour congestion. HTTP `502 Bad Gateway` or `403 Forbidden` errors appear sporadically.

**Root Cause:** Bacen's ICOM gateway can return transient errors during deployments, maintenance, or high load. Without retry logic, these messages are permanently lost.

**Solution:**
- Implement exponential backoff retry for transient HTTP status codes:
  ```js
  const TRANSIENT_CODES = [502, 503, 504, 403];
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 1000;

  async function sendWithRetry(message, attempt = 0) {
    try {
      return await sendToICOM(message);
    } catch (err) {
      if (attempt < MAX_RETRIES && TRANSIENT_CODES.includes(err.statusCode)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
        return sendWithRetry(message, attempt + 1);
      }
      throw err;
    }
  }
  ```
- Log every retry with the status code and attempt number for post-mortem analysis.
- Set a maximum retry count to avoid infinite loops.
- Treat `403` as potentially transient (header injection issues can be intermittent depending on APM sampling).

---

## 12. Invalid CPF/CNPJ in Test Data

**Symptom:** Bacen or DICT rejects requests with invalid document numbers. Error messages reference document validation failures.

**Root Cause:** CPF (11 digits) and CNPJ (14 digits) have check digits calculated with a specific algorithm. Random digit strings will fail validation. Bacen validates these in all environments, including homologation.

**Solution:**
- Always generate CPF/CNPJ with proper check-digit calculation:
  ```
  CPF: 9 base digits + 2 check digits (mod 11 algorithm)
  CNPJ: 12 base digits + 2 check digits (mod 11 algorithm with different weights)
  ```
- Use a validated generator library or implement the check-digit algorithm.
- Maintain a set of known-good test CPFs/CNPJs for reuse across test cases.
- Never hardcode document numbers that have not been validated.

---

## 13. XML Namespace Prefix Mismatch

**Symptom:** Bacen returns a schema validation error even though the XML content appears correct.

**Root Cause:** Some XML libraries generate namespace prefixes inconsistently (e.g., `ns0:`, `ns1:`, or no prefix). While XML namespaces are technically prefix-independent, Bacen's validator may be sensitive to the default namespace declaration approach.

**Solution:**
- Use explicit default namespace declarations (`xmlns="..."`) rather than prefixed namespaces where possible.
- Test your XML output against Bacen's published XSD schemas locally before sending.
- Ensure the `AppHdr` and document body use consistent namespace handling.

---

## 14. Certificate Expiration During Homologation

**Symptom:** All ICOM requests suddenly fail with TLS handshake errors. The error is at the transport layer, not the application layer.

**Root Cause:** The mTLS client certificate issued for RSFN access has expired. Homologation can span weeks or months, and certificates may expire mid-process.

**Solution:**
- Track certificate expiration dates and set calendar reminders at least 2 weeks before expiry.
- Automate certificate expiration monitoring:
  ```bash
  openssl x509 -enddate -noout -in client-cert.pem
  ```
- Coordinate certificate renewal with your institution's security team well in advance, as the process involves Bacen's RSFN PKI.

---

## 15. Incorrect EndToEndId Format

**Symptom:** Bacen rejects pacs.008 messages with validation errors referencing the `EndToEndId` field.

**Root Cause:** The EndToEndId must follow a strict format: `E` + 8-digit ISPB + `YYYYMMDD` + `HHMM` + random alphanumeric characters, totaling exactly 32 characters. Common mistakes include using the wrong ISPB, incorrect date format, or wrong total length. For devolutions, the prefix must be `D` instead of `E`.

**Solution:**
- Validate EndToEndId format before sending:
  ```
  /^E\d{8}\d{8}\d{4}[A-Za-z0-9]{8}$/  (for originations)
  /^D\d{8}\d{8}\d{4}[A-Za-z0-9]{8}$/  (for devolutions)
  ```
- Use your own institution's ISPB, not the counterpart's.
- See the [EndToEndId Format Reference](../reference/endtoendid-format.md) for full details.

---

## 16. Gzip Encoding Issues

**Symptom:** Bacen returns garbled responses or your system fails to parse ICOM responses.

**Root Cause:** ICOM supports gzip compression, but the `Content-Encoding` and `Accept-Encoding` headers must be handled correctly. Some HTTP clients auto-decompress while others do not, leading to double-decompression or no decompression.

**Solution:**
- If sending gzipped requests, set `Content-Encoding: gzip` and actually gzip the body.
- If expecting gzipped responses, set `Accept-Encoding: gzip` and ensure your HTTP client handles decompression.
- Test with and without gzip to isolate compression-related issues.
- In Node.js, be aware that `axios` auto-decompresses by default while raw `https` does not.

---

## 17. Race Condition Between Polling and Sending

**Symptom:** During load tests, you receive a pacs.008 and send a pacs.002 response, but the response is rejected or lost. Or you process the same message twice.

**Root Cause:** If multiple polling consumers are active (up to 6 connections allowed), the same message can be delivered to different consumers if acknowledgment is not handled correctly. Additionally, sending responses on a polling connection (or vice versa) can cause confusion.

**Solution:**
- Use dedicated connections for polling and dedicated connections for sending. Do not mix them.
- Implement idempotency checks using the `MsgId` or `EndToEndId` to detect duplicate processing.
- Use a message deduplication store (in-memory set or Redis) keyed on `BizMsgIdr`.

---

## Summary

| # | Pitfall | Quick Fix |
|---|---------|-----------|
| 1 | Wrong ISO version | Bump to next version (e.g., 1.13) |
| 2 | Extra HTTP headers | Strict header whitelist |
| 3 | Slow pacs.002 | Optimize to under 3 seconds |
| 4 | Single-message polling | Consume all messages per poll |
| 5 | No TCP reuse | `keepAlive: true` |
| 6 | Low socket limits | `maxSockets: 50+` |
| 7 | Silent version changes | Version detection + fallback |
| 8 | Email ownership claims | Use PHONE keys only |
| 9 | Zero PI balance | Receive Pix or STR Web transfer |
| 10 | Event loop blocking | Multiple pods + worker_threads |
| 11 | No retry logic | Exponential backoff |
| 12 | Invalid CPF/CNPJ | Check-digit algorithm |
| 13 | Namespace prefix | Consistent xmlns declarations |
| 14 | Certificate expiration | Expiry monitoring |
| 15 | Bad EndToEndId format | Strict format validation |
| 16 | Gzip issues | Correct encoding headers |
| 17 | Polling race conditions | Deduplication + separate connections |
