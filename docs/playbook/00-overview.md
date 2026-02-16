# Pix Direct Participant Homologation: Overview

## What Is Pix Homologation?

Pix homologation is the formal certification process mandated by the Brazilian Central Bank (Bacen) that every institution must complete before operating as a **Direct Participant** in the Pix instant payment ecosystem. It validates that your systems can correctly originate, receive, and process Pix transactions in real time, following all protocol specifications, security requirements, and performance thresholds defined by Bacen.

Becoming a Direct Participant (as opposed to an Indirect Participant that routes through another institution) means your organization connects directly to Bacen's infrastructure. This gives you full control over your Pix operations, lower per-transaction costs at scale, and the ability to innovate independently on Pix-based products. The trade-off is significant engineering investment and a rigorous multi-phase certification process.

Homologation is not optional. You cannot process a single real Pix transaction without completing it. Bacen will not enable your ISPB in production until every phase is passed and signed off.

## The 7 Phases of Homologation

Homologation is structured into sequential phases. Each phase must be completed and approved before the next begins. Bacen provides a detailed test plan for each phase with specific test cases you must execute and pass.

### Phase 1: Basic Connectivity

Establish your connection to Bacen's ICOM messaging API over the RSFN (Rede do Sistema Financeiro Nacional). This phase validates that your infrastructure can authenticate via mTLS, send messages, and poll for responses. You will send and receive your first test transactions (typically a R$ 0.01 payment).

**Typical duration:** 2-4 weeks

### Phase 2: SPI Functionality

Execute the full suite of SPI (Sistema de Pagamentos Instantaneos) functional test cases. This covers payment initiation (`pacs.008`), payment status reporting (`pacs.002`), and payment returns/devolutions (`pacs.004`). You must demonstrate correct handling of all local instruments (MANU, DICT, QRDN, QRES, INIC), proper error handling, timeout management, and multi-version message support.

**Typical duration:** 3-5 weeks

### Phase 3: SPI Capacity

Prove your system can handle Bacen's throughput requirements under load. The current requirement is **20,000 transactions processed in 10 minutes** (approximately 2,000 per minute), operating as both sender and receiver simultaneously. Bacen schedules this test and monitors it in real time.

**Typical duration:** 1-2 weeks (plus rehearsal time)

### Phase 4: DICT Functionality

Execute functional test cases for the DICT (Diretorio de Identificadores de Contas Transacionais), Pix's key directory system. This covers key registration (CPF, CNPJ, phone, email, EVP/random), key lookup, key claiming (portability and ownership), and key deletion. The DICT API is a separate REST-based interface from SPI.

**Typical duration:** 2-3 weeks

### Phase 5: DICT Capacity

Similar to SPI Capacity but for the DICT API. Demonstrate that your system can handle high-volume key lookups and operations under load.

**Typical duration:** 1 week

### Phase 6: QR Codes and Advanced Features

Validate your implementation of Pix QR codes (static and dynamic), Pix Cobranca (billing), and other advanced features. This includes correct EMV QR code generation and parsing, webhook notifications, and integration with the DICT for QR-initiated payments.

**Typical duration:** 2-3 weeks

### Phase 7: Go-Live

Final validation and production activation. Bacen enables your ISPB in the production environment. You perform controlled initial transactions to confirm everything works in production. This phase also includes operational readiness checks, incident response procedures, and monitoring validation.

**Typical duration:** 1-2 weeks

## Typical Timeline

End-to-end homologation typically takes **3 to 4.5 months**, depending on:

- Team size and Pix experience
- Infrastructure readiness at the start
- Speed of partner PSP coordination for bilateral testing
- How quickly issues are identified and resolved
- Bacen's scheduling availability for capacity tests

A realistic timeline breakdown:

| Phase | Duration | Cumulative |
|-------|----------|------------|
| Basic Connectivity | 2-4 weeks | Week 2-4 |
| SPI Functionality | 3-5 weeks | Week 5-9 |
| SPI Capacity | 1-2 weeks | Week 6-11 |
| DICT Functionality | 2-3 weeks | Week 8-14 |
| DICT Capacity | 1 week | Week 9-15 |
| QR Codes / Advanced | 2-3 weeks | Week 11-18 |
| Go-Live | 1-2 weeks | Week 12-20 |

Some phases can partially overlap (for example, DICT development can begin during SPI capacity testing), but formal approval of each phase is generally sequential.

## Key Systems

### SPI (Sistema de Pagamentos Instantaneos)

The core instant payment system. SPI handles the actual movement of funds between participants. Communication happens via ISO 20022 XML messages exchanged through ICOM. All payment-related operations (send, receive, return) flow through SPI.

### DICT (Diretorio de Identificadores de Contas Transacionais)

The Pix key directory. DICT maps Pix keys (CPF, CNPJ, phone, email, random/EVP) to account information. When a payer initiates a Pix using a key, the paying institution queries DICT to resolve the key to the recipient's bank, branch, and account details. DICT has its own REST API, separate from the ICOM-based SPI messaging.

### ICOM (Interface de Comunicacao)

The messaging interface for SPI. ICOM is a polling-based HTTP API (not webhooks or push notifications) that participants use to send and receive ISO 20022 messages. You send messages via HTTP POST and poll for incoming messages via HTTP GET. ICOM runs over the RSFN network with mTLS authentication.

### RSFN (Rede do Sistema Financeiro Nacional)

The dedicated private network that connects financial institutions to Bacen's systems. All Pix communication (SPI via ICOM, DICT API, STR, STA) travels over RSFN. Access requires ICP-Brasil digital certificates and dedicated network infrastructure. RSFN is not accessible over the public internet.

## Environment Overview

Bacen operates two distinct environments:

### Homologation Environment (HPIX / PPIX)

- **HPIX**: The primary homologation environment where most testing occurs
- **PPIX**: Pre-production environment used for final validation before go-live
- ICOM URL: `https://icom-h.pi.rsfn.net.br:16522/api/v1/...`
- DICT URL: `https://dict-h.pi.rsfn.net.br/api/v2/...`
- Uses separate certificates from production
- Transactions use test data and do not move real money
- Bacen virtual participants are available for testing

### Production Environment

- ICOM URL: `https://icom.pi.rsfn.net.br:16522/api/v1/...`
- DICT URL: `https://dict.pi.rsfn.net.br/api/v2/...`
- Real transactions, real money
- Only accessible after full homologation approval

## Bacen Virtual Participants

During homologation, Bacen provides virtual participants that simulate the behavior of a counterparty institution. These are essential for testing when you do not yet have a partner PSP available or for executing specific Bacen-mandated test cases.

| Virtual Participant | ISPB | Purpose |
|---------------------|------|---------|
| SPI Virtual Participant | **99999004** | Simulates a counterparty for SPI transactions (pacs.008, pacs.002, pacs.004) |
| DICT Virtual Participant | **99999060** | Simulates a counterparty for DICT operations (key lookups, claims) |

The virtual participants have predefined behaviors. For example, sending a `pacs.008` to ISPB `99999004` will result in an automatic `pacs.002` response (acceptance or rejection depending on the test scenario). This allows you to develop and test without depending on external partners for every iteration.

## Role of Partner PSPs for Bilateral Testing

While Bacen's virtual participants cover many test scenarios, certain phases require **bilateral testing** with a real partner PSP (Payment Service Provider) that is already a Direct Participant or is also undergoing homologation.

Bilateral testing validates:

- Real-world message exchange between two independent systems
- Correct routing and settlement behavior
- Edge cases that virtual participants do not cover
- End-to-end payment flow including actual DICT lookups

You will need to coordinate schedules with your partner PSP, agree on test scenarios, and share test account details. Common bilateral test partners include other fintechs going through homologation simultaneously or established banks willing to support new entrants. Bacen can sometimes facilitate introductions.

Plan for bilateral testing early. Coordinating with an external organization always takes longer than expected.

## ISO 20022 Messages

Pix uses the ISO 20022 financial messaging standard. All SPI messages are XML documents wrapped in a Business Application Header (BAH). The key message types you will implement:

### pacs.008 - FIToFICustomerCreditTransfer

The payment initiation message. Sent from the debtor's institution to the creditor's institution (via Bacen) to initiate a Pix transfer. Contains all payment details: debtor and creditor information, amount, Pix key used, end-to-end ID, and the local instrument type.

### pacs.002 - PaymentStatusReport

The payment status response. Sent by the creditor's institution back to the debtor's institution (via Bacen) to accept or reject an incoming payment. An `ACSP` (Accepted Settlement in Process) status means the payment is accepted. An `RJCT` (Rejected) status includes a reason code explaining why.

### pacs.004 - PaymentReturn

The devolution/return message. Used to return a previously settled payment, either partially or fully. Common scenarios include: customer-requested returns, fraud-related returns, and operational error corrections. Return messages reference the original transaction's end-to-end ID.

### Business Application Header (BAH)

Every SPI message is wrapped in a BAH envelope that contains routing metadata: sender ISPB, receiver ISPB, message definition identifier, business message identifier (BizMsgIdr), and creation timestamp. The BAH is critical for correct message routing and must be properly constructed.

---

**Next:** [01 - Prerequisites](./01-prerequisites.md)
