# 06 - DICT Capacity Testing

## Overview

The DICT capacity test verifies that your system can perform a high volume of key lookups under load. Bacen requires you to successfully execute **1,000+ key lookups** against DICT within the test window. This is a formal homologation test scheduled separately from DICT functionality testing.

The capacity test is simpler than the SPI capacity test -- it only involves key lookups (GET requests), not full payment processing. However, you still need pre-registered keys to look up and must demonstrate that your system handles concurrent lookups without failures.

---

## Pre-Test Preparation

### Bacen Pre-Registered Keys

Before the DICT capacity test, Bacen pre-registers approximately **20,000 test keys** in the homologation DICT environment. These keys are associated with Bacen's virtual participant (ISPB `99999060`).

**Key formats:**

| Key Type | Range | Format |
|----------|-------|--------|
| EMAIL | 1,000,000 keys | `cliente-000000@pix.bcb.gov.br` to `cliente-999999@pix.bcb.gov.br` |
| PHONE | 10,000 keys | `+5561900000000` to `+5561900009999` |

These keys are available for lookup during the test. You do not need to create them -- Bacen does this before the test date.

### Partner PSP Keys

In addition to Bacen's keys, you should also have keys registered by your partner PSPs. During informal pre-testing, coordinate with partners to create test keys:

- Request 1,000+ keys from each partner PSP
- Mix key types (EMAIL, PHONE, CNPJ, CPF, EVP) for a realistic test
- Partners can share keys via CSV, JSON, or private gist

Example from real homologation experience:
```json
// Partner PSP shared 5,000 keys: 1,000 of each type
{
  "email": ["dict-test-001@partner.com", "..."],
  "phone": ["+5511900000001", "..."],
  "cnpj": ["27438925000175", "..."],
  "cpf": ["17878666024", "..."],
  "evp": ["925ab5a8-fbe3-428d-b0f5-051cfa1dea47", "..."]
}
```

---

## k6 Load Test Setup

Use [k6](https://k6.io/) (by Grafana Labs) to run the capacity test. k6 is well-suited for this because it handles HTTP/2, supports configurable concurrency, and produces clear metrics.

### Test Script Architecture

Rather than having k6 call DICT directly (which would require mTLS certificates), create an internal API endpoint that k6 calls, and that endpoint performs the DICT lookup.

```
k6 --> Your API Endpoint --> DICT API
```

This approach was validated during real homologation:

> "criamos um endpoint so para isso. o k6 chama esse endpoint e esse endpoint envia os requests"
> -- Woovi team

### k6 Configuration

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

// Load test keys from file
const keys = JSON.parse(open('./dict-test-keys.json'));

export const options = {
  scenarios: {
    dict_capacity: {
      executor: 'constant-arrival-rate',
      rate: 200,           // 200 requests per timeUnit
      timeUnit: '1m',      // per minute
      duration: '10m',     // 10 minutes total
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],  // 95% of requests under 5s
    http_req_failed: ['rate<0.05'],      // less than 5% failure rate
  },
};

export default function () {
  // Pick a random key from the test set
  const key = keys[Math.floor(Math.random() * keys.length)];

  const res = http.post('https://your-api.internal/dict/lookup',
    JSON.stringify({ keyType: key.type, keyValue: key.value }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response has account data': (r) => {
      const body = JSON.parse(r.body);
      return body.participant !== undefined;
    },
  });
}
```

### Key File Preparation

Prepare a JSON file with the keys to look up. For the formal test with Bacen, use their pre-registered keys:

```javascript
// generate-dict-test-keys.js
const keys = [];

// Bacen email keys
for (let i = 0; i < 1000; i++) {
  const padded = String(i).padStart(6, '0');
  keys.push({
    type: 'EMAIL',
    value: `cliente-${padded}@pix.bcb.gov.br`
  });
}

// Bacen phone keys
for (let i = 0; i < 1000; i++) {
  const padded = String(i).padStart(4, '0');
  keys.push({
    type: 'PHONE',
    value: `+556190000${padded}`
  });
}

console.log(JSON.stringify(keys, null, 2));
```

---

## DICT Lookup API

### Request Format

```
GET /api/v2/keys/{keyType}:{keyValue}
```

Headers:
```
Content-Type: application/xml
PI-RequestingParticipant: {your ISPB}
PI-PayerAccountServicer: {your ISPB}
```

The DICT API uses mTLS authentication with the same certificates used for other Bacen APIs.

### Response Format

A successful lookup returns XML with account details:

```xml
<KeyDetailsResponse>
  <Key>
    <Type>EMAIL</Type>
    <Value>cliente-000001@pix.bcb.gov.br</Value>
  </Key>
  <Account>
    <Participant>99999060</Participant>
    <Branch>0001</Branch>
    <AccountNumber>00000001</AccountNumber>
    <AccountType>CACC</AccountType>
  </Account>
  <Owner>
    <Type>LEGAL_PERSON</Type>
    <Name>Banco Central do Brasil</Name>
    <TaxIdNumber>00038166000105</TaxIdNumber>
  </Owner>
</KeyDetailsResponse>
```

---

## Concurrency and Rate Limiting

### DICT Rate Limits

DICT enforces rate limits using a token-bucket algorithm. Key limits:

- **Per-participant global limit**: varies by participant size
- **Per-operation limits**: lookups have higher limits than mutations
- **Per-user limits**: operations are tracked per end-user (CPF/CNPJ)

### Handling Rate Limits During Capacity Test

- Implement exponential backoff when receiving HTTP 429 responses
- Track your token consumption client-side to avoid hitting limits
- Use Redis or in-memory counters to pre-emptively throttle requests
- Space requests evenly rather than bursting

### Connection Management

Unlike ICOM (which has a formal 6-connection limit), DICT is a standard HTTPS API. However:

- **Reuse TCP connections** (keep-alive) to avoid TLS handshake overhead
- Monitor connection pool exhaustion under load
- In Node.js, ensure the HTTP agent is configured for connection reuse:

```javascript
const https = require('https');
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  cert: fs.readFileSync('cert.pem'),
  key: fs.readFileSync('key.pem'),
});
```

---

## Monitoring During the Test

### Key Metrics to Track

| Metric | Target | Description |
|--------|--------|-------------|
| Total lookups | >= 1,000 | Minimum required by Bacen |
| Success rate | >= 95% | Percentage of 200 responses |
| Latency p50 | < 500ms | Median response time |
| Latency p95 | < 2000ms | 95th percentile response time |
| Latency p99 | < 5000ms | 99th percentile response time |
| HTTP 429 rate | < 10% | Rate limit rejections |
| HTTP 5xx rate | < 1% | Server errors |

### Recommended Monitoring Setup

- **k6 output**: Use k6's built-in metrics or export to Grafana
- **Application logs**: Log every lookup with response time and status
- **Grafana dashboard**: Real-time visualization of lookup rate, latency, and errors
- **Alerting**: Alert on error rate > 10% or latency p95 > 5s

### k6 Output Example

```
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  scenarios: (100.00%) 1 scenario, 50 max VUs, 10m30s max duration
           dict_capacity: 200.00 iters/min for 10m0s

     ✓ status is 200
     ✓ response has account data

     checks.........................: 99.85% ✓ 3994  ✗ 6
     http_req_duration..............: avg=312ms  min=45ms  p(90)=680ms  p(95)=1.2s
     http_reqs......................: 2000   3.33/s
     iteration_duration.............: avg=315ms  min=48ms  p(90)=685ms  p(95)=1.2s
     iterations.....................: 2000   3.33/s
```

---

## Interpreting Results

### Passing Criteria

Bacen evaluates:
1. **Volume**: Did you complete 1,000+ lookups?
2. **Success rate**: Were most lookups successful?
3. **System stability**: Did your system remain stable throughout?

Bacen does not publish exact pass/fail thresholds, but from experience:
- 1,000 successful lookups is the minimum bar
- A few failures (< 5%) are acceptable
- The test is less demanding than SPI capacity (which requires 20,000 transactions)

### What Bacen Checks

- They monitor their side to see incoming lookup requests from your ISPB
- They verify that your lookups are properly formatted
- They may check that you handle different key types correctly

---

## Common Failure Modes

### HTTP 429 (Too Many Requests)
**Cause:** Exceeding DICT rate limits.
**Solution:** Reduce concurrency. Implement client-side rate limiting. Use exponential backoff on 429 responses.

### TLS Handshake Failures
**Cause:** Certificate issues or connection pool exhaustion.
**Solution:** Reuse TLS connections. Verify certificates are correctly configured. Monitor connection pool utilization.

### Timeouts from DICT
**Cause:** DICT service under load or network latency.
**Solution:** Set reasonable timeouts (10-15 seconds). Retry with backoff. These are usually transient.

### Bacen Environment Instability
**Cause:** The homologation environment occasionally has issues that affect all participants.
**Solution:** If you notice widespread failures (HTTP 403, connection resets), check with partner PSPs to confirm it is a Bacen-side issue. Wait and retry later. Real example from homologation:

> "vocES estao conseguindo se conectar com a API do BACEN sem problemas hoje pela manha?"
> "estamos com problemas tambem [...] bateu um 403 agora"
> "deve ser algo no bacen entao"

### Low Lookup Volume
**Cause:** k6 bottleneck, internal API bottleneck, or rate limiting too aggressive.
**Solution:**
- Increase k6 VUs
- Profile your internal lookup endpoint
- Ensure your endpoint does not have unnecessary processing
- Check that your internal rate limiter is not too restrictive for the test

### DNS Resolution Issues
**Cause:** DNS misconfiguration affecting DICT endpoint resolution.
**Solution:** Verify `/etc/resolv.conf` is correct. Use static DNS entries for Bacen endpoints during testing. This was a real issue encountered during homologation:

> "resolvi o bug do dns. eu tinha mexido no /etc/resolv.conf"

---

## Test Day Procedure

1. **Before the test:**
   - Confirm Bacen has pre-registered test keys
   - Verify your DICT lookup endpoint is working with a few manual lookups
   - Ensure monitoring/dashboards are ready
   - Have the k6 script and key files prepared

2. **During the test:**
   - A Bacen employee may call you to confirm readiness
   - Start the k6 test
   - Monitor metrics in real-time
   - If issues arise, address them and restart if needed

3. **After the test:**
   - Save k6 output and metrics screenshots
   - Verify total lookup count exceeds 1,000
   - Bacen will communicate results (pass/fail) -- typically on the same day or within a few days
   - If failed, you can reschedule (usually within 1-2 weeks)
