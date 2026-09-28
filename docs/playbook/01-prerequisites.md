# Pix Direct Participant Homologation: Prerequisites

Before writing a single line of code for Pix homologation, a significant amount of institutional, infrastructure, and administrative setup must be completed. Underestimating this phase is one of the most common reasons teams fall behind schedule. Many of these prerequisites involve external dependencies (Bacen, certificate authorities, network providers) with their own lead times.

## ISPB Registration

Your institution must have a registered **ISPB** (Identificador do Sistema de Pagamentos Brasileiro), the unique 8-character identifier (`[0-9A-Z]{8}`; usually digits, but letters are valid, as in Bacen's virtual participants `99999A03`/`99999A04`) assigned by Bacen to every participant in the Brazilian payment system. If your institution does not already have an ISPB, this must be obtained through Bacen's institutional registration process before any technical work begins.

The ISPB is embedded in virtually every message and identifier in the Pix protocol: end-to-end IDs, business message IDs, routing headers, and DICT key registrations. It is your institution's identity within the entire payment ecosystem.

## Digital Certificates (ICP-Brasil)

All communication with Bacen's systems occurs over mTLS (mutual TLS), requiring **ICP-Brasil digital certificates**. These are not standard commercial TLS certificates; they must be issued by a certificate authority that is part of Brazil's ICP-Brasil (Infraestrutura de Chaves Publicas Brasileira) trust chain.

### What You Need

- **Client certificate** for RSFN authentication (used for mTLS with ICOM and DICT APIs). The Roteiro names two certificates: a signature certificate (**CERTPIA**, for the XMLDSig in `Sgntr`/`Signature`) and a channel encryption certificate (**CERTPIC**, for the TLS connection), specified in the Manual de Redes do SFN, the ICOM manual and the Manuais de Segurança do SFN e do Pix
- **Separate certificates** for homologation and production environments
- Certificates must be associated with your institution's CNPJ

### Obtaining Certificates

1. Choose an ICP-Brasil accredited certificate authority (e.g., Serasa, CertiSign, Soluti)
2. Request an e-CNPJ or equipment/server certificate (A1 or A3 type)
3. Complete the validation process (requires in-person or video verification with legal representatives)
4. Receive and securely store the certificate and private key

### Lead Time

Certificate issuance typically takes **1-3 weeks** from initial request to delivery. Factor this into your project timeline. Do not wait until you need the certificate to start the process.

### Certificate Format

Certificates are typically delivered in PKCS#12 (.p12 / .pfx) format. You will need to extract the certificate and private key into PEM format for use with most HTTP client libraries:

```bash
# Extract certificate
openssl pkcs12 -in certificate.p12 -clcerts -nokeys -out client-cert.pem

# Extract private key
openssl pkcs12 -in certificate.p12 -nocerts -out client-key.pem

# Optionally remove passphrase from private key (for automated systems)
openssl rsa -in client-key.pem -out client-key-nopass.pem
```

## STA (Sistema de Transferencia de Arquivos)

STA is Bacen's file transfer system used for bulk data exchange. Having a working STA client is useful, but note what the official documents actually use during SPI homologation:

- The Roteiro requires **Sisbacen and BC Correio** access (to send and receive messages with Bacen); formal documents such as the extension request and the declaration of aptitude go through BC Correio or the digital protocol
- Scheduling of the capacity test and the "Resumo dos Resultados dos Testes Homologatórios no SPI" go through **spi@bcb.gov.br**
- Statement files requested with `camt.060`/`camt.052` are downloaded from the ICOM **ARQ** service (`https://arq-h.pi.rsfn.net.br:1130` in homologation; files are kept for 24h)

Ensure your team has Sisbacen/BC Correio access and can reach ARQ before beginning Phase 1.

## STR (Sistema de Transferencia de Reservas)

STR is Brazil's real-time gross settlement system. For Pix, STR is relevant because:

- Liquidity moves between your STR reserve/settlement account and your PI (Pagamentos Instantaneos) account through the LPI messages (`LPI0001`, `LPI0003`, ...), tested in Roteiro item 4
- Pix transactions themselves settle in the PI accounts, inside the SPI, not in STR
- Institutions that are not STR participants send the LPI messages through STR-Web

While STR integration is not the focus of Pix homologation testing, you need to understand how it interacts with your PI account and ensure your operations team can manage STR transfers.

## PI Account (Pagamentos Instantaneos)

Every Direct Participant must have a **PI account** at Bacen. This is the settlement account used for Pix transactions. Key details:

- The PI account **starts with a zero balance** in the homologation environment
- You must fund the PI account (via STR/STR-Web with `LPI0001`, or by receiving Pix) before you can settle outgoing Pix transactions, in homologation as in production
- The PI account balance is debited for outgoing payments and credited for incoming payments
- Each Pix settles individually and in real time (gross settlement); there are no settlement cycles
- You must monitor your PI account balance to avoid settlement failures due to insufficient funds

In our experience the zero starting balance is a frequent surprise in the first send tests: plan the funding step before the first `pacs.008`. Understanding PI account management is also critical for go-live readiness.

## Infrastructure Requirements

### Dedicated Servers

You need dedicated infrastructure (physical or virtual) that can:

- Maintain persistent connections to the RSFN network
- Handle the mTLS handshake with ICP-Brasil certificates
- Support the throughput requirements (1,000, 2,000 or 4,000 `pacs.008` per minute sent and received for the capacity test, depending on the number of accounts)
- Run 24/7 with high availability (Pix operates continuously, including weekends and holidays)

### Network Connectivity to RSFN

RSFN is a **private network**. It is not accessible over the public internet. You must establish connectivity through one of the following methods:

- **Direct connection**: Physical or logical connection to the RSFN network through a Bacen-approved network provider
- **RTM (Rede de Telecomunicacoes para o Mercado)**: A managed network service that provides connectivity to RSFN for financial institutions
- **Cloud-based connectivity**: Some cloud providers offer connectivity solutions to RSFN, but these must be validated and approved

Network setup has significant lead time (4-8 weeks or more). This is often the longest prerequisite to resolve. Start this process as early as possible.

### Firewall and Network Configuration

Ensure the following network requirements are met:

- Outbound HTTPS to ICOM: port 16522 (primary) and 17522 (secondary) in homologation; 16422 and 17422 in production
- Outbound HTTPS to DICT: port 16522 in homologation (`dict-h.pi.rsfn.net.br`), 16422 in production
- Outbound HTTPS to ARQ (statement files): port 1130 in homologation
- mTLS support (client certificate presentation during TLS handshake)
- Stable, low-latency connectivity (a Pix must settle within 40 seconds of the payer's acceptance, and the receiving PSP is measured at p50 1.4s / p95 2.3s)
- No transparent proxies or middleware that modify HTTP headers or TLS behavior

## Certificate Installation and Validation

Once you have your ICP-Brasil certificate and RSFN network connectivity, you must validate the certificate works correctly in the RSFN environment.

### Validation Steps

1. **Install the certificate** on your application servers in the appropriate format (PEM, PKCS#12, or JKS depending on your technology stack)
2. **Configure your HTTP client** to present the client certificate during TLS handshake
3. **Verify the trust chain**: Your client must trust Bacen's server certificate chain, and Bacen's infrastructure must trust your client certificate chain
4. **Test basic connectivity**: ICOM has no health endpoint; a `GET /api/v1/in/catalog` is a simple request to confirm mTLS is working, and the formal test is the `pibr.001` → `pibr.002` echo
5. **Validate certificate metadata**: Ensure the certificate's CNPJ, serial number, and other fields match what Bacen expects for your institution

### Common Certificate Issues

- **Expired certificates**: ICP-Brasil certificates have defined validity periods. Monitor expiration and plan renewal
- **Wrong certificate type**: Not all ICP-Brasil certificates are valid for RSFN. Confirm the certificate type with your CA and Bacen
- **Trust chain gaps**: Ensure intermediate CA certificates are properly installed
- **Private key mismatch**: Verify the private key corresponds to the certificate being presented
- **Certificate not registered with Bacen**: Your certificate must be registered/associated with your ISPB in Bacen's systems

## Partner PSP Coordination

Bilateral testing requires coordination with at least one partner PSP. This is a human-coordination task that takes more time than most teams expect.

### What to Arrange with Your Partner

- **Test schedule**: Agree on dates and times for bilateral testing sessions
- **Test accounts**: Exchange test account details (branch, account number, account type) that each side will use
- **Pix keys**: Register test Pix keys in the homologation DICT that your partner can use to send payments to you
- **Communication channel**: Establish a direct communication channel (Slack, WhatsApp group, email thread) for real-time coordination during testing
- **Contact persons**: Identify technical contacts on both sides who can troubleshoot issues during test sessions
- **Test scenarios**: Agree on the specific test scenarios you will execute together

### Finding a Partner

- Other fintechs in the homologation pipeline (Bacen can sometimes facilitate introductions)
- Established banks with dedicated homologation support teams
- Industry groups and Pix community forums
- Your existing banking relationships

Start partner coordination at least 2-3 weeks before you expect to need bilateral testing.

## Setting Up Development and Staging Environments

Before connecting to Bacen's homologation environment, set up local development and staging environments that allow rapid iteration.

### Local Development

- **Mock ICOM server**: Build or use a mock server that simulates ICOM's stream reading (`/out/{ispb}/stream/start` + `PI-Pull-Next` + `DELETE`) and responds with test `pacs.002` messages
- **XML validation**: Set up XML schema validation in your development pipeline. Bacen publishes the XSDs of every SPI message in the catalog zip (copies in `simulator/spec/spi-5.13.1`; `npm run test:simulator` validates the toolkit's messages against them)
- **Message builders**: Create utilities to generate valid `pacs.008`, `pacs.002`, and `pacs.004` messages with correct structures
- **Test data**: Prepare test datasets with valid CPFs, CNPJs, account numbers, and Pix keys for the homologation environment

### Staging Environment

- Mirror your production architecture as closely as possible
- Use the same certificate configuration (but with homologation certificates)
- Deploy the same monitoring and alerting you plan to use in production
- Ensure staging can be quickly updated for iterative testing with Bacen

### Source Control and CI/CD

- All Pix-related code, configurations, and message templates should be in source control
- Automated tests for XML message generation and parsing
- CI/CD pipeline that can deploy changes to staging quickly (you will iterate frequently during homologation)
- Structured logging for every message sent and received (invaluable for debugging with Bacen)

## Prerequisite Checklist

Before starting Phase 1 (Basic Connectivity), confirm all of the following:

- [ ] ISPB registered and active with Bacen
- [ ] Sisbacen and BC Correio access (required by the Roteiro)
- [ ] ICP-Brasil digital certificates (CERTPIA and CERTPIC) obtained for the homologation environment
- [ ] RSFN network connectivity established and validated
- [ ] ARQ reachable (and STA, if your operation uses it)
- [ ] STR or STR-Web access available (to fund the PI account)
- [ ] PI account created at Bacen
- [ ] Certificate installed and mTLS validated against a test endpoint
- [ ] At least one partner PSP identified and initial contact made
- [ ] Development environment set up with mock services and XML validation
- [ ] Staging environment deployed and accessible
- [ ] Team has reviewed Bacen's Pix technical manuals and message specifications
- [ ] Logging and monitoring infrastructure in place

Sources: [Roteiro para Participação Direta no SPI](https://www.bcb.gov.br/content/estabilidadefinanceira/sistemapagamentosinstantaneos_docs/Roteiro_para_Participacao_Direta_no_SPI_e_abertura_de_Conta_PI.pdf), [ICOM manual 1.12](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf), [Manual de Tempos do Pix](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf), [DICT API](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/API-DICT.html).

---

**Previous:** [00 - Overview](./00-overview.md) | **Next:** [02 - Basic Connectivity](./02-basic-connectivity.md)
