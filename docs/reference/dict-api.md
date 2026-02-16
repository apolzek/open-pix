# DICT API Reference

Reference documentation for the DICT (Diretorio de Identificadores de Contas Transacionais) API v2 used in Pix Direct Participant homologation with Bacen.

DICT is the centralized directory that maps Pix keys to bank account information. All operations use XML over HTTPS with mTLS on the RSFN network.

---

## Overview

- **Base URL:** `https://dict-h.pi.rsfn.net.br` (homologation) / `https://dict.pi.rsfn.net.br` (production)
- **Authentication:** mTLS with RSFN client certificate
- **Content-Type:** `application/xml`
- **API Version:** v2

---

## Key Types

| Key Type | Format | Example | Max per Account |
|----------|--------|---------|-----------------|
| CPF | 11-digit numeric | `12345678901` | 1 per CPF |
| CNPJ | 14-digit numeric | `12345678000199` | 1 per CNPJ root |
| PHONE | E.164 format | `+5511998765432` | 1 per phone |
| EMAIL | Email address | `user@example.com` | 1 per email |
| EVP | UUID v4 | `123e4567-e89b-12d3-a456-426614174000` | Up to 20 per account |

---

## Operations

### CreateKey

Registers a new Pix key in DICT, linking it to a bank account.

**Endpoint:** `POST /api/v2/keys`

**Request:**

```xml
<CreateKeyRequest>
  <Key>
    <KeyType>{CPF|CNPJ|PHONE|EMAIL|EVP}</KeyType>
    <KeyValue>{key value or empty for EVP}</KeyValue>
    <Account>
      <Participant>{ISPB 8 digits}</Participant>
      <Branch>{Branch number}</Branch>
      <AccountNumber>{Account number}</AccountNumber>
      <AccountType>{CACC|SVGS|SLRY|TRAN}</AccountType>
    </Account>
    <Owner>
      <Type>{NATURAL_PERSON|LEGAL_PERSON}</Type>
      <TaxIdNumber>{CPF or CNPJ}</TaxIdNumber>
      <Name>{Owner name}</Name>
    </Owner>
  </Key>
</CreateKeyRequest>
```

**Response (Success):**

```xml
<CreateKeyResponse>
  <Key>
    <KeyType>EVP</KeyType>
    <KeyValue>123e4567-e89b-12d3-a456-426614174000</KeyValue>
    <Account>
      <Participant>12345678</Participant>
      <Branch>0001</Branch>
      <AccountNumber>123456</AccountNumber>
      <AccountType>CACC</AccountType>
    </Account>
    <Owner>
      <Type>NATURAL_PERSON</Type>
      <TaxIdNumber>12345678901</TaxIdNumber>
      <Name>Fulano de Tal</Name>
    </Owner>
    <CreationDate>2025-02-15T10:30:00.000-03:00</CreationDate>
    <KeyOwnershipDate>2025-02-15T10:30:00.000-03:00</KeyOwnershipDate>
  </Key>
</CreateKeyResponse>
```

**Error Codes:**
- `KEY_ALREADY_EXISTS` -- The key is already registered in DICT
- `INVALID_KEY` -- Key format is invalid
- `INVALID_ACCOUNT` -- Account information is invalid
- `ENTRY_LIMIT_EXCEEDED` -- Maximum number of keys for this account reached

---

### GetKey

Looks up a Pix key to retrieve the associated account information. This is the core operation for resolving where to send a Pix payment.

**Endpoint:** `GET /api/v2/keys/{keyType}/{keyValue}`

**Path Parameters:**
- `keyType` -- One of: `CPF`, `CNPJ`, `PHONE`, `EMAIL`, `EVP`
- `keyValue` -- The key value (URL-encoded if necessary)

**Response:**

```xml
<GetKeyResponse>
  <Key>
    <KeyType>CPF</KeyType>
    <KeyValue>12345678901</KeyValue>
    <Account>
      <Participant>12345678</Participant>
      <Branch>0001</Branch>
      <AccountNumber>123456</AccountNumber>
      <AccountType>CACC</AccountType>
    </Account>
    <Owner>
      <Type>NATURAL_PERSON</Type>
      <TaxIdNumber>12345678901</TaxIdNumber>
      <Name>Fulano de Tal</Name>
    </Owner>
    <CreationDate>2025-01-10T08:00:00.000-03:00</CreationDate>
    <KeyOwnershipDate>2025-01-10T08:00:00.000-03:00</KeyOwnershipDate>
    <OpenClaimCreationDate/>
  </Key>
</GetKeyResponse>
```

**Error Codes:**
- `KEY_NOT_FOUND` -- The key does not exist in DICT
- `FORBIDDEN` -- Caller is not authorized to query this key

---

### DeleteKey

Removes a Pix key from DICT. Can only be performed by the PSP that owns the key.

**Endpoint:** `DELETE /api/v2/keys/{keyType}/{keyValue}`

**Path Parameters:**
- `keyType` -- Key type
- `keyValue` -- Key value

**Request Headers:**
- `PI-RequestId` -- Unique request identifier

**Response (Success):**

```xml
<DeleteKeyResponse>
  <Key>
    <KeyType>EMAIL</KeyType>
    <KeyValue>user@example.com</KeyValue>
  </Key>
  <ResponseTime>2025-02-15T10:30:00.000-03:00</ResponseTime>
</DeleteKeyResponse>
```

**Error Codes:**
- `KEY_NOT_FOUND` -- Key does not exist
- `FORBIDDEN` -- Caller does not own this key
- `KEY_IN_DISPUTE` -- Key has an active claim and cannot be deleted

---

### CreateClaim

Initiates a portability or ownership claim for a key currently registered at another PSP.

**Endpoint:** `POST /api/v2/claims`

**Request:**

```xml
<CreateClaimRequest>
  <Claim>
    <Type>{PORTABILITY|OWNERSHIP}</Type>
    <Key>
      <KeyType>{CPF|CNPJ|PHONE|EMAIL}</KeyType>
      <KeyValue>{key value}</KeyValue>
    </Key>
    <ClaimerAccount>
      <Participant>{Claimer ISPB}</Participant>
      <Branch>{Branch}</Branch>
      <AccountNumber>{Account}</AccountNumber>
      <AccountType>{CACC|SVGS|SLRY|TRAN}</AccountType>
    </ClaimerAccount>
    <ClaimerOwner>
      <Type>{NATURAL_PERSON|LEGAL_PERSON}</Type>
      <TaxIdNumber>{CPF or CNPJ}</TaxIdNumber>
      <Name>{Name}</Name>
    </ClaimerOwner>
  </Claim>
</CreateClaimRequest>
```

**Notes:**
- **Portability:** Same owner, different PSP. The key holder wants to move their key to a new institution.
- **Ownership:** Different owner claims the key. As of Resolution 457/2025, ownership claims are restricted to `PHONE` key type only.
- EVP keys cannot be claimed (they are random and can simply be deleted and recreated).

**Response:**

```xml
<CreateClaimResponse>
  <Claim>
    <ClaimId>{UUID}</ClaimId>
    <Type>PORTABILITY</Type>
    <Status>OPEN</Status>
    <Key>
      <KeyType>PHONE</KeyType>
      <KeyValue>+5511998765432</KeyValue>
    </Key>
    <DonorParticipant>87654321</DonorParticipant>
    <ClaimerParticipant>12345678</ClaimerParticipant>
    <CreationDate>2025-02-15T10:30:00.000-03:00</CreationDate>
    <CompletionDeadline>2025-02-22T10:30:00.000-03:00</CompletionDeadline>
  </Claim>
</CreateClaimResponse>
```

**Claim Lifecycle:**
1. `OPEN` -- Claim created, waiting for donor PSP action
2. `WAITING_RESOLUTION` -- Donor PSP notified the user, waiting for user response
3. `CONFIRMED` -- Donor PSP confirmed the claim
4. `CANCELLED` -- Claim cancelled by claimer or donor
5. `COMPLETED` -- Key successfully transferred

---

### ConfirmClaim

Confirms a claim as the donor PSP, agreeing to transfer the key to the claimer.

**Endpoint:** `POST /api/v2/claims/{claimId}/confirm`

**Path Parameters:**
- `claimId` -- UUID of the claim to confirm

**Request:**

```xml
<ConfirmClaimRequest>
  <ClaimId>{UUID}</ClaimId>
</ConfirmClaimRequest>
```

**Response:**

```xml
<ConfirmClaimResponse>
  <Claim>
    <ClaimId>{UUID}</ClaimId>
    <Status>CONFIRMED</Status>
  </Claim>
</ConfirmClaimResponse>
```

---

### CancelClaim

Cancels an open claim. Can be initiated by either the claimer or the donor PSP.

**Endpoint:** `POST /api/v2/claims/{claimId}/cancel`

**Path Parameters:**
- `claimId` -- UUID of the claim to cancel

**Request:**

```xml
<CancelClaimRequest>
  <ClaimId>{UUID}</ClaimId>
  <Reason>{DONOR_REQUEST|CLAIMER_REQUEST|ACCOUNT_CLOSURE|DEFAULT_OPERATION|FRAUD}</Reason>
</CancelClaimRequest>
```

**Response:**

```xml
<CancelClaimResponse>
  <Claim>
    <ClaimId>{UUID}</ClaimId>
    <Status>CANCELLED</Status>
    <CancelReason>CLAIMER_REQUEST</CancelReason>
  </Claim>
</CancelClaimResponse>
```

---

### CreateInfractionReport

Opens an infraction report against a Pix key or transaction, typically for fraud or rule violations. Part of the MED (Special Return Mechanism) process.

**Endpoint:** `POST /api/v2/infraction-reports`

**Request:**

```xml
<CreateInfractionReportRequest>
  <InfractionReport>
    <EndToEndId>{E2E ID of the disputed transaction}</EndToEndId>
    <InfractionType>{FRAUD|REQUEST_FOR_INFORMATION}</InfractionType>
    <ReportDetails>{Description of the infraction}</ReportDetails>
  </InfractionReport>
</CreateInfractionReportRequest>
```

**Infraction Types:**
- `FRAUD` -- Confirmed or suspected fraud
- `REQUEST_FOR_INFORMATION` -- Request for information about a transaction

**Response:**

```xml
<CreateInfractionReportResponse>
  <InfractionReport>
    <InfractionReportId>{UUID}</InfractionReportId>
    <EndToEndId>{E2E ID}</EndToEndId>
    <InfractionType>FRAUD</InfractionType>
    <Status>OPEN</Status>
    <CreationDate>2025-02-15T10:30:00.000-03:00</CreationDate>
    <ReportedBy>{Reporter ISPB}</ReportedBy>
    <DebitedParticipant>{ISPB}</DebitedParticipant>
    <CreditedParticipant>{ISPB}</CreditedParticipant>
  </InfractionReport>
</CreateInfractionReportResponse>
```

---

### AcceptInfractionReport

Accepts (acknowledges) an infraction report as the counterpart PSP. Indicates agreement with the reported infraction.

**Endpoint:** `POST /api/v2/infraction-reports/{infractionReportId}/accept`

**Path Parameters:**
- `infractionReportId` -- UUID of the infraction report

**Request:**

```xml
<AcceptInfractionReportRequest>
  <InfractionReportId>{UUID}</InfractionReportId>
  <AnalysisResult>AGREED</AnalysisResult>
  <AnalysisDetails>{Details of the analysis}</AnalysisDetails>
</AcceptInfractionReportRequest>
```

**Response:**

```xml
<AcceptInfractionReportResponse>
  <InfractionReport>
    <InfractionReportId>{UUID}</InfractionReportId>
    <Status>ACCEPTED</Status>
    <AnalysisResult>AGREED</AnalysisResult>
  </InfractionReport>
</AcceptInfractionReportResponse>
```

---

### CreateRefund

Creates a refund solicitation following a confirmed infraction report. Requests the return of funds from a disputed transaction.

**Endpoint:** `POST /api/v2/refunds`

**Request:**

```xml
<CreateRefundRequest>
  <Refund>
    <EndToEndId>{E2E ID of the original transaction}</EndToEndId>
    <InfractionReportId>{UUID of the related infraction report}</InfractionReportId>
    <RefundAmount>{Amount to refund}</RefundAmount>
    <RefundDetails>{Description}</RefundDetails>
  </Refund>
</CreateRefundRequest>
```

**Response:**

```xml
<CreateRefundResponse>
  <Refund>
    <RefundId>{UUID}</RefundId>
    <EndToEndId>{E2E ID}</EndToEndId>
    <RefundAmount>100.50</RefundAmount>
    <Status>OPEN</Status>
    <CreationDate>2025-02-15T10:30:00.000-03:00</CreationDate>
  </Refund>
</CreateRefundResponse>
```

---

### CloseRefund

Closes a refund solicitation, either completing or rejecting it.

**Endpoint:** `POST /api/v2/refunds/{refundId}/close`

**Path Parameters:**
- `refundId` -- UUID of the refund to close

**Request:**

```xml
<CloseRefundRequest>
  <RefundId>{UUID}</RefundId>
  <AnalysisResult>{TOTALLY_RETURNED|PARTIALLY_RETURNED|NOT_RETURNED}</AnalysisResult>
  <AnalysisDetails>{Details}</AnalysisDetails>
</CloseRefundRequest>
```

**Analysis Results:**
- `TOTALLY_RETURNED` -- Full amount was returned
- `PARTIALLY_RETURNED` -- Partial amount was returned
- `NOT_RETURNED` -- Refund was denied

**Response:**

```xml
<CloseRefundResponse>
  <Refund>
    <RefundId>{UUID}</RefundId>
    <Status>CLOSED</Status>
    <AnalysisResult>TOTALLY_RETURNED</AnalysisResult>
  </Refund>
</CloseRefundResponse>
```

---

## DICT Sync and Notifications

DICT provides event notifications to PSPs about changes to keys they own or claims that affect them.

### Event Types

| Event | Description |
|-------|-------------|
| `KEY_CREATED` | A new key was registered |
| `KEY_DELETED` | A key was removed |
| `KEY_UPDATED` | Key or account information was updated |
| `CLAIM_CREATED` | A new claim was created against one of your keys |
| `CLAIM_CONFIRMED` | A claim was confirmed |
| `CLAIM_CANCELLED` | A claim was cancelled |
| `CLAIM_COMPLETED` | A claim completed and the key was transferred |
| `INFRACTION_REPORT_CREATED` | An infraction report was opened |
| `REFUND_CREATED` | A refund solicitation was created |

### Polling for Events

**Endpoint:** `GET /api/v2/events?startDate={ISO8601}&endDate={ISO8601}`

PSPs should poll for events regularly to stay synchronized with DICT state changes.

---

## Error Response Format

All DICT API errors follow a standard format:

```xml
<Error>
  <Code>{Error code}</Code>
  <Message>{Human-readable description}</Message>
  <Details>{Additional context}</Details>
</Error>
```

### Common HTTP Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Bad request (invalid input) |
| 403 | Forbidden (authentication or authorization failure) |
| 404 | Resource not found |
| 409 | Conflict (e.g., key already exists, claim already active) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |
| 503 | Service unavailable |
