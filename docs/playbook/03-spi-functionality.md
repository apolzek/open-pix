# Pix Direct Participant Homologation: SPI Functionality

SPI functionality testing is the most detailed and time-consuming phase of homologation. You must demonstrate that your system correctly implements all SPI message types, handles all local instruments, manages timeouts, processes errors, and interacts correctly with both Bacen's virtual participant and a real partner PSP.

## Business Application Header (BAH)

Every SPI message is wrapped in a BAH envelope. The BAH provides routing and identification metadata that Bacen uses to deliver messages to the correct participant.

### BAH Structure

```xml
<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.01">
  <Fr>
    <FIId>
      <FinInstnId>
        <Othr>
          <Id>{SENDER_ISPB}</Id>
        </Othr>
      </FinInstnId>
    </FIId>
  </Fr>
  <To>
    <FIId>
      <FinInstnId>
        <Othr>
          <Id>{RECEIVER_ISPB}</Id>
        </Othr>
      </FinInstnId>
    </FIId>
  </To>
  <BizMsgIdr>{BUSINESS_MESSAGE_ID}</BizMsgIdr>
  <MsgDefIdr>{MESSAGE_DEFINITION}</MsgDefIdr>
  <CreDt>{ISO_TIMESTAMP}</CreDt>
</AppHdr>
```

### Key BAH Fields

| Field | Description | Example |
|-------|-------------|---------|
| `Fr` / `To` | Sender and receiver ISPBs | `12345678` |
| `BizMsgIdr` | Unique message identifier | `M1234567820240115103000abcdef` |
| `MsgDefIdr` | Message type identifier | `pacs.008.001.08` |
| `CreDt` | Creation timestamp (ISO 8601) | `2024-01-15T10:30:00.000Z` |

## Identifier Formats

### EndToEndId (E2E ID)

The EndToEndId uniquely identifies a Pix transaction across all participants. It is present in `pacs.008`, `pacs.002`, and referenced in `pacs.004`.

**Format**: `E{ISPB 8 digits}{YYYYMMDD}{HHmm}{random}` = **32 characters total**

```
E 12345678 20240115 1030 abcdef1234567890
│ │        │        │    │
│ │        │        │    └─ Random alphanumeric (remaining chars to reach 32)
│ │        │        └─ Time (HHmm)
│ │        └─ Date (YYYYMMDD)
│ └─ Your ISPB (8 digits, zero-padded)
└─ Literal "E" prefix
```

**Rules:**
- Must be exactly 32 characters
- Must start with uppercase `E`
- ISPB must be your institution's ISPB (the originator)
- Date/time must match the transaction creation time
- Random portion must ensure uniqueness (no collisions)
- Alphanumeric characters only (a-z, A-Z, 0-9)

### BizMsgIdr (Business Message Identifier)

The BizMsgIdr uniquely identifies each ICOM message (not the transaction, but the specific XML message).

**Format**: `M{ISPB 8 digits}{random}` = **32 characters total**

```
M 12345678 abcdef1234567890abcdefg
│ │        │
│ │        └─ Random alphanumeric (remaining chars to reach 32)
│ └─ Your ISPB (8 digits, zero-padded)
└─ Literal "M" prefix
```

**Rules:**
- Must be exactly 32 characters
- Must start with uppercase `M`
- Must be unique across all messages you send
- A single transaction may have multiple BizMsgIdrs (one for the pacs.008, one for the pacs.002, etc.)

## pacs.008 - FIToFICustomerCreditTransfer

The `pacs.008` is the payment initiation message. It flows from the debtor's institution to the creditor's institution via Bacen.

### Multi-Version Support

Bacen evolves the `pacs.008` specification over time. During homologation, you must support multiple versions simultaneously:

| Version | Namespace | Status |
|---------|-----------|--------|
| 1.11 | `urn:iso:std:iso:20022:tech:xsd:pacs.008.spi.1.11` | Legacy, still accepted |
| 1.12 | `urn:iso:std:iso:20022:tech:xsd:pacs.008.spi.1.12` | Current |
| 1.13 | `urn:iso:std:iso:20022:tech:xsd:pacs.008.spi.1.13` | Latest |

Your system must be able to:
- **Send** using the latest version
- **Receive and process** all supported versions (a counterparty may send an older version)
- Parse version-specific fields correctly (newer versions add optional fields)

### Required Fields

The core fields in a `pacs.008` include:

```xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.spi.1.13">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>{MESSAGE_ID}</MsgId>
      <CreDtTm>{TIMESTAMP}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>CLRG</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <EndToEndId>{E2E_ID}</EndToEndId>
        <TxId>{TX_ID}</TxId>
      </PmtId>
      <PmtTpInf>
        <SvcLvl>
          <Prtry>PAGPIX</Prtry>
        </SvcLvl>
        <LclInstrm>
          <Prtry>{LOCAL_INSTRUMENT}</Prtry>
        </LclInstrm>
      </PmtTpInf>
      <IntrBkSttlmAmt Ccy="BRL">{AMOUNT}</IntrBkSttlmAmt>
      <IntrBkSttlmDt>{DATE}</IntrBkSttlmDt>
      <ChrgBr>SLEV</ChrgBr>
      <Dbtr>
        <Nm>{DEBTOR_NAME}</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <Othr>
            <Id>{DEBTOR_ACCOUNT}</Id>
          </Othr>
        </Id>
        <Tp>
          <Prtry>{ACCOUNT_TYPE}</Prtry>
        </Tp>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <ClrSysMmbId>
            <MmbId>{DEBTOR_ISPB}</MmbId>
          </ClrSysMmbId>
        </FinInstnId>
      </DbtrAgt>
      <CdtrAgt>
        <FinInstnId>
          <ClrSysMmbId>
            <MmbId>{CREDITOR_ISPB}</MmbId>
          </ClrSysMmbId>
        </FinInstnId>
      </CdtrAgt>
      <Cdtr>
        <Nm>{CREDITOR_NAME}</Nm>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <Othr>
            <Id>{CREDITOR_ACCOUNT}</Id>
          </Othr>
        </Id>
        <Tp>
          <Prtry>{ACCOUNT_TYPE}</Prtry>
        </Tp>
      </CdtrAcct>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>
```

### Local Instruments

The local instrument (`LclInstrm/Prtry`) specifies how the payment was initiated. Each instrument has specific requirements:

| Instrument | Description | Key Requirements |
|------------|-------------|-----------------|
| **MANU** | Manual entry | Debtor manually entered account details. No DICT lookup. |
| **DICT** | DICT key lookup | Payment initiated via Pix key. DICT lookup must precede the payment. |
| **QRDN** | Dynamic QR code | Payment initiated by scanning a dynamic QR code. QR code payload must be included. |
| **QRES** | Static QR code | Payment initiated by scanning a static QR code. |
| **INIC** | Pix Iniciador (Payment Initiator) | Payment initiated by a third-party payment initiator. Additional fields required. |

Each instrument must be tested during homologation. The virtual participant accepts all instruments, but bilateral testing with a partner PSP validates real-world behavior.

## pacs.002 - PaymentStatusReport

The `pacs.002` is the response to a `pacs.008`. When your institution receives a `pacs.008` (someone is sending money to your customer), you must respond with a `pacs.002` indicating acceptance or rejection.

### Acceptance (ACSP)

```xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.spi.1.13">
  <FIToFIPmtStsRpt>
    <GrpHdr>
      <MsgId>{MESSAGE_ID}</MsgId>
      <CreDtTm>{TIMESTAMP}</CreDtTm>
    </GrpHdr>
    <TxInfAndSts>
      <OrgnlEndToEndId>{ORIGINAL_E2E_ID}</OrgnlEndToEndId>
      <TxSts>ACSP</TxSts>
    </TxInfAndSts>
  </FIToFIPmtStsRpt>
</Document>
```

`ACSP` (Accepted Settlement in Process) tells the originating institution that you have accepted the payment and will credit the recipient's account.

### Rejection (RJCT)

```xml
<TxInfAndSts>
  <OrgnlEndToEndId>{ORIGINAL_E2E_ID}</OrgnlEndToEndId>
  <TxSts>RJCT</TxSts>
  <StsRsnInf>
    <Rsn>
      <Prtry>{REASON_CODE}</Prtry>
    </Rsn>
  </StsRsnInf>
</TxInfAndSts>
```

Common rejection reason codes:

| Code | Meaning |
|------|---------|
| `AC03` | Invalid creditor account number |
| `AC06` | Blocked account |
| `AC07` | Closed creditor account |
| `AC14` | Account type not supported |
| `AG03` | Transaction type not supported |
| `AG13` | Invalid creditor account type |
| `AM02` | Amount exceeds limit |
| `AM09` | Wrong amount |
| `BE01` | Inconsistent with end customer |
| `BE17` | Invalid or missing creditor identification |
| `DS04` | Order rejected by the system |
| `DS27` | Regulatory reason |
| `MD06` | Refund request by end customer |
| `RC09` | Invalid branch |
| `RR04` | Regulatory reason |

### The 10-Second Timeout (AB03)

This is one of the most critical constraints in the Pix protocol:

**You have exactly 10 seconds from when Bacen receives the pacs.008 to when Bacen must receive your pacs.002 response.**

If your `pacs.002` arrives after 10 seconds, Bacen automatically generates a rejection with reason code `AB03` (Transaction timed out) and sends it to the originator. Your late response is discarded.

This means your entire receive pipeline (polling, parsing, account validation, crediting, response generation, sending) must complete within this window. In practice, aim for **under 5 seconds** to leave margin for network latency and processing variability.

The 10-second timeout is the single most common source of failures during homologation and in production. Design your architecture with this constraint as a first-class concern.

## pacs.004 - PaymentReturn (Devolution)

The `pacs.004` is used to return (devolve) a previously settled payment. This is distinct from rejecting a payment (which happens before settlement via `pacs.002` RJCT).

### When Devolutions Occur

- **Customer request**: The creditor's customer asks for a refund (MD06)
- **Operational error**: The payment was credited to the wrong account (SL02)
- **Fraud**: The transaction is identified as fraudulent (FRAD)
- **Original creditor request**: The creditor initiates a return (FOCR)

### D-Prefixed E2E IDs

Devolution messages use a special EndToEndId format that references the original transaction:

**Format**: `D{ISPB 8 digits}{YYYYMMDD}{HHmm}{random}` = **32 characters total**

Note the `D` prefix instead of `E`. This immediately identifies the message as a devolution.

### Return Reason Codes

| Code | Meaning | Use Case |
|------|---------|----------|
| `MD06` | Refund request by end customer | Customer-initiated return |
| `SL02` | Specific service offered by creditor agent | Operational error correction |
| `FOCR` | Following cancellation request | Creditor-initiated return |
| `FRAD` | Fraudulent originated credit transfer | Fraud-related return |
| `BE08` | Related reference is not unique | Duplicate payment |

### pacs.004 Structure

```xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.004.spi.1.13">
  <PmtRtr>
    <GrpHdr>
      <MsgId>{MESSAGE_ID}</MsgId>
      <CreDtTm>{TIMESTAMP}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>CLRG</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <TxInf>
      <RtrId>{RETURN_E2E_ID}</RtrId>
      <OrgnlEndToEndId>{ORIGINAL_E2E_ID}</OrgnlEndToEndId>
      <OrgnlTxId>{ORIGINAL_TX_ID}</OrgnlTxId>
      <RtrdIntrBkSttlmAmt Ccy="BRL">{RETURN_AMOUNT}</RtrdIntrBkSttlmAmt>
      <RtrRsnInf>
        <Rsn>
          <Prtry>{RETURN_REASON_CODE}</Prtry>
        </Rsn>
      </RtrRsnInf>
    </TxInf>
  </PmtRtr>
</Document>
```

### Devolution Rules

- A payment can be partially or fully returned
- Multiple partial returns are allowed (up to the original amount)
- Returns must reference the original transaction's EndToEndId and TxId
- The return amount cannot exceed the original payment amount minus any previous returns
- There are time limits for devolutions (varies by return reason: customer-requested returns have different deadlines than fraud-related returns)

## Testing with Bacen Virtual Participant (99999004)

The virtual participant `99999004` provides automated responses for SPI testing.

### As Sender (You Send pacs.008 to 99999004)

When you send a `pacs.008` to ISPB `99999004`:

1. The virtual participant processes the message
2. It returns a `pacs.002` with status `ACSP` (if the message is valid)
3. Or it returns a `pacs.002` with status `RJCT` and a reason code (if invalid)

This allows you to test your sending pipeline without needing a partner.

### As Receiver (99999004 Sends pacs.008 to You)

Bacen can trigger the virtual participant to send `pacs.008` messages to your ISPB. You must:

1. Poll and receive the incoming `pacs.008`
2. Parse and validate the message
3. Generate and send a `pacs.002` response (ACSP or RJCT)
4. Respond within the 10-second timeout

This is how Bacen tests your receiving pipeline.

### Test Scenarios

Bacen provides a detailed test plan with specific scenarios for each message type and local instrument. Each scenario has:

- Specific input data to use
- Expected outcome (accept, reject with specific code, return)
- Evidence requirements (screenshots, logs, or message dumps)

Follow the test plan exactly. Do not skip scenarios or improvise test data.

## Testing with Partner PSP (Bilateral)

Bilateral testing validates end-to-end behavior between two real institutions.

### Coordination Requirements

1. **Schedule a testing session**: Both sides must be available simultaneously
2. **Share test credentials**: Exchange account numbers, Pix keys, and ISPBs
3. **Agree on scenarios**: Decide which test cases to execute (sends, receives, returns)
4. **Real-time communication**: Have a live chat/call channel open during testing
5. **Log sharing**: Be prepared to share message logs for debugging

### Bilateral Test Cases

- You send a `pacs.008` to the partner; they accept with `pacs.002` ACSP
- You send a `pacs.008` to the partner; they reject with `pacs.002` RJCT
- Partner sends a `pacs.008` to you; you accept with `pacs.002` ACSP
- Partner sends a `pacs.008` to you; you reject with `pacs.002` RJCT
- You send a `pacs.004` (return) for a previously settled payment
- Partner sends a `pacs.004` (return) for a previously settled payment
- Test with different local instruments (DICT, MANU, QRDN, QRES)

## Common Errors and Solutions

### XML Schema Validation Failures

**Symptom**: `pacs.002` with RJCT and reason code indicating schema violation.

**Solution**: Validate your XML against the official XSD schemas before sending. Common issues:
- Wrong namespace for the message version
- Missing required fields
- Incorrect field ordering (XML element order matters in XSD validation)
- Invalid characters in text fields

### EndToEndId Collisions

**Symptom**: Rejection due to duplicate E2E ID.

**Solution**: Ensure your E2E ID generation uses sufficient randomness. UUID-based random components are recommended. Never reuse E2E IDs, even in the homologation environment.

### Timeout Failures (AB03)

**Symptom**: Your `pacs.002` responses are not arriving within 10 seconds.

**Solution**:
- Profile your receive pipeline to identify bottlenecks
- Increase polling frequency
- Process messages asynchronously (do not block the poll loop)
- Reduce database query time for account validation
- Consider accepting the payment first (ACSP) and performing additional validation asynchronously

### Incorrect Amount Formatting

**Symptom**: Amount-related rejections.

**Solution**: Amounts must be in BRL with exactly 2 decimal places. Use `0.01` not `0.1` or `1`. No thousands separators. The decimal separator is a period.

### BAH Routing Errors

**Symptom**: Message not delivered or rejected by Bacen before reaching the recipient.

**Solution**: Ensure the BAH `Fr` and `To` fields match the actual sender and receiver ISPBs. The `Fr` ISPB must match your certificate's ISPB. The `To` ISPB must be a valid participant.

---

**Previous:** [02 - Basic Connectivity](./02-basic-connectivity.md) | **Next:** [04 - SPI Capacity](./04-spi-capacity.md)
