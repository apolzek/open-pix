# 08 - Production Go-Live Preparation

## Overview

Going live as a Pix Direct Participant is a major milestone that requires meticulous preparation across infrastructure, operations, and compliance. This document covers the complete checklist from completing homologation to processing your first production Pix.

---

## Completion Checklist for All Homologation Phases

Before requesting production access, verify that all homologation phases have been completed and approved by Bacen:

### SPI (Sistema de Pagamentos Instantaneos)

- [ ] **SPI Functionality** -- Bacen validates before capacity testing
  - [ ] Send pacs.008 (credit transfer) and receive pacs.002 (status response)
  - [ ] Receive pacs.008 and respond with pacs.002 (accept and reject scenarios)
  - [ ] Send pacs.004 (return/refund) and receive confirmation
  - [ ] Receive pacs.004 and process return
  - [ ] Handle message versioning (support multiple pacs versions, e.g., 1.11 and 1.13)
  - [ ] ICOM polling mechanism working (up to 6 concurrent connections)
  - [ ] Multipart message consumption implemented
  - [ ] TCP connection reuse configured
- [ ] **SPI Capacity** -- Formal test with Bacen
  - [ ] Receive 20,000+ pacs.008 messages from Bacen
  - [ ] Process and respond with pacs.002 within timeout window
  - [ ] Send 20,000+ pacs.008 messages (2,000/min for 10 minutes)
  - [ ] k6 test infrastructure validated

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
  - [ ] 1,000+ key lookups executed successfully

### QR Code

- [ ] Static QR code generation and parsing
- [ ] COB (dynamic QR) generation and parsing
- [ ] COBV (dynamic QR with due date) generation and parsing
- [ ] CRC-16 checksum validation
- [ ] Pix Tester validations passed (mandatory items marked with *)

### Additional Requirements

- [ ] Participant directory processing (camt.014 for new participants)
- [ ] Account balance inquiry (camt.060 / camt.052)
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
| STA registration | Homologation STA | Production STA |
| STR registration | Homologation STR | Production STR |
| Validity | Standard | Standard |

### Steps

1. **Generate new key pair** for production (do NOT reuse homologation keys)
2. **Obtain production certificate** from an ICP-Brasil accredited certificate authority
3. **Register certificate** in the production STA (Sistema de Transferencia de Arquivos)
4. **Register certificate** in the production STR (Sistema de Transferencia de Reservas)
5. **Test mTLS connectivity** to production endpoints before go-live date
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
| Homologation | `icom-h.pi.rsfn.net.br` | 16522 |
| Production | `icom.pi.rsfn.net.br` | 16522 |

### Configuration Changes

- Update all endpoint URLs from homologation (`-h`) to production
- Update DICT API endpoints similarly
- Verify DNS resolution for production endpoints from your infrastructure
- Test network connectivity and firewall rules for production endpoints
- Ensure your RSFN (Rede do Sistema Financeiro Nacional) network access includes production endpoints

### ICOM Connection Parameters (Production)

- Maximum concurrent polling connections: 6
- Maximum message size: as defined in the communication interface manual
- Connection timeout: configure appropriately (10-15 seconds recommended)
- Keep-alive: enabled (reuse TCP connections)
- Do NOT send HTTP headers not defined in the communication interface manual

> "O BACEN eh bem restrito nos headers http, nao pode enviar headers que nao estejam definidos no manual da interface de comunicacao"

---

## PI Account Funding

Your PI (Pagamentos Instantaneos) account in production starts with **zero balance**. You cannot process Pix payments (pacs.008 as payer) until your PI account has funds.

### Funding Methods

1. **STR Web**: Use the STR Web interface to transfer funds from your STR account (settlement account) to your PI account
2. **Receive Pix**: Have another participant send Pix payments to your keys, which will credit your PI account
3. **CCME Transfer**: If you use a CCME (Conta de Compensacao de Moeda Estrangeira), coordinate with your settlement bank

### STR Web Process

STR Web is a Bacen-provided web interface for managing your settlement accounts:

1. Access STR Web with your institutional credentials
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
| Latency p50 | Median end-to-end processing time | > 1s |
| Latency p95 | 95th percentile processing time | > 3s |
| Latency p99 | 99th percentile processing time | > 5s |
| Error rate | Percentage of failed transactions | > 1% |
| pacs.002 response time | Time to respond to incoming pacs.008 | > 5s (Bacen timeout at 10s) |
| ICOM polling lag | Delay in consuming messages from ICOM | > 30s |
| DICT lookup latency | Time for key lookups | > 2s |
| PI account balance | Available balance for outgoing Pix | < minimum threshold |
| Certificate expiry | Days until certificate expires | < 30 days |
| Availability index | System uptime percentage | < 99.5% |

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
| Availability | >= 99.5% (per Bacen requirement) |
| pacs.002 response time | < 10 seconds (Bacen timeout) |
| Transaction processing | < 5 seconds end-to-end (target) |
| Incident response | P1: < 15 minutes |

**Availability calculation:**
Bacen measures availability based on your response to incoming pacs.008 messages. If you fail to respond with pacs.002 within the timeout window, those transactions count against your availability.

> "Como voces estao calculando o indice de disponibilidade?"

Track this metric continuously and alert if it drops below threshold.

### Settlement and Reconciliation

**Settlement:**
- Pix settlement happens in real-time through the PI account
- Your PI account balance decreases with each outgoing Pix
- Your PI account balance increases with each incoming Pix
- Monitor PI account balance continuously

**Reconciliation:**
- Use camt.060 to request account statements (camt.052)
- Note: camt.060 only returns data for the last 24 hours
- Implement daily reconciliation between your internal ledger and PI account
- Track every transaction by `endToEndId`
- Reconcile settlement amounts with expected values
- Investigate any discrepancies immediately

**Daily reconciliation process:**
1. Request camt.052 statement via camt.060 for the previous day
2. Compare PI account movements with your internal transaction records
3. Identify and investigate any discrepancies
4. Generate reconciliation report
5. Archive for audit purposes

### Bacen Reporting Requirements

As a Direct Participant, you have ongoing reporting obligations:

**Regular reports:**
- Transaction volume and value reports
- Availability index reports
- Incident reports for significant outages
- Fraud/MED reports

**Participant directory:**
- Process camt.014 messages to stay updated on new/changed participants
- Maintain a local participant directory
- The initial participant list can be loaded from a CSV published by Bacen
- camt.014 provides incremental updates for new participants

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
