# Pix Direct Participant Homologation: Basic Connectivity

This phase establishes your first working connection to Bacen's ICOM messaging API and validates that your infrastructure can exchange Pix messages. It is the foundation everything else builds on. Do not rush through it: a solid connectivity layer saves weeks of debugging in later phases.

## ICOM API Overview

ICOM (Interface de Comunicacao) is a **pull-based** HTTP API: Bacen provides all HTTP endpoints, and your PSP never exposes a server for ISO 20022 traffic. This is a critical architectural detail that shapes your entire Pix integration.

There are no webhooks. There is no push notification system. There is no WebSocket connection. Your system must **actively read** from ICOM to receive incoming messages. If you stop reading, you stop receiving messages.

### The Send/Receive Model

The flow works like this (ICOM manual 1.12, section 2.2):

1. **Sending a message**: HTTP `POST /api/v1/in/{ISPB}/msgs` with your XML message in the body ("in" = into the SPI). One message as `application/xml; charset=utf-8`, or up to 10 as `multipart/mixed`. Success is **HTTP 201** with a `PI-ResourceId` header.
2. **Receiving messages**: open a read stream with HTTP `GET /api/v1/out/{ISPB}/stream/start`. The response (200 with messages, or 204 after some seconds of long polling) always carries a `PI-Pull-Next` header; keep issuing `GET` on the path in `PI-Pull-Next`.
3. **Confirming receipt**: finish the stream with `DELETE` on the last `PI-Pull-Next` (200 or 410). The DELETE marks the last delivered messages as read; skipping it causes duplicate or delayed deliveries.

You must keep read streams open 24/7. Any gap in reading means incoming messages queue up at Bacen and payments to you fail the 40-second settlement limit (see [Message Reading Mechanics](#message-reading-mechanics)).

## ICOM URL Format

### Sending Messages (SPI input)

```
POST https://icom-h.pi.rsfn.net.br:16522/api/v1/in/{ISPB}/msgs
```

### Receiving Messages (SPI output)

```
GET    https://icom-h.pi.rsfn.net.br:16522/api/v1/out/{ISPB}/stream/start
GET    {PI-Pull-Next}     (repeat)
DELETE {PI-Pull-Next}     (when stopping)
```

### Message Catalog

```
GET https://icom-h.pi.rsfn.net.br:16522/api/v1/in/catalog
GET https://icom-h.pi.rsfn.net.br:16522/api/v1/out/catalog
```

Where `{ISPB}` is your own ISPB: 8 characters matching `[0-9A-Z]{8}` (numeric for most institutions, zero-padded; Bacen's virtual participants such as `99999A04` contain letters).

Note the port: **16522**. This is not standard HTTPS (443). Ensure your network/firewall configuration allows outbound traffic to this port. The secondary channel in homologation is `https://icom-sec-h.pi.rsfn.net.br:17522`.

The `-h` in the hostname indicates the **homologation** environment. Production uses `https://icom.pi.rsfn.net.br:16422` (primary) and `https://icom-sec.pi.rsfn.net.br:17422` (secondary).

The `Host` header must be sent **without the port** (`Host: icom-h.pi.rsfn.net.br`); a port in `Host` may break the connection.

## mTLS Authentication

Every ICOM request must present your ICP-Brasil client certificate. This is **mutual TLS** (mTLS): both the server and client authenticate via certificates.

### Configuration Example (Node.js)

```javascript
const https = require('https');
const fs = require('fs');

const agent = new https.Agent({
  cert: fs.readFileSync('/path/to/client-cert.pem'),
  key: fs.readFileSync('/path/to/client-key.pem'),
  ca: fs.readFileSync('/path/to/rsfn-ca-bundle.pem'),
  keepAlive: true,
  maxSockets: 50,
});
```

### Configuration Example (cURL)

```bash
curl -v \
  --cert /path/to/client-cert.pem \
  --key /path/to/client-key.pem \
  --cacert /path/to/rsfn-ca-bundle.pem \
  https://icom-h.pi.rsfn.net.br:16522/api/v1/in/catalog
```

- **CA bundle** (`ca` / `--cacert`): validates the **Bacen/RSFN server certificate chain**.
- **Client certificate + private key** (`cert`+`key` / `--cert`+`--key`): authenticate **your institution** to ICOM in mTLS.
- See also: [`ICOM API mTLS Requirements`](../reference/icom-api.md#mtls-requirements).

### Trust Chain

You must have the complete CA certificate chain for the RSFN servers in your trust store. If you get TLS errors like `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `CERT_UNTRUSTED`, the CA bundle is likely incomplete.

## First Successful Health Check

Before attempting to send or receive Pix messages, validate basic connectivity with the catalog endpoint, which has no side effects:

```bash
curl --cert client-cert.pem --key client-key.pem --cacert rsfn-ca-bundle.pem \
  https://icom-h.pi.rsfn.net.br:16522/api/v1/in/catalog
```

A successful response is **HTTP 200** with a `<Catalog>` XML listing the message versions ICOM accepts (e.g. `pacs.008.spi.1.16`). Keep this list: it tells you which `MsgDefIdr`/namespace versions to use.

A read on `GET /api/v1/out/{ISPB}/stream/start` also works as a check (200 with messages or 204 after the long-polling wait), but remember to close the stream with `DELETE` on the returned `PI-Pull-Next`.

If you see:

- **HTTP 403**: Client certificate/private key authentication failed, or the ISPB in the path is not yours
- **HTTP 404**: Malformed URL
- **Connection refused / timeout**: Network connectivity issue (firewall, routing, port blocked)
- **TLS handshake failure**: Certificate problem (incomplete CA bundle/trust chain, wrong cert, expired cert, key mismatch)

Errors come as RFC 7807 `application/problem+xml` documents; the `<type>` URL (e.g. `https://icom.pi.rsfn.net.br/api/v1/error/forbidden`) tells you the cause.

Getting a successful health check response is your first milestone. Celebrate it. Many teams spend days resolving certificate and network issues to get here.

## Sending Your First pacs.008

Once connectivity is confirmed, send your first real Pix message: a `pacs.008` (FIToFICustomerCreditTransfer) for R$ 0.01, priority `HIGH`, with Bacen's virtual participant **`99999A04`** (Cooperativa de Credito Virtual) as the creditor agent (`CdtrAgt`). Per the *Roteiro para Participacao Direta no SPI*, `99999A04` answers any pacs.008 with a pacs.002 `ACSP`, regardless of the customer and account data.

### Message Structure

Every SPI message is an `Envelope` with a single default namespace for the message type and version, containing the Business Application Header (`AppHdr`) and the `Document`. There are no `urn:iso` namespaces and no separate `head.001` namespace. The `AppHdr` always goes from your PSP to the **SPI (`00038166`)**; the receiving PSP appears only in `CdtrAgt` inside the Document.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="https://www.bcb.gov.br/pi/pacs.008/1.16">
  <AppHdr>
    <Fr>
      <FIId>
        <FinInstnId>
          <Othr>
            <Id>{YOUR_ISPB}</Id>
          </Othr>
        </FinInstnId>
      </FIId>
    </Fr>
    <To>
      <FIId>
        <FinInstnId>
          <Othr>
            <Id>00038166</Id>
          </Othr>
        </FinInstnId>
      </FIId>
    </To>
    <BizMsgIdr>M{YOUR_ISPB}{23_RANDOM_CHARS}</BizMsgIdr>
    <MsgDefIdr>pacs.008.spi.1.16</MsgDefIdr>
    <CreDt>2026-09-28T14:35:12.345Z</CreDt>
    <Sgntr><!-- XMLDSig signature --></Sgntr>
  </AppHdr>
  <Document>
    <FIToFICstmrCdtTrf>
      <!-- GrpHdr (MsgId, CreDtTm, NbOfTxs, SttlmInf, PmtTpInf) and
           CdtTrfTxInf (EndToEndId, amount, AccptncDtTm, ...; CdtrAgt = 99999A04) -->
    </FIToFICstmrCdtTrf>
  </Document>
</Envelope>
```

The versions above (`pacs.008/1.16`, `pacs.008.spi.1.16`) are those of SPI catalog 5.13; confirm with `GET /api/v1/in/catalog`. All date-times are UTC with milliseconds (`YYYY-MM-DDThh:mm:ss.sssZ`). See [ISO Messages](../reference/iso-messages.md) for the full body, or generate it with `scripts/spi/pacs008-generator.ts`.

### Sending the Message

```
POST /api/v1/in/{ISPB}/msgs HTTP/1.1
Host: icom-h.pi.rsfn.net.br
Content-Type: application/xml; charset=utf-8
Content-Encoding: gzip

{gzip-compressed XML body}
```

A successful send returns **HTTP 201** (Created) with a `PI-ResourceId` header. This means ICOM stored your message for processing. It does not mean the message is valid or that the recipient has processed it: ICOM does not validate syntax or signature on receipt, so schema errors come back later as asynchronous messages from the SPI.

With the toolkit:

```ts
const client = new IcomClient({ baseUrl: "https://icom-h.pi.rsfn.net.br:16522", ispb, certPath, keyPath, caPath });
const { statusCode, resourceIds } = await client.sendMessages(xml); // 201, ["UEkB..."]
```

Or run `npx tsx scripts/spi/send-pix.ts 0.01 99999A04`, which sends the pacs.008 and reads the stream until the pacs.002 for its EndToEndId arrives.

### Common First-Message Mistakes

- **Invalid XML**: Schema validation errors. Validate against the XSD before sending
- **Wrong namespace or version**: Each message type and version has its own namespace (`https://www.bcb.gov.br/pi/pacs.008/1.16`) and `MsgDefIdr` (`pacs.008.spi.1.16`). A version not enabled in ICOM gets "Schema desconhecido ou nao habilitado para uso" -- check `GET /api/v1/in/catalog`
- **Malformed EndToEndId**: Must be exactly 32 characters: `E` + ISPB + `yyyyMMddHHmm` in **UTC** + 11 alphanumeric characters
- **Malformed BizMsgIdr**: Must be exactly 32 characters, starting with `M`
- **Wrong time zone**: `CreDt`, `CreDtTm` and `AccptncDtTm` are UTC with milliseconds and `Z`; the EndToEndId timestamp is UTC too (tolerance of 12 hours relative to the SPI)
- **Wrong ISPB in routing**: The BAH `To` field must be `00038166` (the SPI), not the receiving participant; the receiving PSP goes in `CdtrAgt`

## Receiving Your First pacs.002

After sending a `pacs.008` to the virtual participant `99999A04`, read your stream to receive the `pacs.002`:

```
GET https://icom-h.pi.rsfn.net.br:16522/api/v1/out/{ISPB}/stream/start
Accept: multipart/mixed
```

Follow `PI-Pull-Next` until the message arrives, then `DELETE` the last `PI-Pull-Next`. The `pacs.002` you receive comes **from the SPI** (`AppHdr/Fr` = `00038166`), after the virtual participant answered `ACSP` and the SPI processed the payment. It reports the final result: settlement confirmed, or `RJCT` with a reason code (for example `AB03` if the payment was not settled within the 40-second limit).

Parse the response XML, extract `TxSts` (and `StsRsnInf/Rsn/Cd` on rejections), and correlate it with the original `pacs.008` using `OrgnlEndToEndId`.

```ts
const msgs = await client.readUntil((m) => m.xml.includes(endToEndId), 40_000); // closes the stream
```

## Message Reading Mechanics

### Long Polling

You do not need to choose a polling interval. Each `GET` on the stream is held by ICOM for "some seconds" when there are no messages and then returns 204 with a new `PI-Pull-Next`; when a message arrives, the API answers at once. Issue the next `GET` immediately after each response, and store/hand off messages asynchronously so the next read is not delayed (delays between reads increase latency and cause duplicate deliveries).

The key time constraint comes from the *Manual de Tempos do Pix*: a Pix on the primary channel must settle within **40 seconds** counted from the payer PSP's acceptance (`AccptncDtTm`, t0') to settlement; otherwise the SPI rejects it with **`AB03`**. As a receiver you are measured on the time between the SPI making the pacs.008 available and your pacs.002 arriving: **p50 1.4 s, p95 2.3 s**. The capacity test also requires consuming 99% of the messages within 200 ms.

### Connection Limits

ICOM allows up to **6 simultaneous read streams per participant per channel** (above that it answers 429). Use them to parallelize message retrieval:

- Multiple read workers, each starting its own stream with `GET .../stream/start`
- With `Accept: multipart/mixed`, each response carries up to 10 messages
- Duplicates are still possible (redelivery); deduplicate by `PI-ResourceId`

For capacity testing, several streams with multipart and gzip are what makes the required throughput achievable.

### Reading Loop Architecture

A robust reading loop should:

1. Start a stream with `GET /api/v1/out/{ISPB}/stream/start`
2. If messages are returned (200), store them and hand them off for asynchronous processing
3. Whether 200 or 204, immediately `GET` the path in `PI-Pull-Next`
4. Handle errors gracefully (retry with backoff on 5xx/429, alert on 4xx; restart with `stream/start` if the stream is lost)
5. On shutdown, `DELETE` the last `PI-Pull-Next`

```
url = "/api/v1/out/{ISPB}/stream/start"
while (running) {
    response = GET(url)            // Accept: multipart/mixed, Accept-Encoding: gzip
    url = response.headers["PI-Pull-Next"]
    if response.status == 200:
        for message in response.messages:
            store_and_process_async(message)   // dedupe by PI-ResourceId
}
DELETE(url)
```

With the toolkit: `readStream(pullNext?)` returns `{ statusCode, messages, pullNext }` and `closeStream(pullNext)` sends the DELETE.

## Common Connectivity Issues and Solutions

### Header Restrictions

ICOM is strict about HTTP headers. **APM (Application Performance Monitoring) tools** are a frequent source of problems. Tools like Datadog, New Relic, and Dynatrace often inject custom HTTP headers (e.g., `x-datadog-trace-id`, `traceparent`) into outgoing requests via automatic instrumentation.

ICOM **may refuse requests with headers outside its whitelist** (ICOM manual, section 2.1.8). This manifests as errors that are extremely confusing if you do not know to look at the headers.

**Solution**: Disable APM auto-instrumentation for ICOM HTTP clients, or configure your APM tool to exclude ICOM endpoints from header injection. Only these headers are accepted:

- `Accept` (`application/xml`, `multipart/mixed` or `*/*`), `Accept-Encoding` (`gzip`)
- `Connection`, `Content-Encoding`, `Content-Length`, `Content-Type` (`application/xml; charset=utf-8`), `Cookie`
- `Host` (without port), `Max-Forwards`, `Transfer-Encoding`, `User-Agent`, `Via`

Custom `PI-*` or `x-*` request headers are not allowed.

### TLS Version Mismatch

ICOM requires HTTP/1.1 over **TLS 1.2** with mutual authentication, and the cipher suite `ECDHE-RSA-AES-128-GCM-SHA256` (0xc02f) must be supported. Ensure your HTTP client is configured accordingly and does not attempt to negotiate older versions.

### DNS Resolution

Within the RSFN network, DNS resolution for Bacen hostnames works differently from public DNS. Ensure your servers use the correct DNS configuration provided by your RSFN network provider. Bacen may re-point names or use DNS round-robin, so your HTTP client must respect DNS TTLs (do not cache resolved IPs forever).

### Connection Timeouts

If connections frequently time out, check:

- Network routing between your servers and the RSFN gateway
- Firewall rules (especially stateful firewalls that may drop idle connections)
- Load balancer timeout settings (if you have a load balancer between your app and RSFN)

## TCP keepAlive Configuration

Long-lived connections to ICOM benefit from TCP keepAlive to prevent intermediate network devices (firewalls, NAT gateways, load balancers) from dropping idle connections.

### Node.js Configuration

```javascript
const agent = new https.Agent({
  cert: fs.readFileSync('/path/to/client-cert.pem'),
  key: fs.readFileSync('/path/to/client-key.pem'),
  keepAlive: true,
  keepAliveMsecs: 30000, // Send keepAlive probe every 30 seconds
  maxSockets: 50,
  timeout: 60000,
});
```

### System-Level Configuration (Linux)

```bash
# /etc/sysctl.conf
net.ipv4.tcp_keepalive_time = 30
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 3
```

Without keepAlive, you may experience intermittent connection drops where the TCP connection is silently closed by an intermediate device, and your next request fails with a connection reset error. This is especially problematic for the reading loop, which maintains long-lived connections. Persistent connections are also what ICOM asks for: opening and closing connections too often can cause 503.

## Verifying Basic Connectivity Is Complete

You have successfully completed Phase 1 when:

1. Your system can authenticate via mTLS to ICOM
2. You can send a `pacs.008` and receive HTTP 201
3. Your reading loop (stream start, `PI-Pull-Next`, `DELETE`) successfully retrieves a `pacs.002` response
4. You can parse the `pacs.002` and extract the status (`TxSts`) and reason code
5. You can correlate the response to the original request via EndToEndId
6. Your connectivity is stable (no intermittent failures over a sustained period)

Document your connectivity configuration thoroughly. Include certificate paths, URLs, agent configuration, and any workarounds discovered. This documentation will be invaluable for the team as you move into functionality testing.

## Sources

- Manual das Interfaces de Comunicacao (ICOM) 1.12: https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf
- Roteiro para Participacao Direta no SPI v1.11: https://www.bcb.gov.br/content/estabilidadefinanceira/sistemapagamentosinstantaneos_docs/Roteiro_para_Participacao_Direta_no_SPI_e_abertura_de_Conta_PI.pdf
- Manual de Tempos do Pix 7.0: https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf
- Catalogo de Mensagens e Servicos do SPI 5.13.1: https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip

---

**Previous:** [01 - Prerequisites](./01-prerequisites.md) | **Next:** [03 - SPI Functionality](./03-spi-functionality.md)
