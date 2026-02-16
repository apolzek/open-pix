# Pix Direct Participant Homologation: SPI Capacity Testing

SPI capacity testing is the phase that separates functional correctness from production readiness. Bacen requires you to prove that your system can sustain high transaction throughput under load, operating as both sender and receiver simultaneously. This is where engineering fundamentals in concurrency, connection management, and performance optimization become critical.

## Bacen's Requirement

The current capacity requirement is:

**20,000 transactions processed in 10 minutes**

This breaks down to approximately **2,000 transactions per minute** or **~33 transactions per second**, sustained for the full 10-minute window.

"Processed" means:
- As a **sender**: You initiate `pacs.008` messages at the required rate and receive the corresponding `pacs.002` responses
- As a **receiver**: You receive incoming `pacs.008` messages at the required rate and respond with `pacs.002` messages within the 10-second timeout

You must operate as **both sender and receiver simultaneously** during the test. This is not two separate tests. Your system sends transactions while also receiving and responding to transactions at the same time.

## The Dual-Role Challenge

The simultaneous sender/receiver requirement is the core architectural challenge. Consider what happens at 2,000 TPS combined:

- Your **send path** must generate and transmit ~1,000 `pacs.008` messages per minute
- Your **receive path** must poll, parse, and respond to ~1,000 incoming `pacs.008` messages per minute with `pacs.002` responses
- Both paths share the same ICOM connections, CPU, memory, and network bandwidth
- The 10-second timeout for `pacs.002` responses remains in effect even under load

If your send path consumes too many resources, your receive path slows down and you start hitting timeouts. If your poll loop cannot keep up, incoming messages queue up at Bacen and you lose them to AB03 timeouts.

## Load Testing with k6

[k6](https://k6.io/) is an effective tool for generating the required load against your Pix system. The architecture we recommend is a **batch-sender** pattern: k6 drives the send side by calling your internal API at the required rate, while your Pix infrastructure handles both the outgoing sends and incoming polls/responses.

### Proven k6 Configuration

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    pix_capacity: {
      executor: 'constant-arrival-rate',
      rate: 2000,
      timeUnit: '1m',
      duration: '10m',
      preAllocatedVUs: 200,
      maxVUs: 500,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],   // Less than 1% failure rate
    http_req_duration: ['p(95)<3000'], // 95th percentile under 3 seconds
  },
};

export default function () {
  const payload = JSON.stringify({
    amount: 1,  // R$ 0.01
    destinationIspb: '99999004',
    // ... other required fields
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: '10s',
  };

  const res = http.post('http://your-internal-api/pix/send', payload, params);

  check(res, {
    'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
  });
}
```

### Key k6 Configuration Details

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `executor` | `constant-arrival-rate` | Maintains a steady request rate regardless of response time. This is essential because Bacen measures throughput, not concurrency. |
| `rate` | `2000` | Target rate: 2,000 transactions per minute |
| `timeUnit` | `1m` | Rate is measured per minute |
| `duration` | `10m` | Full 10-minute test window |
| `preAllocatedVUs` | `200` | Pre-create virtual users to avoid ramp-up delays |
| `maxVUs` | `500` | Allow k6 to scale up if requests take longer than expected |

### What k6 Drives

k6 does **not** talk directly to ICOM. It drives your internal Pix send API, which in turn:

1. Generates the `pacs.008` XML message
2. Sends it to ICOM via mTLS
3. Returns a response to k6 indicating the send was accepted

Meanwhile, your separate polling infrastructure handles the receive side independently.

## Infrastructure Recommendations

### Multiple Pods/Workers

A single Node.js process (single-threaded event loop) will typically max out at **800-1,000 concurrent operations** before the event loop starts blocking. For 2,000+ TPS combined (send + receive), you need multiple processes.

**Recommended architecture:**

- **3-4 sender worker pods**: Each handles a portion of the outgoing send load
- **3-4 receiver/poller pods**: Each maintains 1-2 ICOM polling connections and processes incoming messages
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

**`maxSockets: 50`** is a proven value. Going higher may trigger rate limiting or connection limits on the ICOM side. Going lower constrains your throughput.

### Separate Connection Pools for Poll vs Send

This is a critical optimization. If your poll connections and send connections share the same pool, a burst of sends can starve your poll loop (or vice versa), leading to timeouts on the receive side.

```javascript
// Dedicated pool for sending pacs.008
const sendAgent = new https.Agent({
  // ... certificate config ...
  keepAlive: true,
  maxSockets: 25,
});

// Dedicated pool for polling incoming messages
const pollAgent = new https.Agent({
  // ... certificate config ...
  keepAlive: true,
  maxSockets: 25,
});
```

This ensures that high send volume cannot deplete the connections available for polling, and vice versa.

### gzip Compression

Enable gzip compression for both request and response bodies. Pix XML messages are verbose and compress well (60-80% size reduction typical). This reduces network bandwidth and improves throughput.

```javascript
const zlib = require('zlib');

// Compress outgoing message
const compressed = zlib.gzipSync(xmlMessage);

const options = {
  hostname: 'icom-h.pi.rsfn.net.br',
  port: 16522,
  path: `/api/v1/out/${ISPB}/msgs`,
  method: 'POST',
  agent: sendAgent,
  headers: {
    'Content-Type': 'application/xml',
    'Content-Encoding': 'gzip',
    'Accept-Encoding': 'gzip',
  },
};
```

Verify that ICOM supports gzip by testing with a single compressed request first. The response may also be gzip-encoded; ensure your client handles decompression.

## Rehearsal Strategy

Do not attempt the full 2,000/min capacity test on your first try. Use a progressive rehearsal strategy to identify and fix bottlenecks incrementally.

### Step 1: Baseline (100 transactions/min)

- Run a 10-minute test at 100 TPS
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
- Poll loop falls behind, AB03 timeouts start appearing on the receive side
- Iterate on fixes: add workers, optimize XML generation, tune database queries

### Step 4: Target Load (2,000 transactions/min)

- Full target rate
- Run multiple rehearsals at this level
- Confirm the system sustains the rate for the full 10 minutes without degradation
- Monitor for memory leaks that only manifest over time
- Validate error rate stays below 1%

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
- If it exceeds 200ms, you will start failing the 10-second timeout on receives

### Mitigation

- Move CPU-intensive work to worker threads (`worker_threads` module)
- Use `setImmediate()` to break up long synchronous operations
- Pre-allocate and reuse buffers for XML generation
- Scale horizontally (more pods) rather than trying to optimize a single process beyond its limits

## Monitoring During the Test

### Metrics to Track in Real Time

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Send rate (pacs.008/min) | ~1,000/min | Below 800/min |
| Receive rate (pacs.002 received/min) | ~1,000/min | Below 800/min |
| Response rate (pacs.002 sent/min) | ~1,000/min | Below 800/min |
| Error rate | <1% | Above 2% |
| pacs.002 response latency (p95) | <5 seconds | Above 7 seconds |
| Event loop lag | <50ms | Above 100ms |
| ICOM connection count | Stable | Dropping or oscillating |
| CPU utilization (per pod) | <70% | Above 85% |
| Memory utilization (per pod) | Stable | Growing linearly (leak) |
| AB03 timeout count | 0 | Any occurrence |

### Dashboard Recommendations

Set up a real-time dashboard (Grafana, Datadog, or similar) with the above metrics before starting rehearsals. During the actual Bacen test, you need instant visibility into system behavior.

### Logging Strategy During Capacity Test

- **Reduce log verbosity**: Do not log the full XML of every message during capacity testing. Log message IDs, timestamps, and status codes only
- **Async logging**: Ensure logging does not block the event loop
- **Structured logging**: Use JSON-formatted logs for easy aggregation and analysis
- **Correlation IDs**: Include EndToEndId in all log entries for post-test analysis

## The Actual Bacen-Scheduled Test

### How It Works

1. **Scheduling**: Bacen schedules the capacity test in advance (typically with 1-2 weeks notice)
2. **Preparation**: You confirm readiness, pre-scale your infrastructure, and verify monitoring
3. **Test window**: Bacen triggers the test at the agreed time. For the 10-minute window:
   - Bacen's virtual participant sends `pacs.008` messages to you at the required rate
   - You must send `pacs.008` messages to the virtual participant at the required rate
   - Both happen simultaneously
4. **Bacen monitoring**: Bacen monitors throughput, error rates, and response times in real time on their side
5. **Completion**: After 10 minutes, the test ends. Bacen generates a report

### What Bacen Measures

- Total transactions successfully processed (target: 20,000)
- Throughput consistency (should be steady, not bursty)
- Error rate (rejections, timeouts, malformed messages)
- Response time distribution (AB03 timeouts are automatic failures)
- Whether you operated as both sender and receiver simultaneously

### On Test Day

- Pre-scale all infrastructure at least 30 minutes before the test
- Verify all monitoring dashboards are live
- Have the engineering team available for the duration
- Start a clean logging session so post-test analysis is easy
- Verify connectivity with a few test transactions before the window opens
- Have a communication channel open with Bacen's homologation team

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

**Fix**: Use round-robin load balancing for k6 traffic to your send workers. Ensure poll workers are evenly distributed across ICOM connections.

## Post-Test Reconciliation

After the capacity test, Bacen generates a reconciliation report available via STA. This report contains:

- Every transaction Bacen processed during the test window
- Timestamps for send and receive on Bacen's side
- Status of each transaction (success, timeout, rejection)
- Aggregate statistics (total, success rate, average response time)

### Reconciliation Steps

1. **Download the Bacen report** from STA
2. **Compare with your internal logs**: Match every transaction in Bacen's report with your internal records using EndToEndId
3. **Identify discrepancies**: Any transaction in Bacen's report that you do not have a record of indicates a gap in your system (lost message, missed poll, crash during processing)
4. **Analyze failures**: For every failed transaction, determine the root cause (timeout, rejection, connection error)
5. **Generate a summary**: Document total processed, success rate, failure categories, and any systemic issues

### Passing Criteria

Bacen evaluates:
- **Total volume**: Did you process 20,000 transactions in the 10-minute window?
- **Success rate**: Was the error rate acceptably low (typically <1%)?
- **Dual operation**: Did you operate as both sender and receiver simultaneously?
- **No systemic failures**: Were failures random/isolated or did they indicate a systemic problem?

If you fail, Bacen will typically allow you to reschedule after addressing the identified issues. Analyze the reconciliation report thoroughly before attempting again.

---

**Previous:** [03 - SPI Functionality](./03-spi-functionality.md) | **Next:** [05 - DICT Functionality](./05-dict-functionality.md)
