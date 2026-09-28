# Glossary

Comprehensive reference of terms, acronyms, and concepts used in Pix Direct Participant homologation with Bacen.

---

## Institutions and Systems

### BACEN (Banco Central do Brasil)
The Central Bank of Brazil. Operates and regulates the SPI (instant payment system) and DICT (directory of transactional identifiers). All Pix Direct Participants connect to Bacen's infrastructure for message exchange and settlement.

### PSP (Prestador de Servicos de Pagamento)
Payment Service Provider. Any institution authorized by Bacen to offer Pix payment services. Can be a direct participant (connects directly to SPI) or indirect participant (connects through a direct participant).

### ISPB (Identificador do Sistema de Pagamentos Brasileiro)
Brazilian Payment System Identifier. An 8-character code (`[0-9A-Z]{8}`) uniquely identifying each financial institution in the Brazilian payment ecosystem. Usually numeric, but letters are valid (e.g. Bacen's homologation virtual participants `99999A03` and `99999A04`). Used in EndToEndId generation, message identifiers, and the `DbtrAgt`/`CdtrAgt` of SPI messages. Examples: `12345678`, `00038166` (the SPI itself).

### RSFN (Rede do Sistema Financeiro Nacional)
National Financial System Network. The private, secure network infrastructure that interconnects financial institutions and Bacen. All SPI and DICT communication occurs over RSFN using mTLS.

### STR (Sistema de Transferencia de Reservas)
Reserves Transfer System. Bacen's RTGS (Real-Time Gross Settlement) system for large-value interbank transfers. Used to move funds between bank reserve accounts and PI settlement accounts. STR Web is its web interface.

---

## Pix Infrastructure

### SPI (Sistema de Pagamentos Instantaneos)
Instant Payment System. The core Bacen infrastructure that processes Pix transactions. Handles message routing, settlement, and timeout management. Operates 24/7/365. Per the Manual de Tempos do Pix, a Pix on the primary channel must settle within 40 seconds counted from `AccptncDtTm` (acceptance by the payer's PSP); past that the SPI rejects it with `AB03`. The SPI's own processing time target is 2.8 s at p50. Its ISPB is `00038166`, which is the `AppHdr/To` of every message a PSP sends.

### DICT (Diretorio de Identificadores de Contas Transacionais)
Directory of Transactional Account Identifiers. Bacen's centralized directory that maps Pix keys (CPF, CNPJ, email, phone, EVP) to bank account information. PSPs query DICT to resolve where to send a Pix payment.

### ICOM (Interface de Comunicacao)
Communication Interface. The API through which PSPs exchange ISO 20022 messages with the SPI. Sending is `POST /api/v1/in/{ispb}/msgs`; receiving is a long-polling stream (`GET /api/v1/out/{ispb}/stream/start`, then `GET` on each `PI-Pull-Next`, finished with `DELETE`). Uses mTLS over HTTPS on the RSFN network. Maximum of 6 concurrent read streams per participant and channel.

### PI (Pagamentos Instantâneos)
Instant Payments. Most commonly seen in "Conta PI" (Conta Pagamentos Instantâneos), the settlement account a direct participant holds at Bacen for Pix transactions, funded from the STR. Also appears in host names (`*.pi.rsfn.net.br`), namespaces (`https://www.bcb.gov.br/pi/...`) and `PI-*` HTTP headers.

---

## Message Types (ISO 20022)

### pacs.002 (FIToFIPaymentStatusReport)
Payment status report. The receiving PSP sends it to the SPI to accept (`ACSP`) or reject (`RJCT` with a reason code) a pacs.008 or pacs.004; the SPI sends its own pacs.002 to both PSPs with `ACSC` (to the payer's PSP), `ACCC` (to the receiver's PSP) or `RJCT`. Catalog 5.13 version: `pacs.002.spi.1.17`. The receiving PSP's answer time is measured against 1.4 s (p50) and 2.3 s (p95), and the whole cycle must settle within 40 s of `AccptncDtTm` or the SPI rejects with `AB03`.

### pacs.004 (PaymentReturn)
Payment return message. Used to return (devolve) a previously settled Pix transaction. References the original pacs.008 via `OrgnlEndToEndId` (the original `E` id). Return reason codes are only `BE08` (bank error, MED), `FR01` (fraud, MED), `MD06` (requested by the receiving user) and `SL02` (Pix Saque/Troco). The return's own id (`RtrId`) uses the `D` prefix. Catalog 5.13 version: `pacs.004.spi.1.5`.

### pacs.008 (FIToFICustomerCreditTransfer)
The primary Pix payment message. Sent from the originating PSP through the SPI to the receiving PSP. Contains the payment details: amount, `AccptncDtTm`, priority and service level, local instrument, debtor (name and CPF/CNPJ), creditor (CPF/CNPJ only, no name), accounts, agents, EndToEndId, and optional remittance information. Catalog 5.13 version: `pacs.008.spi.1.16`.

### ISO 20022
International standard for financial messaging published by ISO. Pix uses a subset of ISO 20022 messages adapted by Bacen (the Catálogo de Mensagens e Serviços do SPI). Messages are XML-based: an `Envelope` with a Bacen namespace per message and version (e.g. `https://www.bcb.gov.br/pi/pacs.008/1.16`) holding the Business Application Header (`AppHdr`) and the `Document`. Each message type has its own version.

---

## Message Components

### BAH (Business Application Header / AppHdr)
The header that precedes the `Document` inside every SPI message `Envelope`. Contains: sender ISPB (`Fr`), receiver ISPB (`To`, always `00038166` when a PSP sends, since messages go to the SPI), business message identifier (`BizMsgIdr`), message definition identifier (`MsgDefIdr`, e.g. `pacs.008.spi.1.16`), creation date in UTC (`CreDt`), and the XMLDSig signature (`Sgntr`).

### BizMsgIdr (Business Message Identifier)
A unique identifier for each business message sent through the SPI. Contained in the BAH. Format: `M` + ISPB (8 chars `[0-9A-Z]`) + 23 alphanumeric chars = 32 chars, case sensitive. Must never repeat.

### E2E ID (EndToEndId / End-to-End Identification)
A 32-character identifier that uniquely identifies a Pix transaction from origination to settlement. Format: `E` + ISPB (8 chars `[0-9A-Z]`) + `yyyyMMddHHmm` in **UTC** (12 digits) + 11 alphanumeric chars. The SPI tolerates ±12 h against its processing time. Returns (pacs.004 `RtrId`) use the same layout with a `D` prefix. See [EndToEndId Format Reference](../reference/endtoendid-format.md).

### TLV (Tag-Length-Value)
Encoding format used in EMV QR Codes for Pix. Each data element is represented as a tag number, the length of the value, and the value itself. Used to encode payment information in static and dynamic QR codes according to EMV specifications.

---

## Key Types and DICT Concepts

### EVP (Endereco Virtual de Pagamento)
Virtual Payment Address. A random UUID-format key in DICT that is not tied to personal data. Generated by the PSP and registered in DICT. Example: `123e4567-e89b-12d3-a456-426614174000`. Also known as a "random key."

### Portability
A DICT claim process that allows a Pix key holder to move their key from one PSP to another without changing the key itself. The key owner initiates the request at the new (claimer) PSP (`POST /api/v2/claims/` with `Type` `PORTABILITY`), and the old (donor) PSP must confirm it within the 7-day resolution period; after that period the donor may cancel it. CPF, CNPJ, PHONE and EMAIL keys can be ported; EVP keys cannot.

### Ownership
A DICT claim process used when a Pix key registered to one person's account is claimed by a different person (new owner). The DICT API only allows ownership claims (`Type` `OWNERSHIP`) for PHONE keys. The donor PSP confirms the claim, by default once the 7-day resolution period ends without the current owner keeping the key; then there is an additional 7-day completion period before the claimer completes it.

### Infraction Report
A DICT record (`POST /api/v2/infraction-reports/`) created when there is well-founded suspicion of fraud in a transaction settled in the SPI. In API v2 its `Reason` is `REFUND_REQUEST` (created by the payer's PSP to request a return) or `REFUND_CANCELLED` (created by the receiver's PSP of the original transaction). Used to initiate the MED process.

### Refund Solicitation
A formal request through DICT (`POST /api/v2/refunds/`) for the return of funds in a disputed Pix transaction, with reason `FRAUD`, `OPERATIONAL_FLAW` or `PIX_AUTOMATICO`. Also known as "solicitação de devolução." Part of the MED (Special Return Mechanism) flow; the resulting pacs.004 uses `FR01` (fraud) or `BE08` (operational flaw).

---

## Processes and Mechanisms

### MED (Mecanismo Especial de Devolucao)
Special Return Mechanism. A Bacen-mandated process for returning Pix funds in cases of confirmed fraud or operational error. Involves infraction reports, analysis periods, and mandatory refund if fraud is confirmed. Defined in Bacen regulations.

### HPIX (Horario Pix)
Pix Operating Hours. While Pix operates 24/7, certain operations (like DICT claims, infraction reports) have specific time windows. HPIX defines the operational schedule for different SPI and DICT functions. (Community term; not found in the official manuals consulted for this toolkit.)

### PPIX (Participante Pix)
Pix Participant. Generic term for any institution participating in the Pix ecosystem, whether as a direct or indirect participant. (Community term; not found in the official manuals consulted for this toolkit.)

---

## QR Code Types

### Static QR Code
A Pix QR code that can be reused for multiple payments. Contains the payee's Pix key and optionally a fixed amount. Does not expire. Uses EMV TLV encoding. Identified by Merchant Account Information tag `26`.

### COB (Cobranca)
Immediate charge QR code. A dynamic QR code created for a specific payment with a defined amount and expiration. Created via the Pix API (`/cob` endpoint). Contains a `txid` for reconciliation.

### COBV (Cobranca com Vencimento)
Due-date charge QR code. A dynamic QR code with a due date, interest, penalties, and discounts. Used for billing scenarios. Created via the Pix API (`/cobv` endpoint). More complex than COB with additional date-related fields.

### EMV (Europay, Mastercard, Visa)
The standard specification used for Pix QR codes. Specifically, Pix uses the EMV QR Code Specification for Payment Systems (Merchant-Presented Mode). Defines the TLV structure and mandatory/optional data elements.

---

## Status and Error Codes

### AB03
SPI timeout reason code (AbortedSettlementTimeout). Indicates that the transaction was not settled within the limit: 40 seconds from `AccptncDtTm` (t0') on the primary channel, or 45 minutes for scheduled Pix on the secondary channel. The SPI rejects the transaction with a pacs.002 `RJCT`/`AB03` to both PSPs; any late pacs.002 from the receiver is useless.

### ACSP (AcceptedSettlementInProcess)
ISO 20022 status code used in pacs.002 to indicate that the receiving PSP has accepted the payment and settlement processing can proceed. This is the "success" response for a pacs.008. In homologation, the virtual participant `99999A04` answers every pacs.008 with `ACSP`. After settlement the SPI reports `ACSC` to the payer's PSP and `ACCC` to the receiver's PSP.

### RJCT (Rejected)
ISO 20022 status code used in pacs.002 to indicate that the receiving PSP has rejected the payment. Must be accompanied by a reason code (e.g., `BE01`, `AG03`, `AM02`) explaining the rejection. See [Error Codes Reference](../reference/error-codes.md).

### STA (Status)
Refers to status messages and notifications in the SPI. Used in various contexts including system status broadcasts and operational notifications from Bacen. (Informal term; not defined in the official manuals consulted for this toolkit.)

---

## Security and Connectivity

### mTLS (Mutual TLS)
Mutual Transport Layer Security. Both client and server present certificates during the TLS handshake. Required for all RSFN/ICOM communication. The PSP must present a valid client certificate issued by the RSFN PKI, and verify Bacen's server certificate.

---

## Identifiers

### CPF (Cadastro de Pessoas Fisicas)
Brazilian individual taxpayer registration number. 11 digits with 2 check digits. Can be used as a Pix key type in DICT. Validated using a modulo-11 algorithm.

### CNPJ (Cadastro Nacional de Pessoas Juridicas)
Brazilian corporate taxpayer registration number. 14 characters with 2 check digits; the new alphanumeric CNPJ (`[0-9A-Z]{12}[0-9]{2}`) is accepted by the SPI catalog. Can be used as a Pix key type in DICT. Validated using a modulo-11 algorithm with different weights than CPF.

### txid (Transaction Identifier)
An identifier assigned by the payee (recebedor) to a COB or COBV charge. Used for payment reconciliation. Alphanumeric, between 26 and 35 characters. Included in the QR code payload and carried through in the Pix transaction.

---

**Sources:** [Catálogo de Mensagens e Serviços do SPI 5.13.1](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip), [Manual das Interfaces de Comunicação 1.12](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf), [Manual de Tempos do Pix 7.0](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf), [Roteiro para Participação Direta no SPI](https://www.bcb.gov.br/content/estabilidadefinanceira/sistemapagamentosinstantaneos_docs/Roteiro_para_Participacao_Direta_no_SPI_e_abertura_de_Conta_PI.pdf), [API DICT 2.12.1](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/API-DICT.html).
