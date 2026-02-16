# Error Codes Reference

Comprehensive reference of error codes encountered during Pix Direct Participant homologation and operation. Covers ISO 20022 rejection reason codes (used in pacs.002 and pacs.004 messages) and Bacen HTTP-level error codes (returned by ICOM and DICT APIs).

---

## ISO 20022 Rejection Reason Codes

These codes appear in the `StsRsnInf/Rsn/Prtry` field of pacs.002 (rejection) and `RtrRsnInf/Rsn/Prtry` field of pacs.004 (return) messages.

### Transaction Timeout

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| AB03 | AbortedClearingTimeout | Transaction timed out waiting for response | The receiving PSP did not send a pacs.002 within the SPI's timeout window (approximately 10 seconds). The SPI auto-generates this rejection. | Optimize your pacs.002 response pipeline to complete within 3 seconds. See [Pitfall #3](../playbook/pitfalls.md#3-pacs002-response-too-slow--ab03-timeout). |

### Account Errors

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| AB09 | InvalidCreditorAccountNumber | Creditor account number invalid | The account number provided does not exist or does not match the ISPB/branch combination at the creditor PSP. | Verify account data via DICT lookup before sending. Ensure the account number format matches the receiving institution's requirements. |
| AC03 | InvalidCreditorAccountNumber | Creditor account number is invalid | Account does not exist at the creditor institution. | Confirm account details via DICT resolution. |
| AC04 | ClosedAccountNumber | Account is closed | The creditor account has been closed. | DICT key should have been removed. Report stale key if persistent. |
| AC06 | BlockedAccount | Account is blocked | Account is blocked for regulatory, legal, or administrative reasons. | Contact the account holder or receiving PSP. No automated resolution possible. |
| AC07 | ClosedCreditorAccountNumber | Creditor account closed | Creditor account is no longer active. | Remove or update the DICT key associated with this account. |
| AG03 | TransactionForbidden | Account blocked or restricted | The creditor account exists but is blocked from receiving Pix transactions (judicial block, compliance hold, etc.). | No action possible from the sender side. Inform the end user that the recipient account is restricted. |

### Amount Errors

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| AM02 | NotAllowedAmount | Amount exceeds limit | Transaction amount exceeds the allowed limit for the debtor or creditor account, the PSP, or the transaction type. | Check transaction limits. For Pix, limits may be per-transaction, daily, or nightly. Respect Bacen-mandated limits. |
| AM04 | InsufficientFunds | Insufficient funds | Debtor account does not have sufficient balance to cover the transaction amount. | Ensure the debtor account (or PI settlement account) is funded before sending. See [Pitfall #9](../playbook/pitfalls.md#9-pi-account-starts-with-zero-balance). |
| AM09 | WrongAmount | Wrong amount | The transaction amount is incorrect (e.g., does not match the QR code amount, or return amount exceeds original). | Verify the amount matches the expected value. For returns, ensure the return amount does not exceed the original transaction amount. |
| AM12 | InvalidAmount | Invalid amount | Amount is zero, negative, or has too many decimal places. | Validate amount format: positive, two decimal places, formatted as `"100.50"`. |
| AM13 | ExceedsSettlementLimit | Settlement limit exceeded | The settlement amount exceeds the participant's configured settlement limit at Bacen. | Review your PI settlement limits with Bacen. May require a reserves transfer. |

### Beneficiary Errors

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| BE01 | InconsistentWithEndCustomer | Invalid beneficiary information | The creditor information in the pacs.008 does not match the account holder information at the receiving PSP. Name or document number mismatch. | Verify creditor data matches DICT resolution results. Ensure CPF/CNPJ and name are accurate. |
| BE17 | UnknownCreditor | Creditor unknown | The creditor cannot be identified at the receiving institution. | Resolve the creditor via DICT before sending. |

### Regulatory and Compliance

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| DS04 | OrderRejected | Transaction rejected by compliance | The receiving PSP's internal controls (AML, fraud detection, sanctions screening) rejected the transaction. | No action from sender. The receiving PSP determined the transaction violates their compliance policies. |
| MD01 | NoMandate | No mandate or authorization | No authorization exists for this type of transaction. | Verify the transaction type and local instrument are correct for the intended operation. |
| RR04 | RegulatoryReason | Regulatory rejection | Transaction rejected for regulatory compliance reasons. | Review the transaction for regulatory requirements. May require documentation or authorization. |
| SL02 | SpecificServiceOfferedByCreditorAgent | Service not available | The specific service or operation requested is not offered by the creditor agent. | Verify that the receiving PSP supports the transaction type (e.g., QR code payments, scheduled transfers). |

### Technical and Format Errors

| Code | Name | Description | Cause | Solution |
|------|------|-------------|-------|----------|
| FF01 | InvalidFileFormat | Invalid message format | The ISO 20022 message has structural or format errors. | Validate XML against the SPI XSD schemas before sending. Check namespace versions. |
| RC09 | InvalidBranchNumber | Invalid branch number | The branch code in the creditor account information is invalid. | Verify the branch number via DICT lookup. |
| NARR | Narrative | Free-text reason | A narrative/textual reason is provided instead of a structured code. | Read the narrative text in the additional information fields for details. |

### Return-Specific Reason Codes (pacs.004)

These codes are used specifically in pacs.004 return messages:

| Code | Name | Description | Use Case |
|------|------|-------------|----------|
| BE08 | BeneficiaryBankError | Beneficiary bank processing error | Creditor PSP identified an error after settlement |
| DS27 | UserRequest | User-requested return | End-user at creditor PSP requested the return |
| FR01 | Fraud | Fraud | Transaction identified as fraudulent. Part of MED process |
| MD06 | RefundRequestByEndCustomer | Customer refund request | Customer at creditor PSP requested a refund |
| FOCR | FollowingCancellationRequest | Cancellation follow-up | Return following a cancellation request |
| AM09 | WrongAmount | Wrong amount | Incorrect amount was sent |
| SL02 | SpecificService | Service-related return | Return due to service limitations |

---

## Bacen HTTP Error Codes

These are HTTP-level errors returned by the ICOM and DICT APIs at the transport layer, before ISO 20022 message processing.

### ICOM HTTP Errors

| HTTP Status | Meaning | Cause | Solution |
|-------------|---------|-------|----------|
| 400 | Bad Request | Malformed XML, schema validation failure, invalid namespace version. | Check XML structure, validate against XSD, verify the message version matches Bacen's current catalog. See [Pitfall #1](../playbook/pitfalls.md#1-wrong-iso-message-version). |
| 403 | Forbidden | mTLS certificate issue, unauthorized headers, or IP not allowed on RSFN. | Verify client certificate is valid and not expired. Remove all non-whitelisted headers (APM/monitoring). See [Pitfall #2](../playbook/pitfalls.md#2-extra-http-headers-rejected-by-bacen). |
| 404 | Not Found | Incorrect endpoint URL. | Verify the ICOM base URL and path. |
| 408 | Request Timeout | Request took too long to reach Bacen. | Check network connectivity on RSFN. Verify DNS resolution. |
| 413 | Payload Too Large | Request body exceeds the maximum allowed size. | Ensure messages are within size limits. Enable gzip compression for large payloads. |
| 429 | Too Many Requests | Rate limit exceeded. | Implement backoff. Reduce request frequency. Check if you are exceeding the 6-connection polling limit. |
| 500 | Internal Server Error | Bacen infrastructure error. | Retry with exponential backoff. If persistent, check Bacen status communications. |
| 502 | Bad Gateway | Bacen upstream service unavailable. Transient infrastructure issue. | Retry with exponential backoff. Common during Bacen maintenance windows and peak hours. See [Pitfall #11](../playbook/pitfalls.md#11-no-retry-logic-for-transient-bacen-errors). |
| 503 | Service Unavailable | Bacen service is temporarily down (maintenance, deployment). | Retry with exponential backoff. Check Bacen communications for scheduled maintenance. |
| 504 | Gateway Timeout | Bacen upstream service timed out. | Retry with exponential backoff. |

### DICT HTTP Errors

| HTTP Status | Meaning | Cause | Solution |
|-------------|---------|-------|----------|
| 400 | Bad Request | Invalid request format, missing required fields, invalid key format. | Validate request structure and key format before sending. |
| 403 | Forbidden | Certificate issue or authorization failure. | Verify mTLS certificate. Ensure your ISPB is authorized for the requested operation. |
| 404 | Not Found | Key not found in DICT. | The Pix key does not exist. Verify the key type and value. |
| 409 | Conflict | Resource conflict (key already exists, active claim exists). | Check for existing keys or claims before creating new ones. |
| 429 | Too Many Requests | DICT rate limit exceeded. | Implement backoff. DICT has per-ISPB rate limits. |
| 500 | Internal Server Error | DICT infrastructure error. | Retry with backoff. |
| 503 | Service Unavailable | DICT temporarily unavailable. | Retry with backoff. |

---

## Schema Validation Errors

When Bacen returns a `400` with a schema validation error, the response body typically contains details about the validation failure.

### Common Schema Errors

| Error Message | Cause | Solution |
|---------------|-------|----------|
| `Schema desconhecido ou nao habilitado para uso` | Wrong namespace version in the XML. Bacen does not recognize or has not enabled the schema version you are using. | Bump the version number (e.g., from `spi.1.11` to `spi.1.13`). See [Pitfall #1](../playbook/pitfalls.md#1-wrong-iso-message-version). |
| `Element not expected` | An XML element is present that is not defined in the schema, or is in the wrong position. | Validate XML against the SPI XSD. Check element ordering. |
| `Missing required element` | A mandatory XML element is missing from the message. | Review the message schema and add all required fields. See [ISO Message Reference](iso-messages.md). |
| `Invalid value for element` | A field value does not match the expected format or enumeration. | Check field format constraints (e.g., date formats, currency codes, amount formats). |

---

## Error Handling Decision Matrix

| Error Type | Retry? | Backoff? | Max Retries | Action |
|------------|--------|----------|-------------|--------|
| AB03 (timeout) | No | N/A | N/A | Already auto-rejected. Improve response speed. |
| AB09, AC03, AG03 (account) | No | N/A | N/A | Inform the user. Account-level issue at receiving PSP. |
| AM02, AM04 (amount/funds) | No | N/A | N/A | Check limits or fund the account. |
| BE01 (beneficiary) | No | N/A | N/A | Re-resolve via DICT. Verify creditor data. |
| DS04 (compliance) | No | N/A | N/A | No action. Receiving PSP decision. |
| HTTP 400 | No | N/A | N/A | Fix the request. |
| HTTP 403 | Maybe | Yes | 3 | Check headers first. If clean, may be transient. |
| HTTP 502/503/504 | Yes | Yes | 5 | Exponential backoff starting at 1 second. |
| HTTP 429 | Yes | Yes | 5 | Respect rate limits. Increase backoff. |
| Schema validation | No | N/A | N/A | Fix XML structure or version. |

---

## Monitoring and Alerting Recommendations

1. **Track AB03 rate.** If more than 1% of incoming transactions result in AB03, your response pipeline is too slow.

2. **Alert on HTTP 403 spikes.** A sudden increase in 403 errors usually indicates a header injection issue (new APM deployment) or certificate expiration.

3. **Monitor HTTP 502 frequency.** Elevated 502 rates during business hours may indicate Bacen infrastructure issues. Check Bacen status channels.

4. **Log all rejection reason codes.** Aggregate rejection reasons to identify systemic issues (e.g., high BE01 rates may indicate stale DICT data).

5. **Dashboard key metrics:**
   - pacs.002 response time (p50, p95, p99)
   - AB03 rate (percentage of incoming pacs.008)
   - HTTP error rate by status code
   - Retry rate and success rate after retry
   - Connection pool utilization (active/idle sockets)
