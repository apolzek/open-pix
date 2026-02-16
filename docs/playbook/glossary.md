# Glossary

Comprehensive reference of terms, acronyms, and concepts used in Pix Direct Participant homologation with Bacen.

---

## Institutions and Systems

### BACEN (Banco Central do Brasil)
The Central Bank of Brazil. Operates and regulates the SPI (instant payment system) and DICT (directory of transactional identifiers). All Pix Direct Participants connect to Bacen's infrastructure for message exchange and settlement.

### PSP (Prestador de Servicos de Pagamento)
Payment Service Provider. Any institution authorized by Bacen to offer Pix payment services. Can be a direct participant (connects directly to SPI) or indirect participant (connects through a direct participant).

### ISPB (Identificador do Sistema de Pagamentos Brasileiro)
Brazilian Payment System Identifier. An 8-digit numeric code uniquely identifying each financial institution in the Brazilian payment ecosystem. Used in routing, EndToEndId generation, and message addressing. Example: `12345678`.

### RSFN (Rede do Sistema Financeiro Nacional)
National Financial System Network. The private, secure network infrastructure that interconnects financial institutions and Bacen. All SPI and DICT communication occurs over RSFN using mTLS.

### STR (Sistema de Transferencia de Reservas)
Reserves Transfer System. Bacen's RTGS (Real-Time Gross Settlement) system for large-value interbank transfers. Used to move funds between bank reserve accounts and PI settlement accounts. STR Web is its web interface.

---

## Pix Infrastructure

### SPI (Sistema de Pagamentos Instantaneos)
Instant Payment System. The core Bacen infrastructure that processes Pix transactions. Handles message routing, settlement, and timeout management. Operates 24/7/365 with a target settlement time under 10 seconds.

### DICT (Diretorio de Identificadores de Contas Transacionais)
Directory of Transactional Account Identifiers. Bacen's centralized directory that maps Pix keys (CPF, CNPJ, email, phone, EVP) to bank account information. PSPs query DICT to resolve where to send a Pix payment.

### ICOM (Interface de Comunicacao)
Communication Interface. The API through which PSPs exchange ISO 20022 messages with the SPI. Supports polling (receiving messages) and sending. Uses mTLS over HTTPS on the RSFN network. Maximum of 6 concurrent polling connections per participant.

### PI (Participante Instantaneo / Pix Participant)
Pix Participant. Refers to either a direct or indirect participant in the SPI. In the context of settlement, PI also refers to the settlement account held at Bacen for Pix transactions.

---

## Message Types (ISO 20022)

### pacs.002 (FIToFIPaymentStatusReport)
Payment status report sent from the receiving PSP back to the SPI to acknowledge receipt of a pacs.008. Contains a status code: `ACSP` (accepted for settlement processing), `RJCT` (rejected with reason code), or other statuses. Must be sent within approximately 10 seconds to avoid AB03 timeout.

### pacs.004 (PaymentReturn)
Payment return message. Used to return (devolve) a previously settled Pix transaction. References the original pacs.008 via its EndToEndId. Contains a return reason code (e.g., MD06 for fraud, BE08 for beneficiary error). Devolution EndToEndIds use the `D` prefix.

### pacs.008 (FIToFICustomerCreditTransfer)
The primary Pix payment message. Sent from the originating PSP through the SPI to the receiving PSP. Contains all payment details: amount, debtor, creditor, accounts, EndToEndId, and optional remittance information.

### ISO 20022
International standard for financial messaging published by ISO. Pix uses a subset of ISO 20022 messages adapted by Bacen (the SPI catalog). Messages are XML-based and follow a hierarchical structure with a Business Application Header (AppHdr) envelope.

---

## Message Components

### BAH (Business Application Header / AppHdr)
The envelope header that wraps every ISO 20022 message in the SPI. Contains routing information: sender ISPB (`Fr`), receiver ISPB (`To`), message definition identifier (`MsgDefIdr`), business message identifier (`BizMsgIdr`), and creation date.

### BizMsgIdr (Business Message Identifier)
A unique identifier for each business message sent through the SPI. Contained in the BAH. Used for deduplication and message tracking. Must be globally unique per sender.

### E2E ID (EndToEndId / End-to-End Identification)
A 32-character identifier that uniquely identifies a Pix transaction from origination to settlement. Format: `E` + ISPB (8 digits) + date `YYYYMMDD` (8 digits) + time `HHMM` (4 digits) + random alphanumeric (8 chars). Devolutions use `D` prefix. See [EndToEndId Format Reference](../reference/endtoendid-format.md).

### TLV (Tag-Length-Value)
Encoding format used in EMV QR Codes for Pix. Each data element is represented as a tag number, the length of the value, and the value itself. Used to encode payment information in static and dynamic QR codes according to EMV specifications.

---

## Key Types and DICT Concepts

### EVP (Endereco Virtual de Pagamento)
Virtual Payment Address. A random UUID-format key in DICT that is not tied to personal data. Generated by the PSP and registered in DICT. Example: `123e4567-e89b-12d3-a456-426614174000`. Also known as a "random key."

### Portability
A DICT claim process that allows a Pix key holder to move their key from one PSP to another without changing the key itself. The key owner initiates the request at the new (claimer) PSP, and the old (donor) PSP must confirm or the claim is auto-approved after a timeout.

### Ownership
A DICT claim process used when a Pix key registered to one person's account is claimed by a different person (new owner). As of Resolution 457/2025, ownership claims are restricted to PHONE key type only. The donor PSP must confirm the claim.

### Infraction Report
A mechanism in DICT for reporting fraud or rule violations associated with a Pix key or transaction. Types include `FRAUD` and `REQUEST_FOR_INFORMATION`. Either the creditor or debtor PSP can open an infraction report. Used to initiate the MED process.

### Refund Solicitation
A formal request through DICT for the return of funds in a disputed Pix transaction, typically following a confirmed infraction report. Also known as "solicitacao de devolucao." Part of the MED (Special Return Mechanism) flow.

---

## Processes and Mechanisms

### MED (Mecanismo Especial de Devolucao)
Special Return Mechanism. A Bacen-mandated process for returning Pix funds in cases of confirmed fraud or operational error. Involves infraction reports, analysis periods, and mandatory refund if fraud is confirmed. Defined in Bacen regulations.

### HPIX (Horario Pix)
Pix Operating Hours. While Pix operates 24/7, certain operations (like DICT claims, infraction reports) have specific time windows. HPIX defines the operational schedule for different SPI and DICT functions.

### PPIX (Participante Pix)
Pix Participant. Generic term for any institution participating in the Pix ecosystem, whether as a direct or indirect participant.

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
SPI timeout reason code. Indicates that the receiving PSP did not send a pacs.002 response within the allowed time window (approximately 10 seconds). The SPI automatically generates a rejection and returns it to the originating PSP.

### ACSP (AcceptedSettlementInProcess)
ISO 20022 status code used in pacs.002 to indicate that the receiving PSP has accepted the payment and settlement processing can proceed. This is the "success" response for a pacs.008.

### RJCT (Rejected)
ISO 20022 status code used in pacs.002 to indicate that the receiving PSP has rejected the payment. Must be accompanied by a reason code (e.g., `BE01`, `AG03`, `AM02`) explaining the rejection. See [Error Codes Reference](../reference/error-codes.md).

### STA (Status)
Refers to status messages and notifications in the SPI. Used in various contexts including system status broadcasts and operational notifications from Bacen.

---

## Security and Connectivity

### mTLS (Mutual TLS)
Mutual Transport Layer Security. Both client and server present certificates during the TLS handshake. Required for all RSFN/ICOM communication. The PSP must present a valid client certificate issued by the RSFN PKI, and verify Bacen's server certificate.

---

## Identifiers

### CPF (Cadastro de Pessoas Fisicas)
Brazilian individual taxpayer registration number. 11 digits with 2 check digits. Can be used as a Pix key type in DICT. Validated using a modulo-11 algorithm.

### CNPJ (Cadastro Nacional de Pessoas Juridicas)
Brazilian corporate taxpayer registration number. 14 digits with 2 check digits. Can be used as a Pix key type in DICT. Validated using a modulo-11 algorithm with different weights than CPF.

### txid (Transaction Identifier)
An identifier assigned by the payee (recebedor) to a COB or COBV charge. Used for payment reconciliation. Alphanumeric, between 26 and 35 characters. Included in the QR code payload and carried through in the Pix transaction.
