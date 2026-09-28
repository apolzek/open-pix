# Known Pitfalls and Solutions

Hard-won lessons from real Pix Direct Participant homologation with Bacen. Every pitfall below has been encountered in production homologation runs and can cost days of debugging if not anticipated.

---

## 1. Wrong ISO Message Version

**Symptom:** Bacen returns `"Schema desconhecido ou nao habilitado para uso"` when sending any ISO 20022 message (pacs.008, pacs.002, pacs.004, etc.).

**Root Cause:** The envelope namespace (`https://www.bcb.gov.br/pi/<type>/<version>`) or `MsgDefIdr` (`<type>.spi.<version>`) names a version that is not enabled in the ICOM catalog of that environment. Each message has its own version (catalog 5.13: pacs.008 1.16, pacs.002 1.17, pacs.004 1.5); there is no global "spi.1.x" version, so bumping every message to the same number is wrong.

**Solution:**
- Query the catalog instead of guessing: `GET /api/v1/in/catalog` lists the message versions you may send and `GET /api/v1/out/catalog` the ones you will receive (`IcomClient.catalog("in" | "out")` in this toolkit).
- Keep namespace and `MsgDefIdr` consistent: `https://www.bcb.gov.br/pi/pacs.008/1.16` goes with `pacs.008.spi.1.16`.
- Keep a configurable version per message type so you can change it without redeploying.
- Validate against the XSDs of the catalog you target (copies of 5.13.1 in `simulator/spec/spi-5.13.1`).

---

## 2. Extra HTTP Headers Rejected by Bacen

**Symptom:** Bacen refuses ICOM requests that were previously working (in our experience with HTTP `403 Forbidden`). No change was made to the request body.

**Root Cause:** APM and monitoring tools (DataDog, New Relic, Dynatrace, Elastic APM, etc.) inject custom HTTP headers (e.g., `x-datadog-trace-id`, `x-newrelic-id`, `traceparent`) into outgoing requests. The ICOM manual (section 2.1.8) says the API may refuse any request carrying headers other than a fixed list.

**Solution:**
- Configure a strict header whitelist for ICOM requests. Only send the headers the ICOM manual allows:
  - `Accept` (`application/xml`, `multipart/mixed` or `*/*`)
  - `Accept-Encoding` (only `gzip`)
  - `Connection`, `Content-Encoding`, `Content-Length`, `Content-Type`, `Cookie`
  - `Host` (without the port)
  - `Max-Forwards`, `Transfer-Encoding`, `User-Agent`, `Via`
- Custom `PI-*` request headers (e.g. `pi-pacs-version`) are not on the list. `PI-ResourceId` and `PI-Pull-Next` are *response* headers. The DICT API adds its own `PI-RequestingParticipant`, `PI-PayerId` and `PI-EndToEndId`, which apply to the DICT only.
- Disable APM instrumentation on the HTTP client used for Bacen communication, or use a dedicated HTTP agent with no middleware.
- Test with `curl` using `--verbose` to compare headers between your application and a known-good request.

---

## 3. pacs.002 Response Too Slow -- AB03 Timeout

**Symptom:** Transactions end in a `pacs.002` `RJCT` with `AB03` (settlement aborted due to timeout in the SPI) even though your system eventually processes the pacs.008 and sends a pacs.002 with `ACSP`; or your answer times exceed the receiver service levels.

**Root Cause:** Per the Manual de Tempos do Pix, a Pix on the primary channel must settle within **40 seconds counted from `AccptncDtTm`** (t0', acceptance by the payer's PSP) to settlement (t4). When that is exceeded the SPI rejects with `AB03` to both PSPs, and a late pacs.002 is useless. Independently, the receiving PSP is measured on t3' − t2 (SPI makes the pacs.008 available → SPI receives your pacs.002): **1.4 s at p50 and 2.3 s at p95**. There is no separate "10-second pacs.002 deadline".

**Solution:**
- Optimize the entire processing pipeline from the ICOM stream read to the pacs.002 send. Target well under a second.
- Pre-generate response templates. Do not build XML from scratch for every response.
- Perform account validation and fraud checks asynchronously or with pre-cached data.
- Use connection pooling so you do not pay TLS handshake cost on each response.
- Monitor your p95 and p99 response times aggressively during load tests.

---

## 4. Single-Message Reads Instead of Multipart Streams

**Symptom:** Under high volume, messages are processed with increasing delay. The backlog keeps growing.

**Root Cause:** Reading one message per request, or reopening the stream for every read. ICOM delivery is a long-polling stream: `GET /api/v1/out/{ispb}/stream/start`, then keep calling `GET` on the path in the `PI-Pull-Next` response header, and finally `DELETE` the last `PI-Pull-Next` to confirm the reads.

**Solution:**
- Send `Accept: multipart/mixed` so each read returns up to 10 messages, and parse and process ALL parts (each has its own `PI-ResourceId`).
- After a read, immediately `GET` the returned `PI-Pull-Next`. No client-side sleep is needed: when there is nothing to deliver, ICOM holds the request and answers `204` after some seconds, still with a `PI-Pull-Next`.
- Run several streams in parallel, up to 6 per participant and channel (above that ICOM answers `429`).
- The capacity test (1,000, 2,000 or 4,000 pacs.008 per minute over 10 minutes, depending on your size) also requires consuming ≥99% of the messages the SPI makes available within 200 ms; one message per read will not keep up.

```typescript
const { messages, pullNext } = await icom.readStream();   // opens the stream
const next = await icom.readStream(pullNext);             // keeps reading
await icom.closeStream(next.pullNext);                    // DELETE, confirms the reads
```

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
- Use separate agent pools for reading streams (max 6 connections, the ICOM limit per participant and channel) and sending (higher limit). `IcomClient` does this.

---

## 7. Bacen Silently Changes Message Versions

**Symptom:** Tests that passed yesterday suddenly fail with "Schema desconhecido ou não habilitado para uso" or `admi.002` schema errors.

**Root Cause:** In our experience, the set of enabled versions in the homologation environment can change with little notice (this is practical experience, not a documented Bacen rule). Bacen publishes new catalogs (Catálogo de Mensagens e Serviços do SPI) with per-message versions.

**Solution:**
- Check `GET /api/v1/in/catalog` and `GET /api/v1/out/catalog` at startup and when schema errors appear, instead of retrying with guessed versions.
- Subscribe to Bacen communication channels and check the published SPI catalog regularly.
- Keep a mapping of message type to version and make it hot-configurable (environment variable or config service).
- Log the version used in every outgoing message for debugging.

---

## 8. DICT Email Ownership Claims Broken

**Symptom:** Attempting an ownership claim (`POST /api/v2/claims/` with a `CreateClaimRequest` of `<Type>OWNERSHIP</Type>`) on an EMAIL key fails or is rejected.

**Root Cause:** The DICT API (2.12.1, "Criar reivindicação") only allows `OWNERSHIP` for `PHONE` keys. CPF, CNPJ, PHONE and EMAIL keys can be ported (`PORTABILITY`); EVP keys can be neither claimed nor ported.

**Solution:**
- For homologation tests requiring ownership claims, use PHONE key type exclusively.
- If you need to move an email key between PSPs for the same owner, use the portability flow; otherwise the key must be deleted and re-registered.
- Update your test data generators to produce valid Brazilian phone numbers (+55...) for ownership claim test cases.

---

## 9. PI Account Starts with Zero Balance

**Symptom:** Cannot send a Pix (pacs.008 origination) because the PI account (Conta Pagamentos Instantâneos, the settlement account in the SPI) has no balance. The SPI rejects with `AM04` (insufficient funds) or the settlement fails.

**Root Cause:** Newly created PI accounts in the SPI start with zero balance. You cannot send Pix without funds to settle.

**Solution:**
- **Option A:** Fund the PI account through the STR (the Roteiro's item 4 is precisely the test of liquidity transfers between STR and the PI account).
- **Option B:** Receive Pix first (e.g. the pacs.008 Bacen sends from the virtual participant `99999A03`, or from a partner PSP) to build up a balance. This is practical experience, not a documented procedure.
- Verify your balance before starting send tests with a `camt.060` balance request (answered with `camt.053`, Roteiro items 2i/2j).

---

## 10. Event Loop Blocking During Load Tests

**Symptom:** Node.js process becomes unresponsive during load tests. XML generation throughput plateaus well below the capacity tier you must reach (1,000, 2,000 or 4,000 messages/minute). Event loop lag spikes to hundreds of milliseconds.

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

**Symptom:** Messages are lost during Bacen infrastructure maintenance windows or peak-hour congestion. HTTP `429`, `502` or `503` errors appear sporadically.

**Root Cause:** Per the ICOM manual, a 4xx means the request failed and nothing was stored (fix it, do not resend as is), while a 5xx means the message *may* have been stored and should be resent (sending is idempotent from the SPI's point of view; each send gets its own `PI-ResourceId`). `429` means your token bucket is exhausted (primary channel: 3,750 tokens, refilled at 750/s; 1 token per pacs.008, 0.2 per pacs.002) or you opened more than 6 read streams; honor `Retry-After`. Without retry logic, these messages are permanently lost.

**Solution:**
- Implement exponential backoff retry for transient HTTP status codes (`IcomClient` retries 429/502/503 and honors `Retry-After`):
  ```js
  const TRANSIENT_CODES = [429, 500, 502, 503, 504];
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
- Do not blindly retry `403`: fix its cause (for example headers injected by APM agents, which can be intermittent depending on sampling).

---

## 12. Invalid CPF/CNPJ in Test Data

**Symptom:** Bacen or DICT rejects requests with invalid document numbers. Error messages reference document validation failures.

**Root Cause:** CPF (11 digits) and CNPJ (14 characters; the SPI catalog also accepts the new alphanumeric CNPJ, `[0-9A-Z]{12}[0-9]{2}`) have check digits calculated with a specific algorithm. Random digit strings will fail validation. Bacen validates these in all environments, including homologation.

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

**Root Cause:** Some XML libraries generate namespace prefixes inconsistently (e.g., `ns0:`, `ns1:`, or no prefix), or put separate namespaces on `AppHdr` and `Document`. In the official examples a single default namespace is declared on `<Envelope>` (e.g. `xmlns="https://www.bcb.gov.br/pi/pacs.008/1.16"`) and `AppHdr`/`Document` inherit it; there are no `urn:iso:...` or `head.001` namespaces. Sensitivity to prefixes is our experience, not a documented rule.

**Solution:**
- Mirror the official examples: one default namespace declaration (`xmlns="..."`) on `Envelope`, no prefixes.
- Test your XML output against Bacen's published XSD schemas locally before sending (`npm run test:simulator` does this for the toolkit's generators).

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

**Root Cause:** The EndToEndId must follow a strict format: `E` + ISPB (8 chars `[0-9A-Z]`) + `yyyyMMddHHmm` **in UTC** + 11 alphanumeric characters, totaling exactly 32 characters. Common mistakes include using Brasília time instead of UTC (the SPI tolerates ±12 h), rejecting ISPBs with letters (such as `99999A04`), incorrect date format, or wrong total length. The pacs.004 return id (`RtrId`) uses the same layout with a `D` prefix, while its `OrgnlEndToEndId` keeps the original `E` id.

**Solution:**
- Validate EndToEndId format before sending (same patterns as `scripts/utils/endtoendid-generator.ts`):
  ```
  /^E[0-9A-Z]{8}\d{4}[01]\d[0-3]\d[0-2]\d[0-5]\d[a-zA-Z0-9]{11}$/  (EndToEndId)
  /^D[0-9A-Z]{8}\d{4}[01]\d[0-3]\d[0-2]\d[0-5]\d[a-zA-Z0-9]{11}$/  (pacs.004 RtrId)
  ```
- Use the ISPB of the participant that generates the id (your own), not the counterpart's.
- See the [EndToEndId Format Reference](../reference/endtoendid-format.md) for full details.

---

## 16. Gzip Encoding Issues

**Symptom:** Bacen returns garbled responses or your system fails to parse ICOM responses.

**Root Cause:** gzip support is mandatory in ICOM (recommended on the primary channel, mandatory on the secondary channel), but the `Content-Encoding` and `Accept-Encoding` headers must be handled correctly. Some HTTP clients auto-decompress while others do not, leading to double-decompression or no decompression. The DICT, unlike ICOM, does not accept compressed request bodies (only compressed responses).

**Solution:**
- If sending gzipped requests, set `Content-Encoding: gzip` and actually gzip the body. Do not use `Transfer-Encoding: gzip`.
- If expecting gzipped responses, set `Accept-Encoding: gzip` and ensure your HTTP client handles decompression.
- Test with and without gzip to isolate compression-related issues.
- In Node.js, be aware that `axios` auto-decompresses by default while raw `https` does not.

---

## 17. Race Condition Between Polling and Sending

**Symptom:** During load tests, you receive a pacs.008 and send a pacs.002 response, but the response is rejected or lost. Or you process the same message twice.

**Root Cause:** ICOM may deliver the same message more than once (the manual says so explicitly), especially when a stream is not finished with `DELETE` on the last `PI-Pull-Next`, which is what confirms the reads. With several read streams active (up to 6), duplicates can land on different consumers. Additionally, long-polling reads on the same connection pool as sends can starve the sends.

**Solution:**
- Always close each stream with `DELETE` on the last `PI-Pull-Next` (`IcomClient.closeStream`; `readUntil` does it in a `finally`).
- Deduplicate by `PI-ResourceId`: it is identical in every delivery of the same message. Checking `BizMsgIdr`/`EndToEndId` as well protects your business logic.
- Use dedicated connections for reading streams and for sending. Do not mix them.

---

## Summary

| # | Pitfall | Quick Fix |
|---|---------|-----------|
| 1 | Wrong ISO version | Check `GET /api/v1/in/catalog` |
| 2 | Extra HTTP headers | Strict header whitelist |
| 3 | Slow pacs.002 | 40 s limit from AccptncDtTm; receiver SLA 1.4 s p50 / 2.3 s p95 |
| 4 | Single-message reads | Multipart streams + PI-Pull-Next |
| 5 | No TCP reuse | `keepAlive: true` |
| 6 | Low socket limits | `maxSockets: 50+` |
| 7 | Version changes | Check the ICOM catalog |
| 8 | Email ownership claims | Use PHONE keys only |
| 9 | Zero PI balance | STR transfer or receive Pix first |
| 10 | Event loop blocking | Multiple pods + worker_threads |
| 11 | No retry logic | Exponential backoff |
| 12 | Invalid CPF/CNPJ | Check-digit algorithm |
| 13 | Namespace prefix | Consistent xmlns declarations |
| 14 | Certificate expiration | Expiry monitoring |
| 15 | Bad EndToEndId format | Strict format validation |
| 16 | Gzip issues | Correct encoding headers |
| 17 | Duplicate deliveries | DELETE the stream + dedupe by PI-ResourceId |

---

**Sources:** [Manual das Interfaces de Comunicação 1.12](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf), [Catálogo de Mensagens e Serviços do SPI 5.13.1](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip), [Manual de Tempos do Pix 7.0](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf), [Roteiro para Participação Direta no SPI](https://www.bcb.gov.br/content/estabilidadefinanceira/sistemapagamentosinstantaneos_docs/Roteiro_para_Participacao_Direta_no_SPI_e_abertura_de_Conta_PI.pdf), [API DICT 2.12.1](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/API-DICT.html). Items described as experience are field observations, not Bacen rules.
