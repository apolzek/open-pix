# 05 - DICT Functionality Testing

## Overview

DICT (Diretorio de Identificadores de Contas Transacionais) is the centralized key directory for Pix. It maps Pix keys (aliases) to bank account details, enabling instant payments without the payer needing to know the recipient's full banking information.

As a Direct Participant, you must implement and test all DICT operations: key lifecycle management, claims (portability and ownership), infraction reports, and refund solicitations. The DICT functionality test is scheduled separately from DICT capacity testing, and typically precedes it.

**Bacen virtual DICT participant:** ISPB `99999060`. This is the counterparty used by Bacen during formal homologation tests. During informal testing with partner PSPs, you will use each other's real ISPBs.

---

## Key Types

DICT supports five key types:

| Key Type | Format | Example | Notes |
|----------|--------|---------|-------|
| **CPF** | 11 digits | `12345678901` | Natural person tax ID |
| **CNPJ** | 14 digits | `12345678000195` | Legal entity tax ID |
| **EMAIL** | Standard email | `user@example.com` | Case-insensitive |
| **PHONE** | E.164 format | `+5511999999999` | Must include country code |
| **EVP** | UUID v4 | `a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d` | Random key, system-generated |

Each account holder can register:
- Up to 5 keys per CPF (natural person)
- Up to 20 keys per CNPJ (legal entity)

---

## Key Lifecycle

### Create Key

Register a new key in DICT, binding it to an account at your PSP.

```
POST /api/v2/keys
```

Request body includes key type, key value, account holder information (name, taxId), and account details (branch, accountNumber, accountType, participant ISPB).

**Tips:**
- CNPJ and CPF documents must be valid (pass checksum validation). Invalid documents will be rejected. Some partner PSPs also validate documents during testing, so use real-format test documents.
- For EVP keys, the system generates the UUID -- you do not provide the key value.
- Account type is typically `TRAN` (transactional) or `CACC` (current account).

### Lookup Key

Query a key to retrieve the associated account details. This is the most common DICT operation -- every Pix payment initiated by key triggers a lookup.

```
GET /api/v2/keys/{keyType}:{keyValue}
```

For example:
```
GET /api/v2/keys/EMAIL:user@example.com
GET /api/v2/keys/PHONE:+5511999999999
GET /api/v2/keys/EVP:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d
GET /api/v2/keys/CPF:12345678901
GET /api/v2/keys/CNPJ:12345678000195
```

The response includes account details (participant ISPB, branch, account number, holder name, holder taxId) needed to construct the pacs.008 payment message.

### Update Key

Update the account details associated with an existing key (e.g., when a customer changes their account number within the same PSP).

```
PUT /api/v2/keys/{keyType}:{keyValue}
```

### Delete Key

Remove a key from DICT. The key becomes available for re-registration.

```
DELETE /api/v2/keys/{keyType}:{keyValue}
```

---

## Claims: Portability and Ownership

Claims are the mechanism for transferring Pix keys between PSPs (portability) or between different people (ownership).

### Portability Claims

A portability claim moves a key from one PSP to another, for the **same** account holder (same CPF/CNPJ). This happens when a customer wants to move their Pix key to a new bank.

**Flow:**
1. **Claimer PSP** (the PSP that wants the key) creates a portability claim via `POST /api/v2/claims`
2. **Donor PSP** (the PSP that currently holds the key) receives the claim notification via the DICT sync mechanism
3. Donor PSP must **acknowledge** the claim within the deadline
4. Donor PSP either **confirms** or the claim enters `WAITING_RESOLUTION`
5. If confirmed, the claim is **completed** and the key moves to the claimer PSP

**Portability works for all key types:** CNPJ, CPF, EMAIL, PHONE.

### Ownership Claims

An ownership claim transfers a key to a **different** account holder (different CPF/CNPJ). This happens when someone is given a phone number that was previously registered as a Pix key by someone else.

**IMPORTANT -- Resolution 457/2025:** Ownership claims only work for **PHONE** keys. EMAIL ownership claims are silently rejected by DICT. The DICT API documentation has not been updated to reflect this restriction as of the time of writing, which causes confusion. If you attempt an ownership claim for an EMAIL key, you will receive an `Invalid KeyType` error or the request will be silently dropped.

This was discovered during homologation testing when attempts to create ownership claims for email keys consistently failed:

> "So funciona com chave pix celular" (It only works with phone key)
> -- Victor Kobinski, Woovi team, confirming the Resolution 457/2025 restriction

**Ownership Claim Flow:**
1. **Claimer PSP** creates an ownership claim for a PHONE key
2. **Donor PSP** receives and acknowledges the claim
3. Donor PSP confirms or rejects
4. If confirmed, the claim is completed and the key transfers

### Claim Testing with Partner PSPs

During DICT functionality homologation, you need a partner PSP to test claims bilaterally. Each side must act as both claimer and donor.

**Test matrix for claims:**

| Scenario | Your Role | Partner Role |
|----------|-----------|-------------|
| Portability - EMAIL | Claimer | Donor (confirm) |
| Portability - EMAIL | Donor | Claimer |
| Portability - PHONE | Claimer | Donor (confirm) |
| Portability - PHONE | Donor | Claimer |
| Portability - CNPJ | Claimer | Donor (confirm) |
| Portability - CNPJ | Donor | Claimer |
| Portability - CPF | Claimer | Donor (confirm) |
| Portability - CPF | Donor | Claimer |
| Ownership - PHONE | Claimer | Donor (confirm) |
| Ownership - PHONE | Donor | Claimer |
| Portability - Cancel | Claimer (cancel) | Donor |
| Ownership - Cancel | Claimer (cancel) | Donor |

**Practical tips:**
- To test portability, both PSPs must create the same key (same holder document) on their respective sides before the claimer requests portability.
- The donor PSP needs to implement the DICT sync/polling mechanism to receive claim notifications.
- After a claim is completed, verify the key lookup returns the new PSP.
- Claims have a 7-day resolution deadline. During testing, process them immediately.

---

## Infraction Reports (MED - Mecanismo Especial de Devolucao)

Infraction reports are the first step of the MED process for handling fraud and operational issues in Pix transactions.

### Types

| Type | Description | Use Case |
|------|-------------|----------|
| `FRAUD` | Suspected fraud | User reports being scammed (fake QR code, social engineering, etc.) |
| `OPERATIONAL_FLAW` | Operational failure | System error caused incorrect credit |

### Infraction Report Lifecycle

```
CREATE --> ACKNOWLEDGED --> ACCEPTED or REJECTED --> CLOSED
```

1. **Reporter PSP** creates the infraction report linked to a specific transaction (`endToEndId`)
2. **Counterparty PSP** receives the report via DICT sync/polling
3. Counterparty PSP **acknowledges** receipt
4. Counterparty PSP **accepts** or **rejects** the report
5. Reporter PSP **closes** the report

### Creating an Infraction Report

```
POST /api/v2/infraction-reports
```

The request includes:
- `TransactionId`: the `endToEndId` of the original Pix transaction
- `Reason`: `REFUND_REQUEST` (for fraud) or `OPERATIONAL_FLAW`
- `SituationType`: context of the fraud
- `ReportDetails`: free-text description
- `ContactInformation`: email and phone for follow-up

### Testing Infraction Reports

You must test all combinations:

| Scenario | Your Role | Action |
|----------|-----------|--------|
| Create infraction for a Pix you sent | Reporter | Create report |
| Receive infraction for a Pix you received | Counterparty | Accept |
| Receive infraction for a Pix you received | Counterparty | Reject |
| Create infraction, then cancel it | Reporter | Create, then cancel |

**Practical tip:** Before creating an infraction report, you need an actual Pix transaction between the two PSPs. Send a Pix to your partner PSP, then open the infraction report referencing that transaction's `endToEndId`.

Example from real testing:

```
E54811417202504031334a1BrRnjRAbY - infraction report accepted
E54811417202504031336apTfJD1OH2C - infraction report rejected
```

### Fraud Markers

When an infraction report with `Reason: REFUND_REQUEST` is accepted, DICT creates a **fraud marker** (`FraudMarkerId`) associated with the transaction. This marker is linked to the counterparty's account and can affect future key lookups and risk assessments.

---

## Refund Solicitations

Refund solicitations are the second step of the MED process. After an infraction report is accepted, the reporter PSP can request a refund of the transaction amount.

### Types

| Type | Linked To | Description |
|------|-----------|-------------|
| `FRAUD` | Accepted infraction report | Refund after confirmed fraud (MED) |
| `OPERATIONAL_FLAW` | N/A (can be standalone) | Refund due to operational error |

### Refund Solicitation Flow

```
CREATE --> ACCEPTED or REJECTED --> CLOSED
```

For FRAUD refunds:
1. An infraction report must first be created and accepted
2. Reporter PSP creates a refund solicitation linked to the infraction report
3. Counterparty PSP evaluates the refund request
4. If accepted, counterparty PSP initiates a pacs.004 (return payment) for the refund amount

For OPERATIONAL_FLAW refunds:
1. Can be created without a prior infraction report
2. The flow is otherwise the same

### Refund Amount Handling

When a refund solicitation arrives:
- If the debited account has sufficient balance, refund the full amount and close with status `TOTAL_RETURN`
- If the account has partial balance, refund what is available and close with status `PARTIAL_RETURN`
- If the account has zero balance, reject or close with `NO_BALANCE` and monitor the account for 90 days

### Testing Refund Solicitations

| Scenario | Your Role | Action |
|----------|-----------|--------|
| Create refund solicitation (FRAUD) | Reporter | Create after accepted infraction |
| Create refund solicitation (OPERATIONAL_FLAW) | Reporter | Create standalone |
| Receive refund solicitation | Counterparty | Accept and return funds |
| Receive refund solicitation | Counterparty | Reject |

**Practical tip:** The full MED flow for testing is:
1. PSP A sends Pix to PSP B
2. PSP A opens an infraction report
3. PSP B accepts the infraction report
4. PSP A creates a refund solicitation
5. PSP B accepts and initiates refund (pacs.004)

---

## DICT Sync / Polling

DICT notifications (claims, infraction reports, refund solicitations) are delivered via a polling/sync mechanism, not push.

```
GET /api/v2/sync?ispb={yourISPB}&hasMoreElements=false
```

- Poll periodically (e.g., every 30-60 seconds via cron job)
- If `hasMoreElements` returns `true`, continue polling immediately
- Process each event and send acknowledgments
- A single polling connection is typically sufficient; under high load you may use 2

Unlike ICOM (which allows up to 6 concurrent polling connections), DICT does not have a formal concurrency limit on its HTTP API, but you should implement rate limiting per the DICT specification.

---

## Rate Limiting

DICT imposes rate limits per participant and per operation type. Implement token-bucket rate limiting:

- Track tokens per user and per operation
- Use Redis or similar to manage rate limit state
- The limits are defined in the DICT specification document
- Different operations (lookup, create, claim, etc.) have different limits

---

## Formal Homologation Test

The DICT functionality test is scheduled with Bacen via email, separately from DICT capacity testing.

**What to expect:**
- Duration: approximately 2 hours
- A Bacen employee will call the phone number provided in the scheduling email
- They initiate various DICT operations from the Bacen side (ISPB `99999060`)
- You must respond to their operations and execute your own
- Everything is async -- they send operations and verify your responses
- You need a partner PSP available during the test for bilateral scenarios

**Test preparation checklist:**
- [ ] Key CRUD operations working (create, lookup, update, delete) for all 5 key types
- [ ] Portability claims working (as claimer and as donor)
- [ ] Ownership claims working for PHONE keys (as claimer and as donor)
- [ ] Infraction reports: create, receive, accept, reject, close
- [ ] Refund solicitations: create, receive, accept, reject
- [ ] DICT sync/polling mechanism working
- [ ] Rate limiting implemented
- [ ] Partner PSP confirmed and available for the test date
- [ ] Pre-create test keys on your side and coordinate with your partner

---

## Common Issues and Solutions

### "Invalid KeyType" on Ownership Claims
**Cause:** Attempting ownership claim for an EMAIL key.
**Solution:** Ownership claims only work for PHONE keys per Resolution 457/2025. Use portability claims for EMAIL keys instead.

### Claims Not Arriving at Donor PSP
**Cause:** DICT sync/polling not working or not processing events quickly enough.
**Solution:** Verify your polling endpoint is working. Check that you are acknowledging events. The claim status should transition from `OPEN` to `WAITING_RESOLUTION` within about 30 seconds of the claimer creating it.

### Infraction Report Linked to Non-Existent Transaction
**Cause:** Using an `endToEndId` that was not settled (e.g., a timed-out transaction).
**Solution:** Ensure the referenced transaction was fully settled (received a successful pacs.002 with status `ACSC`) before creating the infraction report.

### Rate Limit Errors (HTTP 429)
**Cause:** Exceeding DICT rate limits.
**Solution:** Implement token-bucket rate limiting. Space out requests. For capacity testing, this is expected and must be handled gracefully.

### CPF/CNPJ Keys Not Found in Lookups
**Cause:** CPF/CNPJ keys often require KYC validation. Partner PSPs may have stricter validation in their testing environments.
**Solution:** Coordinate with partner PSP to use documents that pass their KYC (e.g., documents starting with `0` may auto-approve in some testing setups). Prefer EMAIL and EVP keys for initial testing.

### "Bad Request" on Key Creation
**Cause:** Invalid document format, missing required fields, or duplicate key.
**Solution:** Validate CPF/CNPJ checksums. Ensure all required fields are present. Check if the key already exists (do a lookup first).
