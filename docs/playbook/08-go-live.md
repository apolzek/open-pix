# 08 - Production Go-Live Preparation

## Overview

Going live as a Pix Direct Participant is a major milestone that requires meticulous preparation across infrastructure, operations, and compliance. This document covers the complete checklist from completing homologation to processing your first production Pix.

---

## Completion Checklist for All Homologation Phases

Before requesting production access, verify that all homologation phases have been completed and approved by Bacen:

### SPI (Sistema de Pagamentos Instantaneos)

- [ ] **SPI Functionality** -- the tests listed in the Roteiro (Fase 2)
  - [ ] Connectivity: `pibr.001` → `pibr.002` echo on the primary channel
  - [ ] Send pacs.008 and receive the SPI's pacs.002 confirming settlement (primary and secondary channels)
  - [ ] Receive pacs.008 and accept it with pacs.002 (primary and secondary channels)
  - [ ] Receive pacs.008 and reject it with pacs.002 + reason code before the SPI times out
  - [ ] Send pacs.004 and receive the SPI's pacs.002 confirming settlement
  - [ ] Receive pacs.004 and accept it; receive pacs.004 and reject it before the SPI times out
  - [ ] `camt.060` → `camt.053` (current and previous-day closing balance), `camt.054` (entry details), `camt.052` + ARQ file download (list of entries)
  - [ ] LPI liquidity transfers via STR/STR-Web (`LPI0001`, `LPI0003`; `LPI0002`/`LPI0004`/`LPI0005`/`LPI0006` when applicable)
  - [ ] Rediscount via Selic (`SEL1009`/`SEL1016`), or email to spi@bcb.gov.br declining it
  - [ ] Settlement service for indirect participants (`reda.014`/`reda.031` → `reda.016`), or email declining it
  - [ ] `reda.022` → `reda.016` (contact data) and handling of `admi.004` (SPI operational notices)
  - [ ] Block and unblock sending Pix manually in the SPI module of SPB-Web2
  - [ ] Message versions match what is enabled in the ICOM catalog (`GET /api/v1/in/catalog`; catalog 5.13: pacs.008 1.16, pacs.002 1.17, pacs.004 1.5)
  - [ ] ICOM stream reading working (`/out/{ispb}/stream/start` + `PI-Pull-Next` + final `DELETE`, up to 6 streams)
  - [ ] Multipart message consumption implemented
  - [ ] TCP connection reuse configured
- [ ] **SPI Capacity** -- Formal test with Bacen (Roteiro item 7), sending and receiving simultaneously for 10 minutes
  - [ ] Send 10,000 / 20,000 / 40,000 pacs.008 HIGH to 99999A04 (1,000 / 2,000 / 4,000 per minute, by number of accounts)
  - [ ] Receive the same volume from 99999A03 and accept all of them with pacs.002
  - [ ] Consume at least 99% of the messages the SPI makes available within 200 ms
  - [ ] As receiver, at least 50% of payments within 1.4s and 95% within 2.3s
  - [ ] k6 test infrastructure validated
- [ ] Complete test documentation kept (the Roteiro requires keeping it for 5 years)

### DICT (Diretorio de Identificadores)

- [ ] **DICT Functionality** -- Formal test with Bacen
  - [ ] Key CRUD for all 5 key types (CPF, CNPJ, EMAIL, PHONE, EVP)
  - [ ] Key lookups working for all key types
  - [ ] Portability claims (as claimer and as donor)
  - [ ] Ownership claims for PHONE keys (as claimer and as donor)
  - [ ] Infraction reports (create, receive, accept, reject, close)
  - [ ] Refund solicitations (create, receive, accept, reject)
  - [ ] DICT sync/polling mechanism working
  - [ ] Rate limiting implemented (token-bucket per user and operation)
- [ ] **DICT Capacity** -- Formal test with Bacen
  - [ ] Lookup volume agreed with Bacen executed successfully (the volume is not in the sources used here; in our experience it was in the order of 1,000+ lookups)

### QR Code

- [ ] Static QR code generation and parsing
- [ ] COB (dynamic QR) generation and parsing
- [ ] COBV (dynamic QR with due date) generation and parsing
- [ ] CRC-16 checksum validation
- [ ] Pix Tester validations passed (mandatory items marked with *)

### Additional Requirements

- [ ] Participant directory processing (camt.014 for new participants)
- [ ] Account balance and statement inquiries (camt.060 → camt.053 / camt.054 / camt.052)
- [ ] Settlement and reconciliation logic
- [ ] Availability index calculation
- [ ] Indirect participant support (reda.014) if applicable

---

## Production Certificate Setup

Production certificates are **different** from homologation certificates. You must obtain and configure new certificates for the production environment.

### Certificate Requirements

| Item | Homologation | Production |
|------|-------------|------------|
| Certificate authority | ICP-Brasil (homologation chain) | ICP-Brasil (production chain) |
| Delivery to Bacen | Before the homologation tests | Up to the business day before the start of operations (Roteiro, Fase 3) |
| Validity | Standard | Standard |

### Steps

1. **Generate new key pair** for production (do NOT reuse homologation keys)
2. **Obtain production certificate** from an ICP-Brasil accredited certificate authority
3. **Send the certificates to Bacen** (signature CERTPIA and channel CERTPIC) as specified in the Manual de Redes do SFN, the ICOM manual and the Manuais de Segurança do SFN e do Pix. The Roteiro requires this up to the business day before the start of operations; otherwise the start is cancelled and a new date must be informed
4. **Test connectivity on the production primary channel** (`pibr.001` → `pibr.002`) by the same deadline
5. **Test mTLS connectivity** to the other production endpoints (secondary channel, DICT, ARQ) before go-live date
6. **Configure certificate rotation** process for when certificates expire

### Certificate Management Best Practices

- Store production private keys in a hardware security module (HSM) or secure vault
- Implement certificate expiration monitoring (alert at 30, 14, and 7 days before expiry)
- Document the certificate renewal process
- Never share private keys between environments
- Have a backup certificate ready for emergency rotation

---

## Production ICOM Connection

The production ICOM (Interface de Comunicacao) URL is different from the homologation URL.

| Environment | ICOM URL | Port |
|-------------|----------|------|
| Homologation | `icom-h.pi.rsfn.net.br` (secondary: `icom-sec-h.pi.rsfn.net.br`) | 16522 (secondary: 17522) |
| Production | `icom.pi.rsfn.net.br` (secondary: `icom-sec.pi.rsfn.net.br`) | 16422 (secondary: 17422) |

DICT: `dict-h.pi.rsfn.net.br:16522` (homologation) and `dict.pi.rsfn.net.br:16422` (production), base path `/api/v2/`.

### Configuration Changes

- Update all endpoint URLs from homologation (`-h`) to production, including the ports (16522 → 16422, 17522 → 17422)
- Update DICT API endpoints similarly
- Verify DNS resolution for production endpoints from your infrastructure
- Test network connectivity and firewall rules for production endpoints
- Ensure your RSFN (Rede do Sistema Financeiro Nacional) network access includes production endpoints

### ICOM Connection Parameters (Production)

- Maximum simultaneous read streams per participant and channel: 6 (above that, 429)
- Up to 10 messages per multipart request or response
- Rate limit: token bucket (primary channel: 3,750 tokens, refilled at 750/s); 429 + `Retry-After` when exhausted
- Read timeout: longer than the long-polling wait of the stream (the toolkit uses 30 seconds)
- gzip (`Content-Encoding`) support is mandatory; recommended on the primary channel and mandatory on the secondary
- `Host` header without the port
- Keep-alive: enabled (reuse TCP connections)
- Do NOT send HTTP headers not defined in the communication interface manual

> "O BACEN eh bem restrito nos headers http, nao pode enviar headers que nao estejam definidos no manual da interface de comunicacao"

---

## PI Account Funding

Your PI (Pagamentos Instantaneos) account in production starts with **zero balance**. You cannot process Pix payments (pacs.008 as payer) until your PI account has funds.

### Funding Methods

1. **STR / STR-Web**: Transfer funds from your STR reserve/settlement account (RB/CL) to your PI account with `LPI0001` (institutions that are not STR participants use STR-Web)
2. **Receive Pix**: Have another participant send Pix payments to your keys, which will credit your PI account
3. **CCME account**: If you hold a CCME account at Bacen, transfer from it with `LPI0002` (and back with `LPI0004`)
4. **Automatic transfer**: STR participants and CCME holders can configure automatic transfers with `LPI0005` (confirmed by `LPI0006`)

### STR Web Process

In our experience the PI account is managed through Bacen's web interfaces (STR-Web and the SPI module of SPB-Web, where the Roteiro requires at least two operators registered in Autran, one with the Confirmation profile and one with the Alteration profile):

1. Access the web interface with your institutional credentials
2. Navigate to PI account management
3. Initiate transfer from STR to PI account
4. Confirm the transfer
5. Verify PI account balance

> "como voces colocam saldo na conta PI?"
> "E pelo str web. Um sistema de gestao da conta PI que o BACEN disponibiliza para os participantes"

### Settlement Bank Coordination

If you use a settlement bank (banco liquidante):
- Coordinate with your settlement bank's treasury team
- Ensure they understand the PI account funding process
- Establish a process for regular PI account top-ups
- Monitor PI account balance to avoid failed outgoing payments

---

## Production Monitoring Setup

### Observability Stack

Deploy comprehensive monitoring for your Pix infrastructure:

**Recommended stack:**
- **Metrics**: Prometheus + Grafana (or equivalent)
- **Logs**: ELK Stack (Elasticsearch, Logstash, Kibana) or Grafana Loki
- **Tracing**: Jaeger or OpenTelemetry
- **Alerting**: Grafana Alerting, PagerDuty, or OpsGenie

### Key Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|----------------|
| Transaction rate (TPS) | Pix transactions per second | N/A (baseline) |
| Latency p50 | Median time from `AccptncDtTm` to settlement | Internal baseline (for reference, the SPI's own time target is p50 2.8s / p99 4.6s) |
| Latency p95 | 95th percentile of the same | Internal choice, well below the 40s limit (e.g. > 10s) |
| Payer PSP time (t1 − t0') | Accept order → pacs.008 sent to SPI | p50 > 0.9s or p95 > 1.5s (Manual de Tempos) |
| Error rate | Percentage of failed transactions | > 1% |
| pacs.002 response time | Receiving PSP time (t3' − t2): incoming pacs.008 → pacs.002 | p50 > 1.4s or p95 > 2.3s (Manual de Tempos); the SPI rejects with AB03 if the Pix is not settled within 40s of `AccptncDtTm` |
| ICOM stream lag | Delay in consuming messages from ICOM | > 200 ms (the capacity test requires 99% consumed within 200 ms) |
| DICT lookup latency | Time for key lookups | > 2s |
| PI account balance | Available balance for outgoing Pix | < minimum threshold |
| Certificate expiry | Days until certificate expires | < 30 days |
| Availability index | Monthly availability (Manual de Tempos 4.3) | Below your category target (A 99.5%, B 99.0%, C 98.5%, D 95.0%) |

### Grafana Dashboard Recommendations

Build dashboards for:

1. **Real-time Operations**: Transaction rate, active connections, message queue depth
2. **Performance**: Latency histograms, throughput trends
3. **Errors**: Error rate by type (timeout, rejection, validation), error trend
4. **Infrastructure**: CPU, memory, network I/O, connection pool utilization
5. **Business**: Transaction volume by key type, average amount, top merchants

### Logging Best Practices

- Log every transaction with the `endToEndId` for traceability
- Log all ICOM interactions (send/receive) with timestamps
- Log DICT operations with response times
- Use structured logging (JSON format) for easy querying
- Implement log retention policies (minimum 90 days for regulatory compliance)
- Mask sensitive data (CPF, account numbers) in logs

---

## Incident Response Process

### Severity Levels

| Level | Description | Response Time | Example |
|-------|-------------|---------------|---------|
| P1 - Critical | Complete service outage | Immediate (< 15 min) | ICOM connection down, all Pix failing |
| P2 - High | Degraded service | < 30 min | High error rate, latency spike |
| P3 - Medium | Partial impact | < 2 hours | One key type failing, intermittent errors |
| P4 - Low | Minor issue | Next business day | Monitoring gap, non-critical bug |

### Response Playbook

**P1 - Critical Incident:**
1. Confirm the incident (check metrics, logs, try manual transactions)
2. Notify the on-call team immediately
3. Check Bacen environment status (is it a Bacen-side issue?)
4. Check with partner PSPs (are others experiencing the same issue?)
5. If Bacen-side: document and wait; if your-side: begin root cause analysis
6. Implement fix or workaround
7. Verify recovery
8. Post-incident review within 24 hours

**Common Bacen-side issues:**
- Homologation/production environment instability
- Certificate rotation on Bacen's side
- HTTP 403 errors affecting all participants
- DICT service degradation

> "vocEs estao conseguindo se conectar com o BACEN sem problemas hoje pela manha?"
> "estamos com problemas tambem [...] bateu um 403"
> "deve ser algo no bacen entao"

### Communication Templates

Prepare templates for:
- Internal incident notification
- Bacen incident report (if required)
- Customer communication (if Pix services are impacted)
- Post-incident report

---

## Gradual Rollout Strategy

Do not enable Pix for all customers on day one. Use a phased rollout:

### Phase 1: Internal Testing (Day 1-3)
- Process Pix transactions between internal test accounts
- Verify end-to-end flow in production
- Confirm monitoring and alerting works
- Test all key types with small amounts

### Phase 2: Limited Beta (Week 1-2)
- Enable Pix for a small group of trusted customers (e.g., 100)
- Monitor closely for any issues
- Collect feedback on user experience
- Verify settlement and reconciliation
- Test edge cases: returns, refunds, claims

### Phase 3: Controlled Expansion (Week 2-4)
- Gradually increase the customer base (1%, 5%, 10%, 25%)
- Increase transaction limits progressively
- Monitor system performance under growing load
- Address any issues before expanding further

### Phase 4: General Availability (Week 4+)
- Enable Pix for all customers
- Remove any temporary limits
- Full monitoring in place
- On-call rotation established

---

## Post-Go-Live Validation

### First 24 Hours

- [ ] At least one successful Pix IN (receive) processed
- [ ] At least one successful Pix OUT (send) processed
- [ ] pacs.002 responses are within timeout limits
- [ ] ICOM polling is consuming messages without lag
- [ ] DICT lookups returning correct results
- [ ] PI account balance is positive and sufficient
- [ ] No unexpected errors in logs
- [ ] Monitoring dashboards showing normal operation

### First Week

- [ ] Settlement reconciliation matches expected amounts
- [ ] Returns (pacs.004) processed correctly
- [ ] Key lifecycle operations working (create, delete)
- [ ] Availability index meeting SLA requirements
- [ ] No Bacen communications about issues
- [ ] Customer support volume is manageable

### First Month

- [ ] Consistent availability above SLA threshold
- [ ] Performance metrics stable (no degradation over time)
- [ ] All transaction types tested in production (static QR, COB, COBV)
- [ ] Claims processed successfully (at least one portability, one ownership)
- [ ] Infraction report flow tested (if applicable)
- [ ] Certificate expiration monitoring working

---

## Operational Considerations

### 24/7 Availability Requirement

Pix operates **24 hours a day, 7 days a week, 365 days a year**. Your systems must be available at all times.

**Requirements:**
- 24/7 on-call rotation for technical staff
- Automated failover for critical components
- Geographic redundancy recommended
- No planned maintenance windows that affect Pix availability
- Database maintenance must be non-disruptive (online migrations, zero-downtime deployments)

### SLA Expectations

| Metric | Target |
|--------|--------|
| Availability | Monthly target by category: A 99.5%, B 99.0%, C 98.5%, D 95.0% (new participants with no settled transactions are category D) |
| Receiving PSP (pacs.008 → pacs.002) | p50 1.4s, p95 2.3s |
| Payer PSP (acceptance → pacs.008) | p50 0.9s, p95 1.5s |
| End-to-end limit | 40 seconds from `AccptncDtTm` to settlement; after that the SPI rejects with AB03 |
| User experience (acceptance → payer notified) | p50 6s, p99 10s |
| Incident response | P1: < 15 minutes |

**Availability calculation:**
Per the Manual de Tempos (4.3), the index is `hours of effective service to end users / hours the service should be open (24x7)`, computed monthly by the participant itself (Bacen may request supporting data). Consider only the transactional service (payments and receipts; in the DICT, only lookups), inside and outside the SPI, on both channels, including failures of your PSTI and settlement agent. Do not count unavailability caused by the SPI, DICT, RSFN or other Bacen infrastructure, by end-user devices, or rejections for lack of liquidity.

> "Como voces estao calculando o indice de disponibilidade?"

Track this metric continuously and alert if it drops below threshold.

### Settlement and Reconciliation

**Settlement:**
- Pix settlement happens in real-time through the PI account
- Your PI account balance decreases with each outgoing Pix
- Your PI account balance increases with each incoming Pix
- Monitor PI account balance continuously

**Reconciliation:**
- Use camt.060 to request balances (camt.053), entry details (camt.054) or the list of entries (camt.052, which points to a file on ARQ)
- Note: files on ARQ are kept for only 24 hours; download them promptly
- Implement daily reconciliation between your internal ledger and PI account
- Track every transaction by `endToEndId`
- Reconcile settlement amounts with expected values
- Investigate any discrepancies immediately

**Daily reconciliation process:**
1. Request the list of entries (camt.052) via camt.060 and download the file from ARQ
2. Compare PI account movements with your internal transaction records
3. Identify and investigate any discrepancies
4. Generate reconciliation report
5. Archive for audit purposes

### Bacen Reporting Requirements

As a Direct Participant, you have ongoing reporting obligations:

**Regular reports:**
- Availability index: computed monthly by the participant; Bacen may request the data at any time (Manual de Tempos 4.3)
- Keep the responsible contacts up to date with `reda.022`
- Other reports (volumes, incidents, fraud/MED) follow the Pix regulation and were not checked against the sources used here

**Participant directory:**
- Process camt.014 messages to stay updated on new/changed participants
- Maintain a local participant directory
- The initial participant list can be loaded from a CSV published by Bacen (practical experience)
- camt.014 announces new participants (the Roteiro says each new direct participant's registration is communicated to all participants by camt.014)

**Regulatory compliance:**
- Maintain transaction records for regulatory audits
- Implement anti-money laundering (AML) checks on transactions
- Report suspicious transactions per regulatory requirements
- Maintain proper KYC documentation for account holders with Pix keys

### Infrastructure Recommendations

**Compute:**
- Use auto-scaling groups for transaction processing workloads
- Separate ICOM polling workers from transaction processing workers
- Dedicated resources for DICT operations

**Database:**
- Use a database that supports high write throughput (transaction logging)
- Implement read replicas for reporting queries
- Regular backup and tested restore procedures

**Networking:**
- Dedicated RSFN network connectivity
- Redundant network paths
- Monitor network latency to Bacen endpoints
- DNS configuration must be stable (avoid manual resolv.conf changes in production)

**Kubernetes (if applicable):**
- Use dedicated node pools for Pix workloads
- Implement pod disruption budgets
- Configure resource requests and limits
- Ensure cluster stability (k8s node failures can impact Pix availability)

> "quebrou um no do nosso k8s dev e atrasou um pouco"

This was in homologation -- in production, this must not happen. Design for resilience.

---

## Summary: Go-Live Checklist

```
PRE-GO-LIVE
[  ] All homologation phases passed (SPI, DICT, QR Code)
[  ] Declaration of aptitude sent (BC Correio or digital protocol, signed by the responsible director)
[  ] Approval communicated by Deban/Gemon (operations must start within 3 months)
[  ] Start date/time informed at least 3 business days in advance
[  ] Production certificates sent and pibr.001 echo tested by the business day before
[  ] reda.022 sent; two Autran operators registered for the SPB-Web SPI module
[  ] Production certificates obtained and installed
[  ] Production ICOM/DICT endpoints configured
[  ] RSFN production network access verified
[  ] PI account created and funded
[  ] Monitoring and alerting deployed
[  ] On-call rotation established
[  ] Incident response procedures documented
[  ] Rollout plan defined and communicated

GO-LIVE DAY
[  ] Final connectivity test to production endpoints
[  ] PI account balance verified
[  ] Monitoring dashboards live
[  ] First test transactions (internal)
[  ] Phase 1 rollout (internal testing)

POST-GO-LIVE
[  ] Daily reconciliation running
[  ] Availability index tracking
[  ] Performance baselines established
[  ] Gradual customer rollout progressing
[  ] Bacen reporting configured
```

Sources: [Roteiro para Participação Direta no SPI](https://www.bcb.gov.br/content/estabilidadefinanceira/sistemapagamentosinstantaneos_docs/Roteiro_para_Participacao_Direta_no_SPI_e_abertura_de_Conta_PI.pdf), [Manual de Tempos do Pix 7.0](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf), [ICOM manual 1.12](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf), [DICT API](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/API-DICT.html).
