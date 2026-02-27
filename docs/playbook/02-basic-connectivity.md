# Pix Direct Participant Homologation: Basic Connectivity

This phase establishes your first working connection to Bacen's ICOM messaging API and validates that your infrastructure can exchange Pix messages. It is the foundation everything else builds on. Do not rush through it: a solid connectivity layer saves weeks of debugging in later phases.

## ICOM API Overview

ICOM (Interface de Comunicacao) is a **polling-based** HTTP API. This is a critical architectural detail that shapes your entire Pix integration.

There are no webhooks. There is no push notification system. There is no WebSocket connection. Your system must **actively poll** ICOM at regular intervals to check for incoming messages. If you stop polling, you stop receiving messages.

### The Polling Model

The flow works like this:

1. **Sending a message**: HTTP POST to ICOM with your XML message in the request body
2. **Receiving messages**: HTTP GET to ICOM, which returns any queued messages for your ISPB
3. **Acknowledging receipt**: Messages are dequeued once successfully retrieved (HTTP 200 response on your GET)

You must maintain a continuous polling loop that runs 24/7. Any gap in polling means incoming messages queue up at Bacen, and your counterparties will experience timeouts.

## ICOM URL Format

### Sending Messages (Outbox)

```
POST https://icom-h.pi.rsfn.net.br:16522/api/v1/out/{ISPB}/msgs
```

### Receiving Messages (Inbox)

```
GET https://icom-h.pi.rsfn.net.br:16522/api/v1/in/{ISPB}/msgs
```

Where `{ISPB}` is your 8-digit ISPB number (zero-padded if necessary).

Note the port: **16522**. This is not standard HTTPS (443). Ensure your network/firewall configuration allows outbound traffic to this port.

The `-h` in the hostname indicates the **homologation** environment. Production uses `icom.pi.rsfn.net.br`.

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
  https://icom-h.pi.rsfn.net.br:16522/api/v1/in/{ISPB}/msgs
```

- **CA bundle** (`ca` / `--cacert`): validates the **Bacen/RSFN server certificate chain**.
- **Client certificate + private key** (`cert`+`key` / `--cert`+`--key`): authenticate **your institution** to ICOM in mTLS.
- See also: [`ICOM API mTLS Requirements`](../reference/icom-api.md#mtls-requirements).

### Trust Chain

You must have the complete CA certificate chain for the RSFN servers in your trust store. If you get TLS errors like `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `CERT_UNTRUSTED`, the CA bundle is likely incomplete.

## First Successful Health Check

Before attempting to send or receive Pix messages, validate basic connectivity with a simple GET request to your inbox endpoint.

A successful response looks like:

- **HTTP 200** with an empty body or empty message list: Your connection is working, there are simply no messages queued
- **HTTP 204**: No content, also indicates a healthy connection with no pending messages

If you see:

- **HTTP 401/403**: Client certificate/private key authentication failed
- **HTTP 404**: Wrong ISPB or malformed URL
- **Connection refused / timeout**: Network connectivity issue (firewall, routing, port blocked)
- **TLS handshake failure**: Certificate problem (incomplete CA bundle/trust chain, wrong cert, expired cert, key mismatch)

Getting a successful health check response is your first milestone. Celebrate it. Many teams spend days resolving certificate and network issues to get here.

## Sending Your First pacs.008

Once connectivity is confirmed, send your first real Pix message: a `pacs.008` (FIToFICustomerCreditTransfer) for R$ 0.01 to Bacen's virtual participant (ISPB `99999004`).

### Message Structure

A `pacs.008` is wrapped in a Business Application Header (BAH). The complete XML structure is:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="urn:iso:std:iso:20022:tech:xsd:envelope">
  <AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.01">
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
            <Id>99999004</Id>
          </Othr>
        </FinInstnId>
      </FIId>
    </To>
    <BizMsgIdr>M{YOUR_ISPB}{RANDOM_CHARS}</BizMsgIdr>
    <MsgDefIdr>pacs.008.001.08</MsgDefIdr>
    <CreDt>2024-01-15T10:30:00.000Z</CreDt>
  </AppHdr>
  <Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.spi.1.13">
    <!-- pacs.008 body here -->
  </Document>
</Envelope>
```

### Sending the Message

```
POST https://icom-h.pi.rsfn.net.br:16522/api/v1/out/{ISPB}/msgs
Content-Type: application/xml

{XML body}
```

A successful send returns **HTTP 201** (Created). This means ICOM accepted your message for delivery. It does not mean the recipient has processed it yet.

### Common First-Message Mistakes

- **Invalid XML**: Schema validation errors. Validate against the XSD before sending
- **Wrong namespace**: Each pacs.008 version has its own XML namespace
- **Malformed EndToEndId**: Must be exactly 32 characters, starting with `E`
- **Malformed BizMsgIdr**: Must be exactly 32 characters, starting with `M`
- **Future timestamp**: CreDt must not be in the future relative to Bacen's clock
- **Wrong ISPB in routing**: The BAH `To` field must match the destination participant

## Receiving Your First pacs.002

After sending a `pacs.008` to the virtual participant `99999004`, poll your inbox to receive the `pacs.002` response.

```
GET https://icom-h.pi.rsfn.net.br:16522/api/v1/in/{ISPB}/msgs
```

The virtual participant typically responds within seconds. If the `pacs.008` was valid, you will receive a `pacs.002` with status `ACSP` (Accepted Settlement in Process), confirming the payment was accepted.

If the `pacs.008` had issues, you may receive a `pacs.002` with status `RJCT` (Rejected) and a reason code indicating what was wrong.

Parse the response XML, extract the status, and correlate it with the original `pacs.008` using the EndToEndId.

## Message Polling Mechanics

### Polling Frequency

Poll as frequently as practical. In production, a polling interval of **100-500ms** is common. During homologation, you can start with a longer interval (1-2 seconds) and optimize later.

The key constraint is the **10-second timeout**: when another participant sends you a `pacs.008`, you have 10 seconds to respond with a `pacs.002`. If your polling interval is too long, you may not even see the incoming message before the timeout expires.

### Connection Limits

ICOM supports up to **6 simultaneous connections** per ISPB for polling. You can use this to parallelize message retrieval:

- Multiple poll workers, each maintaining its own connection
- Each GET request returns a batch of messages (not just one)
- Messages are distributed across connections (you won't get duplicates)

For capacity testing, using all 6 connections is essential to achieve the required throughput.

### Polling Loop Architecture

A robust polling loop should:

1. Make a GET request to the inbox
2. If messages are returned, process them immediately
3. If no messages (HTTP 200 with empty body or 204), wait briefly and poll again
4. Handle errors gracefully (retry with backoff on 5xx, alert on 4xx)
5. Never stop polling unless the application is intentionally shutting down

```
while (running) {
    messages = poll_inbox()
    if messages:
        for message in messages:
            process_async(message)
    else:
        sleep(polling_interval)
}
```

Process messages asynchronously to avoid blocking the polling loop. A slow message handler should not delay receipt of the next batch.

## Common Connectivity Issues and Solutions

### Header Restrictions

ICOM is strict about HTTP headers. **APM (Application Performance Monitoring) tools** are a frequent source of problems. Tools like Datadog, New Relic, and Dynatrace often inject custom HTTP headers (e.g., `x-datadog-trace-id`, `traceparent`) into outgoing requests via automatic instrumentation.

ICOM **rejects requests with unrecognized headers**. This manifests as HTTP 400 errors that are extremely confusing if you do not know to look at the headers.

**Solution**: Disable APM auto-instrumentation for ICOM HTTP clients, or configure your APM tool to exclude ICOM endpoints from header injection. Keep only the standard headers:

- `Content-Type: application/xml`
- `Accept: application/xml`
- Standard HTTP/1.1 headers (Host, Connection, etc.)

### TLS Version Mismatch

RSFN may require specific TLS versions (TLS 1.2 or 1.3). Ensure your HTTP client is configured to support the required version and does not attempt to negotiate older versions.

### DNS Resolution

Within the RSFN network, DNS resolution for Bacen hostnames works differently from public DNS. Ensure your servers use the correct DNS configuration provided by your RSFN network provider.

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

Without keepAlive, you may experience intermittent connection drops where the TCP connection is silently closed by an intermediate device, and your next request fails with a connection reset error. This is especially problematic for the polling loop, which maintains long-lived connections.

## Verifying Basic Connectivity Is Complete

You have successfully completed Phase 1 when:

1. Your system can authenticate via mTLS to ICOM
2. You can send a `pacs.008` and receive HTTP 201
3. Your polling loop successfully retrieves a `pacs.002` response
4. You can parse the `pacs.002` and extract the status (ACSP/RJCT)
5. You can correlate the response to the original request via EndToEndId
6. Your connectivity is stable (no intermittent failures over a sustained period)

Document your connectivity configuration thoroughly. Include certificate paths, URLs, agent configuration, and any workarounds discovered. This documentation will be invaluable for the team as you move into functionality testing.

---

**Previous:** [01 - Prerequisites](./01-prerequisites.md) | **Next:** [03 - SPI Functionality](./03-spi-functionality.md)
