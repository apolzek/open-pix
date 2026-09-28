# Error Codes Reference

Comprehensive reference of error codes encountered during Pix Direct Participant homologation and operation. Covers ISO 20022 rejection reason codes (used in pacs.002 and pacs.004 messages) and Bacen HTTP-level error codes (returned by ICOM and DICT APIs).

---

## ISO 20022 Rejection Reason Codes

These codes appear in `StsRsnInf/Rsn/Cd` of pacs.002 (rejection). pacs.004 (return) uses a separate, much shorter list in `RtrRsnInf/Rsn/Cd` ([below](#return-reason-codes-pacs004)). Code names come from the domain tables of the SPI catalog 5.13; the XSD enumeration of `pacs.002.spi.1.17` accepts only:

`AB03, AB09, AB11, AC03, AC06, AC07, AC14, AG03, AG12, AG13, AGNT, AM01, AM02, AM04, AM09, AM12, AM18, AM23, BE01, BE05, BE15, BE17, CH11, CH16, CN01, DS02, DS04, DS0G, DS27, DT02, DT05, DU03, DUPL, ED05, FF07, FF08, FRAD, INDT, MD01, RC09, RC10, RR04, RR06, SL02, UPAY`

Anything else (e.g. `AC04`, `AM13`, `FF01`, `NARR`, `MD06`, `FOCR`) is invalid in a pacs.002. The "Cause" and "Solution" columns below are practical guidance, not catalog text.

### Transaction Timeout

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| AB03 | AbortedSettlementTimeout | Settlement not completed in time | The Pix was not settled within **40 seconds** counted from `AccptncDtTm` (t0') (Manual de Tempos do Pix; for suspected fraud the count starts at t1', SPI receipt). The SPI rejects it and sends pacs.002 RJCT/AB03 to both PSPs. A slow receiving PSP is the usual cause, but the payer PSP's own delay (t1 − t0') also eats into the 40 s. | As receiver, answer with pacs.002 well within the Manual de Tempos targets (t3' − t2: p50 1.4 s, p95 2.3 s). As payer, set `AccptncDtTm` to the real acceptance time and send promptly. See [Pitfall #3](../playbook/pitfalls.md#3-pacs002-response-too-slow--ab03-timeout). |
| AB11 | TimeoutDebtorAgent | Timeout at the payer's PSP | Delay attributed to the debtor agent. | Review the payer-side pipeline latency. |

### Account Errors

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| AB09 | ErrorCreditorAgent | Error at the creditor agent | Processing error at the receiving PSP. | Receiving PSP should investigate its logs. |
| AC03 | InvalidCreditorAccountNumber | Creditor account number is invalid | Account does not exist at the creditor institution, or does not match branch/type. | Confirm account details (DICT lookup for key-based payments). |
| AC06 | BlockedAccount | Account is blocked | Account is blocked for regulatory, legal, or administrative reasons. | No automated resolution. Inform the user. |
| AC07 | ClosedCreditorAccountNumber | Creditor account closed | Creditor account is no longer active. | The key holder's PSP should remove stale DICT entries. |
| AC14 | InvalidCreditorAccountType | Invalid creditor account type | `CdtrAcct/Tp/Cd` does not match the account. | Use the account type returned by the DICT or given by the user. |
| AG03 | TransactionNotSupported | Transaction not supported | The receiving PSP does not support this type of transaction for the account. | Inform the user. |

### Amount Errors

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| AM02 | NotAllowedAmount | Amount not allowed | Amount outside a limit applicable to the account, the PSP, or the transaction type. | Check transaction limits. |
| AM04 | InsufficientFunds | Insufficient funds | Not enough balance, e.g. in the payer PSP's PI account at settlement. | Fund the PI account before testing. See [Pitfall #9](../playbook/pitfalls.md#9-pi-account-starts-with-zero-balance). |
| AM09 | WrongAmount | Wrong amount | Amount does not match what was expected (e.g. a dynamic QR code amount). | Verify the amount against the QR/charge. |
| AM12 | InvalidAmount | Invalid amount | Amount malformed or invalid. | Two decimals, dot separator: `"100.50"`. |
| AM23 | AmountExceedsSettlementLimit | Settlement limit exceeded | The amount exceeds a settlement limit. | Review limits with your treasury / Bacen. |

### Beneficiary Errors

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| BE01 | InconsistenWithEndCustomer | Creditor data inconsistent | The creditor CPF/CNPJ in the pacs.008 does not match the account holder at the receiving PSP. (There is no creditor name in the pacs.008.) | Use the CPF/CNPJ and account returned by the DICT. |
| BE17 | InvalidCreditorIdentificationCode | Invalid creditor identification | The creditor identification (CPF/CNPJ) is invalid. | Validate CPF/CNPJ check digits before sending. |

### Regulatory and Compliance

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| DS04 | OrderRejected | Order rejected | The receiving PSP rejected the order (e.g. internal controls). | No action from sender. |
| FRAD | FraudulentOrigin | Fraud | Rejected on suspicion of fraud. | Follow your anti-fraud process. |
| MD01 | NoMandate | No mandate | No mandate/authorization for this transaction. | Verify the mandate/authorization. |
| RR04 | Regulatory Reason | Regulatory rejection | Rejected for regulatory reasons. | Review the regulatory requirements. |
| SL02 | SpecificServiceOfferedByCreditorAgent | Service not offered | The receiving PSP does not offer the specific service (e.g. Pix Saque/Troco). | Check that the receiving PSP supports the service. |

### Technical and Format Errors

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| CH16 | ElementContentFormallyIncorrect | Element content incorrect | A field has content that is formally incorrect. | Validate against the XSD and the catalog field rules. |
| DT02 | InvalidCreationDate | Invalid creation date | Creation date-time invalid. | Use the current time in UTC with milliseconds (`...sssZ`). |
| FF07 | InvalidPurpose | Invalid purpose | `Purp/Cd` inconsistent with the rest of the message. | Check `Purp` rules in the catalog. |
| FF08 | InvalidEndToEndId | Invalid EndToEndId | EndToEndId invalid (format, or timestamp outside the 12-hour tolerance of the catalog rule). | See [EndToEndId Format](endtoendid-format.md). |
| RC09 / RC10 | InvalidDebtor/CreditorClearingSystemMemberIdentifier | Invalid ISPB | ISPB in `DbtrAgt` / `CdtrAgt` is invalid. | Check the ISPB (`[0-9A-Z]{8}`). |
| DUPL / DU03 | DuplicatePayment / DuplicateTransaction | Duplicate | The same operation was already processed. | Do not reuse ids for new payments. |

Schema, signature and message-version errors are not reported with pacs.002 reason codes: the SPI answers them with an **admi.002** (see [Schema Validation Errors](#schema-validation-errors)).

### Return Reason Codes (pacs.004)

The pacs.004 XSD (`pacs.004.spi.1.5`) accepts only four codes in `RtrRsnInf/Rsn/Cd`:

| Code | Name | Description | Use Case |
|------|------|-------------|----------|
| BE08 | BankError | Error of the receiving PSP | Return because the receiving PSP made a mistake |
| FR01 | Fraud | Fraud | Return due to fraud, MED (Mecanismo Especial de Devolução) |
| MD06 | RefundRequestByEndCustomer | Requested by the receiving user | The receiving user asked to return the money |
| SL02 | SpecificServiceOfferedByCreditorAgent | Pix Saque / Pix Troco | Return of a Saque/Troco transaction |

`DS27`, `FOCR`, `AM09` and other codes are not valid return reasons.

---

## Bacen HTTP Error Codes

These are HTTP-level errors returned by the ICOM and DICT APIs. Both use RFC 7807 problem details in XML (`application/problem+xml`).

### ICOM HTTP Errors

Error `type` URIs look like `https://icom.pi.rsfn.net.br/api/v1/error/<type>` (e.g. `forbidden`, `charset`). The manual's rule: **4xx** = the PSP's request is wrong, nothing was stored, do not resend the same request unchanged; **5xx** = API problem, a sent message may or may not have been stored, resend (the SPI is idempotent over 24 h) and report persistent 5xx to SPI support.

Important: the ICOM does **not** validate XML syntax or signatures on `POST /api/v1/in/{ispb}/msgs`. A 201 only means the message was stored; XSD, signature and version errors arrive later as admi.002 on your read stream.

| HTTP Status | Meaning | Cause | Solution |
|-------------|---------|-------|----------|
| 400 | Bad Request | Malformed request, e.g. wrong charset (`error/charset`: the body must be UTF-8). | Fix the request. |
| 403 | Forbidden | Access not allowed (`error/forbidden`): certificate/authorization problem. In practice, headers outside the ICOM allowed list (e.g. injected APM/tracing headers) also get requests refused. | Check the mTLS certificate and the ISPB. Send only the allowed headers. See [Pitfall #2](../playbook/pitfalls.md#2-extra-http-headers-rejected-by-bacen). |
| 404 | Not Found | Incorrect endpoint URL. | Verify base URL and path (send: `POST /api/v1/in/{ispb}/msgs`; receive: `GET /api/v1/out/{ispb}/stream/start`). |
| 405 | Method Not Allowed | Wrong HTTP method for the path. | Check the method. |
| 406 | Not Acceptable | `Accept` has a type the API cannot return. | Use `application/xml`, `multipart/mixed` or `*/*`. |
| 408 | Request Timeout | Request took too long. | Check network connectivity on RSFN. |
| 410 | Gone | Resource already removed (read stream endpoint, e.g. a `PI-Pull-Next` already closed). A 410 on the final `DELETE` is a success. | Open a new stream. |
| 411 | Length Required | Missing `Content-Length` / `Transfer-Encoding`. | Set `Content-Length`. |
| 413 | Payload Too Large | Body too large. | Send at most 10 messages per multipart request; use gzip. |
| 415 | Unsupported Media Type | Wrong `Content-Type` or `Content-Encoding`. | `Content-Type: application/xml; charset=utf-8` (or `multipart/mixed`), `Content-Encoding: gzip`. |
| 429 | Too Many Requests | Token bucket exhausted (`Retry-After` header), or more than 6 simultaneous read streams. | Honor `Retry-After`; keep at most 6 read streams per channel. |
| 500 | Internal Server Error | Bacen infrastructure error. | Retry with backoff; report if persistent. |
| 502 | Bad Gateway | Transient infrastructure issue. | Retry with exponential backoff. See [Pitfall #11](../playbook/pitfalls.md#11-no-retry-logic-for-transient-bacen-errors). |
| 503 | Service Unavailable | Too many simultaneous requests/connections from the same PSP, or other unavailability. Details in the body. | Reuse persistent connections, reduce concurrency, retry. |

### DICT HTTP Errors

Error `type` URIs follow `https://dict.pi.rsfn.net.br/api/v2/error/<Type>`. Generic types:

| Type | HTTP Status | Meaning |
|------|-------------|---------|
| BadRequest | 400 | Request with invalid format |
| Forbidden | 403 | Authenticated participant violates an authorization rule |
| NotFound | 404 | Entity not found (e.g. key not found on `GET /entries/{Key}`) |
| ResourceConflict | 409 | The resource is being processed by another operation; retry shortly |
| Gone | 410 | Resource no longer available |
| DeprecatedResource | 410 | Resource deprecated |
| RateLimited | 429 | Rate limit reached (see the DICT rate-limit policies) |
| InternalServerError | 500 | Unexpected condition |
| ServiceUnavailable | 503 | Service unavailable (maintenance or outside operating window) |

Business errors are **400** with a specific type. The most common during homologation:

| Type | HTTP Status | Meaning |
|------|-------------|---------|
| RequestSignatureInvalid | 400 | Invalid XMLDSig signature on the request |
| RequestIdAlreadyUsed | 400 | Same `RequestId` reused with different parameters |
| InvalidReason | 400 | Invalid reason for the operation |
| ParticipantInvalid | 400 | Participant cannot take part in the operation |
| TaxIdNumberBlocked | 400 | CPF/CNPJ blocked by court order |
| EntryInvalid | 400 | Invalid fields when creating/updating an entry |
| EntryLimitExceeded | 400 | Too many keys for the account |
| EntryAlreadyExists | 400 | Entry already exists for this key with the same participant and owner |
| EntryCannotBeQueriedForBookTransfer | 400 | Key held at the same PSP as the payer; do not query the DICT for book transfers |
| EntryKeyOwnedByDifferentPerson | 400 | Key belongs to another person; open an ownership claim |
| EntryKeyInCustodyOfDifferentParticipant | 400 | Same owner, other PSP; open a portability claim |
| EntryLockedByClaim | 400 | Open claim on the key; entry cannot be deleted |
| ClaimInvalid, ClaimTypeInconsistent, ClaimAlreadyExistsForKey, ClaimResultingEntryAlreadyExists, ClaimOperationInvalid, ClaimResolutionPeriodNotEnded, ClaimCompletionPeriodNotEnded | 400 | Claim errors |
| ClaimKeyNotFound | 404 | No entry registered for the claimed key |
| InfractionReport*, Refund*, FundsRecovery*, FraudMarkerInvalid | 400 | MED / infraction / refund / fraud marker errors |

Full list in the DICT API specification (`simulator/spec/dict-2.12.1/openapi.json`, section "Tratamento de erros"). See also [DICT API Reference](dict-api.md).

---

## Schema Validation Errors

Because the ICOM stores messages without validating them, XSD, signature and version errors come back asynchronously as an **admi.002** on your read stream. Its `RltdRef/Ref` holds the `MsgId` of your message or, if it could not be parsed, the `PI-ResourceId` returned by the POST; `Rsn/RjctgPtyRsn` has a short reason, `ErrLctn` the location, `RsnDesc` details, and `AddtlData` may carry `EndToEndId=...`. Always read and log admi.002 messages.

### Common Schema Errors

| Error Message | Cause | Solution |
|---------------|-------|----------|
| `Schema desconhecido ou nao habilitado para uso` | The message namespace/`MsgDefIdr` version is not enabled in the ICOM catalog. | Do not guess the next version: check `GET /api/v1/in/catalog` (toolkit: `icom.catalog("in")`) and use the version listed there (catalog 5.13: `pacs.008/1.16`, `pacs.002/1.17`, `pacs.004/1.5`). See [Pitfall #1](../playbook/pitfalls.md#1-wrong-iso-message-version). |
| `XML inválido` / `Não foi possível interpretar o XML` | Malformed XML. | Validate against the XSD (`npm run test:simulator` checks the toolkit's generators). |
| `Element not expected` | An element not defined in the schema, or in the wrong position. | Validate against the SPI XSD. Check element ordering. |
| `Missing required element` | A mandatory element is missing. | See [ISO Message Reference](iso-messages.md). |
| `Invalid value for element` | Value does not match the pattern or enumeration (e.g. date without `Z`/milliseconds, invalid reason code). | Check the field constraints. |

The exact wording of these messages (other than the admi.002 fields above) comes from practical experience and may vary.

---

## Error Handling Decision Matrix

| Error Type | Retry? | Backoff? | Max Retries | Action |
|------------|--------|----------|-------------|--------|
| AB03 (timeout) | No (as a new payment, with a new EndToEndId, if the user retries) | N/A | N/A | Already rejected by the SPI. Improve response speed. |
| AB09, AC03, AC06, AC07, AG03 (account) | No | N/A | N/A | Inform the user. Account-level issue at receiving PSP. |
| AM02, AM04 (amount/funds) | No | N/A | N/A | Check limits or fund the account. |
| BE01 (beneficiary) | No | N/A | N/A | Re-resolve via DICT. Verify creditor data. |
| DS04 (compliance) | No | N/A | N/A | No action. Receiving PSP decision. |
| HTTP 4xx (except 429) | No | N/A | N/A | Fix the request. Nothing was stored. |
| HTTP 403 | No (fix first) | N/A | N/A | Check certificate, ISPB and headers. |
| HTTP 5xx | Yes | Yes | 5 | Resend the same message (idempotent). Exponential backoff starting at 1 second. |
| HTTP 429 | Yes | Yes | 5 | Wait for `Retry-After`. |
| admi.002 (schema/signature/version) | No | N/A | N/A | Fix XML structure or version. |

---

## Monitoring and Alerting Recommendations

1. **Track AB03 rate and pacs.002 latency.** Any AB03 on incoming payments means the 40 s cycle was exceeded; measure your t3' − t2 against the Manual de Tempos targets (p50 1.4 s, p95 2.3 s).

2. **Alert on HTTP 403 spikes.** A sudden increase in 403 errors usually indicates a header injection issue (new APM deployment) or certificate expiration.

3. **Monitor HTTP 502 frequency.** Elevated 502 rates during business hours may indicate Bacen infrastructure issues. Check Bacen status channels.

4. **Log all rejection reason codes.** Aggregate rejection reasons to identify systemic issues (e.g., high BE01 rates may indicate stale DICT data).

5. **Dashboard key metrics:**
   - pacs.002 response time (p50, p95, p99), against 1.4 s / 2.3 s
   - AB03 rate (percentage of incoming pacs.008)
   - HTTP error rate by status code
   - Retry rate and success rate after retry
   - Connection pool utilization (active/idle sockets)
   - admi.002 count by reason

---

## Sources

- Catálogo de Mensagens e Serviços do SPI 5.13 (pacs.002/pacs.004 XSD enumerations, domain tables, admi.002): https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip
- Manual das Interfaces de Comunicação (ICOM) 1.12, section 2.1.1 (HTTP errors): https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf
- Manual de Tempos do Pix 7.0 (40 s limit, AB03, receiver SLA): https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf
- API DICT 2.12.1 ("Tratamento de erros"): https://www.bcb.gov.br/content/estabilidadefinanceira/pix/API-DICT.html
