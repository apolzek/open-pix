# Pix Direct Participant Homologation: SPI Capacity Testing

SPI capacity testing is the phase that separates functional correctness from production readiness. Bacen requires you to prove that your system can sustain high transaction throughput under load, operating as both sender and receiver simultaneously. This is where engineering fundamentals in concurrency, connection management, and performance optimization become critical.

## Bacen's Requirement

The requirement comes from item 7 of the *Roteiro para Participacao Direta no SPI* (v1.11). The volume depends on the size of your PSP (number of transactional accounts), and is the same for the sending and the receiving side:

| PSP size | pacs.008 over 10 minutes | Rate |
|----------|--------------------------|------|
| Up to 1 million accounts | **10,000** | 1,000/min (~17/s) |
| Up to 10 million accounts | **20,000** | 2,000/min (~33/s) |
| More than 10 million accounts | **40,000** | 4,000/min (~67/s) |

Participants in the *liquidante especial* modality use the 40,000 tier; *instituicao usuaria* participants use the 10,000 tier. All messages go through the **primary channel** with priority `HIGH`, spread over the 10 minutes.

"Processed" means:
- As a **payer** (item 7.a): you send the `pacs.008` messages with `99999A04` (Cooperativa de Credito Virtual, which answers every pacs.008 with `ACSP`) as creditor, and consume the `pacs.002` messages the SPI sends back. Pass criteria: the complete settlement cycle with the expected volume happens within the 10 minutes, and you consume **at least 99% of the pacs.002 within 200 ms** of the SPI making them available.
- As a **receiver** (item 7.b): Bacen (Deban/Gemon) sends you `pacs.008` messages from `99999A03` (Banco Virtual; payer CACC, branch 1, account 1, CPF 11111111111, name "Fulano"; receiver CACC, branch 1, account 1, CPF 11111111111) and you accept them, without rejection, by sending `pacs.002`. Pass criteria: the complete cycle within the 10 minutes; **at least 99% of the pacs.008 and pacs.002 consumed within 200 ms**; and **at least 50% of the payments received within 1.4 s and at least 95% within 2.3 s**.

Success also requires meeting the SLAs of the *Manual de Tempos do Pix*, as computed by the SPI: every Pix must settle within **40 seconds** counted from `AccptncDtTm` (the payer PSP's acceptance, t0'); after that the SPI rejects it with **`AB03`**.

You must operate as **both payer and receiver simultaneously** during the test. This is not two separate tests. Your system sends transactions while also receiving and responding to transactions at the same time.

## The Dual-Role Challenge

The simultaneous payer/receiver requirement is the core architectural challenge. Consider the 20,000 tier (2,000/min on each side):

- Your **send path** must generate and transmit ~2,000 `pacs.008` messages per minute and consume the matching `pacs.002` from the SPI within 200 ms
- Your **receive path** must read, parse, and answer ~2,000 incoming `pacs.008` messages per minute with `pacs.002`, fast enough for the 1.4 s (p50) / 2.3 s (p95) receiver criteria
- Both paths share the same ICOM connections (at most 6 read streams per channel), CPU, memory, and network bandwidth
- The ICOM token bucket applies: primary channel bucket of 3,750 tokens refilled at 750/s; 1 token per pacs.008 operation, 0.2 per pacs.002 operation. The capacity volumes fit comfortably, but retry storms do not (429 + `Retry-After`)

If your send path consumes too many resources, your receive path slows down and you miss the 1.4 s/2.3 s targets. If your reading loop cannot keep up, incoming messages queue up at Bacen, the 200 ms consumption criterion fails, and payments start hitting the 40 s limit (`AB03`).

## Load Testing with k6

[k6](https://k6.io/) is an effective tool for generating the required load against your Pix system. The architecture we recommend is a **batch-sender** pattern: k6 drives the send side by calling your internal API at the required rate, while your Pix infrastructure handles both the outgoing sends and the incoming reads/responses.

### k6 Configuration

The toolkit ships `scripts/spi/k6-spi-capacity.js`, which drives `scripts/spi/batch-sender.ts`:

```bash
npx tsx scripts/spi/batch-sender.ts                   # HTTP endpoint that sends pacs.008 via ICOM
PSP_TIER=medium k6 run scripts/spi/k6-spi-capacity.js # small=1,000/min, medium=2,000/min, large=4,000/min
```

(`BATCH_SENDER_URL` overrides the default `http://localhost:3100`.) The core of the configuration:

```javascript
import http from 'k6/http';
import { check } from 'k6';

const TIERS = { small: 1000, medium: 2000, large: 4000 };
const BATCH_SENDER_URL = __ENV.BATCH_SENDER_URL || 'http://localhost:3100';
const RATE_PER_MIN = TIERS[__ENV.PSP_TIER || 'medium'];

export const options = {
  scenarios: {
    spi_capacity: {
      executor: 'constant-arrival-rate',
      rate: RATE_PER_MIN,
      timeUnit: '1m',
      duration: '10m',
      preAllocatedVUs: 20,
      maxVUs: 500,
    },
  },
  thresholds: {
    pix_success_rate: ['rate>0.95'],
    pix_latency: ['p(95)<5000'],
  },
};

export default function () {
  // The sender (batch-sender.ts or your own API) builds the pacs.008 with
  // CdtrAgt 99999A04, Bacen's virtual credit union that answers ACSP.
  const payload = JSON.stringify({ amount: 0.01 });

  const res = http.post(`${BATCH_SENDER_URL}/send`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });

  check(res, {
    'ICOM stored the message (201)': (r) => r.status === 201,
  });
}
```

The k6 thresholds are rehearsal guardrails for your own API, not Bacen's criteria. Bacen's criteria are the ones in [Bacen's Requirement](#bacens-requirement), measured by the SPI.

### Key k6 Configuration Details

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `executor` | `constant-arrival-rate` | Maintains a steady request rate regardless of response time. The Roteiro requires the messages to be distributed over the 10 minutes, not sent in bursts. |
| `rate` | `1000` / `2000` / `4000` | Target rate per minute for your tier (`PSP_TIER`) |
| `timeUnit` | `1m` | Rate is measured per minute |
| `duration` | `10m` | Full 10-minute test window |
| `preAllocatedVUs` | `20` | Pre-create virtual users to avoid ramp-up delays; raise it for the 4,000/min tier |
| `maxVUs` | `500` | Allow k6 to scale up if requests take longer than expected |

### What k6 Drives

k6 does **not** talk directly to ICOM. It drives your internal Pix send API, which in turn:

1. Generates the `pacs.008` XML message
2. Sends it to ICOM via mTLS (`POST /api/v1/in/{ISPB}/msgs`, optionally batching up to 10 messages per request with `multipart/mixed`)
3. Returns a response to k6 indicating the send was accepted

Meanwhile, your separate reading infrastructure (streams on `GET /api/v1/out/{ISPB}/stream/start` + `PI-Pull-Next`) handles the receive side independently: the pacs.002 answers to your sends and the incoming pacs.008 from `99999A03`.

## Infrastructure Recommendations

### Multiple Pods/Workers

A single Node.js process (single-threaded event loop) will typically max out at **800-1,000 concurrent operations** before the event loop starts blocking. For 2,000+ messages per minute on each side (send + receive), you need multiple processes. (This limit is practical experience with Node.js, not a Bacen rule.)

**Recommended architecture:**

- **3-4 sender worker pods**: Each handles a portion of the outgoing send load
- **3 receiver/reader pods**: Each maintains 1-2 ICOM read streams (6 streams in total is the ICOM limit per participant per channel; above it you get 429) and hands messages off for asynchronous processing
- **Separate k6 load generator**: Runs on dedicated infrastructure so it does not compete for resources with your Pix workers

Use Kubernetes horizontal pod autoscaling or a similar mechanism, but for the capacity test specifically, **pre-scale to your target pod count**. Do not rely on autoscaling during the test; it is too slow to react and the 10-minute window does not leave room for ramp-up.

### TCP Connection Pooling

Connection pooling is critical. Creating a new TLS connection for every request adds hundreds of milliseconds of overhead (TLS handshake + TCP handshake). Reuse connections aggressively.

```javascript
const https = require('https');
const fs = require('fs');

// Shared HTTPS agent with connection pooling
const icomAgent = new https.Agent({
  cert: fs.readFileSync('/path/to/client-cert.pem'),
  key: fs.readFileSync('/path/to/client-key.pem'),
  ca: fs.readFileSync('/path/to/rsfn-ca-bundle.pem'),
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,          // Up to 50 concurrent connections
  maxFreeSockets: 10,      // Keep 10 idle connections ready
  timeout: 60000,
});
```

**`maxSockets: 50`** has worked well in practice (it is not a Bacen number). ICOM does not publish a connection limit for sending, but too many simultaneous connections, or connections opened and closed too often, produce 503. Going lower constrains your throughput; `multipart/mixed` (up to 10 messages per POST) reduces the number of requests you need.

### Separate Connection Pools for Read vs Send

This is a critical optimization. If your read connections and send connections share the same pool, a burst of sends can starve your read streams (or long-polled reads can hold every socket), leading to delays on the receive side. The toolkit's `IcomClient` keeps two agents internally for this reason.

```javascript
// Dedicated pool for sending pacs.008
const sendAgent = new https.Agent({
  // ... certificate config ...
  keepAlive: true,
  maxSockets: 25,
});

// Dedicated pool for reading incoming messages (ICOM allows 6 read streams)
const readAgent = new https.Agent({
  // ... certificate config ...
  keepAlive: true,
  maxSockets: 6,
});
```

This ensures that high send volume cannot deplete the connections available for reading, and vice versa.

### gzip Compression

Enable gzip compression for both request and response bodies. Support for gzip is mandatory in ICOM, and its use is recommended on the primary channel (mandatory on the secondary). Pix XML messages are verbose and compress well. This reduces network bandwidth and improves throughput, especially combined with `multipart/mixed` on reads (`Accept: multipart/mixed`, up to 10 messages per response, the whole response compressed).

```javascript
const zlib = require('zlib');

// Compress outgoing message
const compressed = zlib.gzipSync(xmlMessage);

const options = {
  hostname: 'icom-h.pi.rsfn.net.br',
  port: 16522,
  path: `/api/v1/in/${ISPB}/msgs`,
  method: 'POST',
  agent: sendAgent,
  headers: {
    'Host': 'icom-h.pi.rsfn.net.br',          // without the port
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Encoding': 'gzip',
    'Content-Length': compressed.length,
    'Accept-Encoding': 'gzip',
  },
};
```

The toolkit's `IcomClient.sendMessages()` does all of this (gzip, `Content-Type`, `Host` without port, multipart for up to 10 messages). The response may also be gzip-encoded; ensure your client handles decompression.

## Rehearsal Strategy

Do not attempt the full capacity test at your tier's rate on your first try. The steps below use the 2,000/min tier as an example; scale them to 1,000/min or 4,000/min. Use a progressive rehearsal strategy to identify and fix bottlenecks incrementally.

### Step 1: Baseline (100 transactions/min)

- Run a 10-minute test at 100 transactions per minute
- Validate that your end-to-end pipeline works under any load
- Confirm monitoring, logging, and error tracking are working
- Identify any connection stability issues

### Step 2: Medium Load (500 transactions/min)

- 5x increase from baseline
- Start seeing resource contention (CPU, connections, memory)
- Identify the first bottleneck (usually event loop blocking or connection pool exhaustion)
- Tune connection pool sizes and worker counts

### Step 3: High Load (1,000 transactions/min)

- Half of the target rate
- This is where most architectures first encounter serious issues
- Event loop blocking becomes apparent
- Reading loop falls behind, consumption time climbs past 200 ms, and eventually `AB03` (40 s limit exceeded) rejections appear
- Iterate on fixes: add workers, optimize XML generation, tune database queries

### Step 4: Target Load (2,000 transactions/min)

- Full target rate
- Run multiple rehearsals at this level
- Confirm the system sustains the rate for the full 10 minutes without degradation
- Monitor for memory leaks that only manifest over time
- Validate that there are no rejections on the receiving side (the Roteiro requires accepting all orders "sem rejeicao")

### Step 5: Headroom (2,500-3,000 transactions/min)

- Test above target to ensure you have margin
- Production traffic is unpredictable; capacity tests should prove you have headroom
- If you can sustain 2,500/min cleanly, 2,000/min during the actual test is comfortable

## Event Loop Blocking Mitigation

In Node.js, the event loop is the bottleneck that most teams underestimate. Operations that block the event loop (even briefly) compound under high concurrency and cause cascading failures.

### Common Blockers

- **XML parsing**: Synchronous XML parsing of large messages blocks the event loop. Use streaming or async XML parsers
- **XML generation**: Template-based XML generation with string concatenation can block on large messages. Pre-compile templates
- **gzip compression/decompression**: Use async `zlib.gzip()` / `zlib.gunzip()` instead of synchronous variants
- **JSON serialization**: Large payloads with `JSON.stringify()` / `JSON.parse()` can block
- **Certificate loading**: Load certificates once at startup, not per-request
- **Logging**: Synchronous file-based logging blocks under high volume. Use async loggers or log to stdout with an external collector

### Detection

- Monitor event loop lag using libraries like `monitorEventLoopDelay` (Node.js built-in) or `event-loop-lag`
- If event loop lag exceeds 50ms consistently, you are blocking
- If it exceeds 200ms, you will fail the 200 ms consumption criterion and drift away from the 1.4 s/2.3 s receiver targets

### Mitigation

- Move CPU-intensive work to worker threads (`worker_threads` module)
- Use `setImmediate()` to break up long synchronous operations
- Pre-allocate and reuse buffers for XML generation
- Scale horizontally (more pods) rather than trying to optimize a single process beyond its limits

## Monitoring During the Test

### Metrics to Track in Real Time

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Send rate (pacs.008/min) | Your tier (1,000 / 2,000 / 4,000) | Below 90% of tier |
| Incoming pacs.008 rate | Your tier | Below 90% of tier |
| Response rate (pacs.002 sent/min) | Equal to incoming pacs.008 | Any backlog |
| Consumption time (SPI availability -> read), p99 | <200ms | Above 150ms |
| Receiver time (pacs.008 available -> pacs.002 at SPI), p50 / p95 | <1.4s / <2.3s | Above 1.0s / 1.8s |
| Error rate (HTTP 4xx/5xx, 429) | 0 | Any sustained occurrence |
| Event loop lag | <50ms | Above 100ms |
| ICOM read streams | Stable (<= 6) | Dropping, oscillating, or 429 |
| CPU utilization (per pod) | <70% | Above 85% |
| Memory utilization (per pod) | Stable | Growing linearly (leak) |
| AB03 rejection count | 0 | Any occurrence |

### Dashboard Recommendations

Set up a real-time dashboard (Grafana, Datadog, or similar) with the above metrics before starting rehearsals. During the actual Bacen test, you need instant visibility into system behavior.

### Logging Strategy During Capacity Test

- **Reduce log verbosity**: Do not log the full XML of every message during capacity testing. Log message IDs, timestamps, and status codes only
- **Async logging**: Ensure logging does not block the event loop
- **Structured logging**: Use JSON-formatted logs for easy aggregation and analysis
- **Correlation IDs**: Include EndToEndId in all log entries for post-test analysis

## The Actual Bacen-Scheduled Test

### How It Works

1. **Scheduling**: You send an email to **spi@bcb.gov.br** (model in Annex II of the Roteiro; see `templates/bacen-scheduling-email.md`) booking a **one-hour window** on a business day, starting at **9h, 10h, 13h, 14h, 20h, 21h or 22h**. Both tests (payer and receiver) must run inside that window. If the slot is taken, Deban/Gemon contacts you to agree on another date/time.
2. **Preparation**: You confirm readiness, pre-scale your infrastructure, and verify monitoring
3. **Test window**: Deban/Gemon calls the person responsible for the tests at the phone number you provided and explains the procedure. For the 10-minute run:
   - Bacen sends you `pacs.008` messages (payer `99999A03`) at your tier's rate
   - You send `pacs.008` messages (creditor `99999A04`) at your tier's rate
   - Both happen simultaneously
4. **Bacen monitoring**: Deban/Gemon follows the execution
5. **Completion**: Deban/Gemon tells you the result (success or failure) right after the execution. If you fail, you may repeat the test if there is time left in the window, or book a new date

### What Bacen Measures

- Complete settlement cycle with the expected volume (10,000 / 20,000 / 40,000 per side) within the 10 minutes
- Consumption within 200 ms of at least 99% of the pacs.002 (payer side) and of the pacs.008 and pacs.002 (receiver side)
- Receiver capacity: at least 50% of the payments within 1.4 s and 95% within 2.3 s
- Acceptance of all incoming orders, without rejection
- The *Manual de Tempos do Pix* SLAs computed by the SPI (40 s limit; `AB03` rejections count against you)
- Whether you operated as both payer and receiver simultaneously

### On Test Day

- Pre-scale all infrastructure at least 30 minutes before the test
- Verify all monitoring dashboards are live
- Have the engineering team available for the duration
- Start a clean logging session so post-test analysis is easy
- Verify connectivity with a few test transactions before the window opens
- Keep the phone number you gave Bacen staffed; Deban/Gemon calls it to run the test

## Common Failure Modes and Recovery

### Connection Pool Exhaustion

**Symptom**: Requests start queuing, latency spikes, eventual timeouts.

**Cause**: More concurrent requests than `maxSockets` allows. Connections are not being returned to the pool fast enough.

**Fix**: Increase `maxSockets`, ensure response bodies are fully consumed (unconsumed responses hold connections open), add error handling that releases connections on failure.

### Event Loop Saturation

**Symptom**: Response times degrade progressively. Event loop lag climbs. All operations slow down, not just one type.

**Cause**: Synchronous operations blocking the event loop under load.

**Fix**: Profile with `--prof` or a continuous profiler. Identify and async-ify blocking operations. Add worker threads for CPU-intensive work. Scale horizontally.

### Memory Leak Under Load

**Symptom**: Memory usage climbs steadily during the test. May lead to OOM kills or garbage collection pauses.

**Cause**: Common culprits: unbounded in-memory queues, accumulating promise chains, retained XML strings, growing Maps/Sets for tracking in-flight transactions.

**Fix**: Use heap snapshots to identify the leak. Implement bounded queues with back-pressure. Ensure completed transactions are cleaned up from tracking structures.

### Network Saturation

**Symptom**: Throughput plateaus below target despite available CPU and memory.

**Cause**: Network bandwidth between your infrastructure and RSFN is fully utilized, especially without gzip compression.

**Fix**: Enable gzip compression. Reduce message size (remove optional fields not needed for the test). Verify network capacity with your RSFN provider.

### Uneven Load Distribution

**Symptom**: Some worker pods are overloaded while others are idle.

**Cause**: Poor load balancing. If using a hash-based load balancer, the distribution may be uneven for Pix-specific traffic patterns.

**Fix**: Use round-robin load balancing for k6 traffic to your send workers. Ensure reader workers are evenly distributed across ICOM read streams.

## Post-Test Reconciliation

The Roteiro does not define a reconciliation file for the capacity test: Deban/Gemon informs the result right after the execution, and during the homologation you can ask for the "Resumo dos Resultados dos Testes Homologatorios no SPI" at spi@bcb.gov.br. Still, do your own reconciliation -- you must keep complete test documentation for **5 years** for possible analysis by Bacen.

### Reconciliation Steps

1. **Collect your logs**: every pacs.008 sent (EndToEndId, `AccptncDtTm`, `PI-ResourceId`), every pacs.002 read (with read time), every incoming pacs.008 and the pacs.002 you answered
2. **Match by EndToEndId**: each pacs.008 you sent must have a final pacs.002 from the SPI; each incoming pacs.008 must have your pacs.002
3. **Identify discrepancies**: missing matches indicate a gap in your system (lost message, stream not closed with `DELETE`, crash during processing); duplicates by `PI-ResourceId` are expected occasionally and must be deduplicated
4. **Analyze failures**: for every rejection, determine the root cause (`AB03` timeout, other reason codes, HTTP errors)
5. **Compute the criteria yourself**: consumption-time percentiles (200 ms / 99%) and receiver-time percentiles (1.4 s p50, 2.3 s p95)
6. **Generate a summary**: document totals, success rate, failure categories, and any systemic issues

### Passing Criteria

Bacen evaluates:
- **Total volume**: Did the full cycle for your tier (10,000 / 20,000 / 40,000 per side) complete within the 10-minute window?
- **Consumption time**: At least 99% of the messages consumed within 200 ms?
- **Receiver time**: At least 50% within 1.4 s and 95% within 2.3 s?
- **Dual operation**: Did you operate as both payer and receiver simultaneously, accepting all incoming orders?

If you fail, you can repeat the test within the same window if time allows, or book a new date and time. Analyze your own logs thoroughly before attempting again.

## Sources

- Roteiro para Participacao Direta no SPI v1.11, item 7: https://www.bcb.gov.br/content/estabilidadefinanceira/sistemapagamentosinstantaneos_docs/Roteiro_para_Participacao_Direta_no_SPI_e_abertura_de_Conta_PI.pdf
- Manual de Tempos do Pix 7.0: https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf
- Manual das Interfaces de Comunicacao (ICOM) 1.12: https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf

---

**Previous:** [03 - SPI Functionality](./03-spi-functionality.md) | **Next:** [05 - DICT Functionality](./05-dict-functionality.md)
