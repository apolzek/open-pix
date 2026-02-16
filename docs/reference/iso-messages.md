# ISO 20022 Message Reference

Reference documentation for ISO 20022 messages used in the Bacen SPI (Sistema de Pagamentos Instantaneos) for Pix transactions. All messages follow the Bacen SPI Catalog adaptations of the ISO 20022 standard.

---

## Version Numbering

Bacen maintains its own versioned SPI catalog based on ISO 20022. The version affects the XML namespace URI used in message envelopes and document bodies.

| Catalog Version | Namespace Pattern | Notes |
|-----------------|-------------------|-------|
| spi.1.11 | `urn:iso:std:iso:20022:tech:xsd:spi.1.11:*` | Legacy, may be deactivated |
| spi.1.12 | `urn:iso:std:iso:20022:tech:xsd:spi.1.12:*` | Transitional |
| spi.1.13 | `urn:iso:std:iso:20022:tech:xsd:spi.1.13:*` | Current (as of homologation) |

**Important:** Bacen can silently change the active version. Always make the version configurable and implement detection/fallback logic. See [Known Pitfalls](../playbook/pitfalls.md#1-wrong-iso-message-version).

### Namespace URI Examples

```
AppHdr:    urn:iso:std:iso:20022:tech:xsd:head.001.001.02
pacs.008:  urn:iso:std:iso:20022:tech:xsd:pacs.008.001.10.spi.1.13
pacs.002:  urn:iso:std:iso:20022:tech:xsd:pacs.002.001.13.spi.1.13
pacs.004:  urn:iso:std:iso:20022:tech:xsd:pacs.004.001.12.spi.1.13
```

---

## Business Application Header (BAH / AppHdr)

Every ISO 20022 message sent through the SPI is wrapped in a Business Application Header. The `AppHdr` provides routing and identification metadata.

### XML Structure

```xml
<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
  <Fr>
    <FIId>
      <FinInstnId>
        <Othr>
          <Id>{Sender ISPB}</Id>
        </Othr>
      </FinInstnId>
    </FIId>
  </Fr>
  <To>
    <FIId>
      <FinInstnId>
        <Othr>
          <Id>{Receiver ISPB}</Id>
        </Othr>
      </FinInstnId>
    </FIId>
  </To>
  <BizMsgIdr>{Unique Business Message Identifier}</BizMsgIdr>
  <MsgDefIdr>{Message Definition Identifier}</MsgDefIdr>
  <CreDt>{Creation DateTime ISO 8601}</CreDt>
</AppHdr>
```

### Fields

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| Sender ISPB | `Fr/FIId/FinInstnId/Othr/Id` | Yes | 8-digit ISPB of the sending institution |
| Receiver ISPB | `To/FIId/FinInstnId/Othr/Id` | Yes | 8-digit ISPB of the receiving institution. Use Bacen's ISPB (`00038166`) when sending to SPI |
| BizMsgIdr | `BizMsgIdr` | Yes | Unique identifier for this business message. Used for deduplication. Must be globally unique per sender |
| MsgDefIdr | `MsgDefIdr` | Yes | Identifies the message type. Example: `pacs.008.001.10.spi.1.13` |
| CreDt | `CreDt` | Yes | Creation date/time in ISO 8601 format. Example: `2025-02-15T10:30:00.000-03:00` |

---

## pacs.008 -- FIToFICustomerCreditTransfer

The primary Pix payment instruction message. Sent by the originating PSP to transfer funds to a beneficiary at another PSP.

### XML Structure

```xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.10.spi.1.13">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>{Message Identifier}</MsgId>
      <CreDtTm>{Creation DateTime}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>CLRG</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <EndToEndId>{E2E ID 32 chars}</EndToEndId>
        <TxId>{Transaction ID}</TxId>
      </PmtId>
      <PmtTpInf>
        <SvcLvl>
          <Prtry>{Priority}</Prtry>
        </SvcLvl>
        <LclInstrm>
          <Prtry>{Local Instrument}</Prtry>
        </LclInstrm>
      </PmtTpInf>
      <IntrBkSttlmAmt Ccy="BRL">{Amount}</IntrBkSttlmAmt>
      <IntrBkSttlmDt>{Settlement Date}</IntrBkSttlmDt>
      <ChrgBr>SLEV</ChrgBr>
      <Dbtr>
        <Nm>{Debtor Name}</Nm>
        <Id>
          <PrvtId>
            <Othr>
              <Id>{CPF or CNPJ}</Id>
            </Othr>
          </PrvtId>
        </Id>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <Othr>
            <Id>{Account Number}</Id>
          </Othr>
        </Id>
        <Tp>
          <Prtry>{Account Type}</Prtry>
        </Tp>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <Othr>
            <Id>{Debtor Agent ISPB}</Id>
          </Othr>
        </FinInstnId>
      </DbtrAgt>
      <CdtrAgt>
        <FinInstnId>
          <Othr>
            <Id>{Creditor Agent ISPB}</Id>
          </Othr>
        </FinInstnId>
      </CdtrAgt>
      <Cdtr>
        <Nm>{Creditor Name}</Nm>
        <Id>
          <PrvtId>
            <Othr>
              <Id>{CPF or CNPJ}</Id>
            </Othr>
          </PrvtId>
        </Id>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <Othr>
            <Id>{Account Number}</Id>
          </Othr>
        </Id>
        <Tp>
          <Prtry>{Account Type}</Prtry>
        </Tp>
      </CdtrAcct>
      <RmtInf>
        <Ustrd>{Remittance Information}</Ustrd>
      </RmtInf>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>
```

### Field Reference

#### Group Header (GrpHdr)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| MsgId | `GrpHdr/MsgId` | Yes | Unique message identifier assigned by the sender |
| CreDtTm | `GrpHdr/CreDtTm` | Yes | Message creation date/time in ISO 8601 |
| NbOfTxs | `GrpHdr/NbOfTxs` | Yes | Number of transactions. Always `1` for Pix |
| SttlmMtd | `GrpHdr/SttlmInf/SttlmMtd` | Yes | Settlement method. Always `CLRG` (Clearing) for SPI |

#### Payment Identification (PmtId)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| EndToEndId | `CdtTrfTxInf/PmtId/EndToEndId` | Yes | 32-character End-to-End ID. See [EndToEndId Format](endtoendid-format.md) |
| TxId | `CdtTrfTxInf/PmtId/TxId` | Yes | Transaction ID assigned by the originating PSP |

#### Payment Type Information (PmtTpInf)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| SvcLvl/Prtry | `CdtTrfTxInf/PmtTpInf/SvcLvl/Prtry` | Yes | Service level. Indicates processing priority |
| LclInstrm/Prtry | `CdtTrfTxInf/PmtTpInf/LclInstrm/Prtry` | Yes | Local instrument. Values: `MANU` (manual/key), `DICT` (DICT-resolved), `QRDN` (dynamic QR), `QRES` (static QR), `INIC` (payment initiation) |

#### Amount and Settlement

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| IntrBkSttlmAmt | `CdtTrfTxInf/IntrBkSttlmAmt` | Yes | Settlement amount with `Ccy="BRL"` attribute. Decimal format: `100.50` |
| IntrBkSttlmDt | `CdtTrfTxInf/IntrBkSttlmDt` | Yes | Settlement date in `YYYY-MM-DD` format |
| ChrgBr | `CdtTrfTxInf/ChrgBr` | Yes | Charge bearer. Always `SLEV` (Service Level) for Pix |

#### Debtor Information

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| Dbtr/Nm | `CdtTrfTxInf/Dbtr/Nm` | Yes | Debtor (payer) name. Max 140 characters |
| Dbtr/Id | `CdtTrfTxInf/Dbtr/Id/PrvtId/Othr/Id` | Yes | Debtor CPF (11 digits) or CNPJ (14 digits) |
| DbtrAcct/Id | `CdtTrfTxInf/DbtrAcct/Id/Othr/Id` | Yes | Debtor account number |
| DbtrAcct/Tp | `CdtTrfTxInf/DbtrAcct/Tp/Prtry` | Yes | Account type: `CACC` (checking), `SVGS` (savings), `SLRY` (salary), `TRAN` (transactional/payment) |
| DbtrAgt | `CdtTrfTxInf/DbtrAgt/FinInstnId/Othr/Id` | Yes | Debtor agent ISPB (8 digits) |

#### Creditor Information

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| Cdtr/Nm | `CdtTrfTxInf/Cdtr/Nm` | Yes | Creditor (payee) name. Max 140 characters |
| Cdtr/Id | `CdtTrfTxInf/Cdtr/Id/PrvtId/Othr/Id` | Yes | Creditor CPF (11 digits) or CNPJ (14 digits) |
| CdtrAcct/Id | `CdtTrfTxInf/CdtrAcct/Id/Othr/Id` | Yes | Creditor account number |
| CdtrAcct/Tp | `CdtTrfTxInf/CdtrAcct/Tp/Prtry` | Yes | Account type: `CACC`, `SVGS`, `SLRY`, `TRAN` |
| CdtrAgt | `CdtTrfTxInf/CdtrAgt/FinInstnId/Othr/Id` | Yes | Creditor agent ISPB (8 digits) |

#### Remittance Information

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| RmtInf/Ustrd | `CdtTrfTxInf/RmtInf/Ustrd` | No | Free-text remittance information (payment description). Max 140 characters |

---

## pacs.002 -- FIToFIPaymentStatusReport

Status report sent by the receiving PSP to acknowledge or reject a received pacs.008. Must be sent within approximately 10 seconds to avoid AB03 timeout.

### XML Structure

```xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.13.spi.1.13">
  <FIToFIPmtStsRpt>
    <GrpHdr>
      <MsgId>{Message Identifier}</MsgId>
      <CreDtTm>{Creation DateTime}</CreDtTm>
    </GrpHdr>
    <TxInfAndSts>
      <OrgnlEndToEndId>{Original E2E ID}</OrgnlEndToEndId>
      <TxSts>{Status Code}</TxSts>
      <StsRsnInf>
        <Rsn>
          <Prtry>{Reason Code}</Prtry>
        </Rsn>
      </StsRsnInf>
    </TxInfAndSts>
  </FIToFIPmtStsRpt>
</Document>
```

### Field Reference

#### Group Header (GrpHdr)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| MsgId | `GrpHdr/MsgId` | Yes | Unique message identifier for this status report |
| CreDtTm | `GrpHdr/CreDtTm` | Yes | Creation date/time in ISO 8601 |

#### Transaction Information and Status (TxInfAndSts)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| OrgnlEndToEndId | `TxInfAndSts/OrgnlEndToEndId` | Yes | The EndToEndId from the original pacs.008 being acknowledged |
| TxSts | `TxInfAndSts/TxSts` | Yes | Transaction status code (see below) |
| Rsn/Prtry | `TxInfAndSts/StsRsnInf/Rsn/Prtry` | Conditional | Reason code. Required when `TxSts` is `RJCT` |

### Status Codes (TxSts)

| Code | Name | Description |
|------|------|-------------|
| `ACSP` | AcceptedSettlementInProcess | Payment accepted. Settlement will proceed. This is the success response |
| `RJCT` | Rejected | Payment rejected. A reason code must be provided in `StsRsnInf` |

### Common Rejection Reason Codes

| Code | Description | Typical Cause |
|------|-------------|---------------|
| AB03 | Transaction timed out | SPI-generated: pacs.002 not received in time |
| AB09 | Invalid account | Creditor account does not exist or is invalid |
| AG03 | Account blocked | Creditor account is blocked or restricted |
| AM02 | Amount exceeds limit | Transaction amount exceeds allowed limits |
| AM12 | Invalid amount | Amount is zero, negative, or malformed |
| BE01 | Invalid beneficiary | Creditor information is inconsistent or invalid |
| DS04 | Order rejected | Transaction rejected by internal controls or compliance |
| MD01 | No mandate | No authorization or mandate for this transaction |
| SL02 | Service not allowed | Specific service/operation not available |
| RC09 | Invalid branch | Branch code is invalid |
| RR04 | Regulatory reason | Rejected for regulatory or compliance reasons |

---

## pacs.004 -- PaymentReturn

Used to return (devolve) a previously settled Pix transaction. Can be initiated by either the creditor PSP (e.g., fraud, user request) or mandated by Bacen (MED process).

### XML Structure

```xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.004.001.12.spi.1.13">
  <PmtRtr>
    <GrpHdr>
      <MsgId>{Message Identifier}</MsgId>
      <CreDtTm>{Creation DateTime}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>CLRG</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <TxInf>
      <RtrId>{Return Identifier}</RtrId>
      <OrgnlEndToEndId>{Original E2E ID}</OrgnlEndToEndId>
      <RtrdIntrBkSttlmAmt Ccy="BRL">{Return Amount}</RtrdIntrBkSttlmAmt>
      <IntrBkSttlmDt>{Settlement Date}</IntrBkSttlmDt>
      <RtrRsnInf>
        <Rsn>
          <Prtry>{Return Reason Code}</Prtry>
        </Rsn>
      </RtrRsnInf>
    </TxInf>
  </PmtRtr>
</Document>
```

### Field Reference

#### Group Header (GrpHdr)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| MsgId | `GrpHdr/MsgId` | Yes | Unique message identifier for this return |
| CreDtTm | `GrpHdr/CreDtTm` | Yes | Creation date/time in ISO 8601 |
| NbOfTxs | `GrpHdr/NbOfTxs` | Yes | Number of transactions. Always `1` |
| SttlmMtd | `GrpHdr/SttlmInf/SttlmMtd` | Yes | Always `CLRG` |

#### Transaction Information (TxInf)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| RtrId | `TxInf/RtrId` | Yes | Return identifier. Uses devolution EndToEndId format (D prefix). See [EndToEndId Format](endtoendid-format.md) |
| OrgnlEndToEndId | `TxInf/OrgnlEndToEndId` | Yes | The EndToEndId of the original pacs.008 being returned |
| RtrdIntrBkSttlmAmt | `TxInf/RtrdIntrBkSttlmAmt` | Yes | Amount being returned with `Ccy="BRL"`. Can be partial (less than original amount) |
| IntrBkSttlmDt | `TxInf/IntrBkSttlmDt` | Yes | Settlement date in `YYYY-MM-DD` |
| RtrRsnInf/Rsn/Prtry | `TxInf/RtrRsnInf/Rsn/Prtry` | Yes | Return reason code (see below) |

### Return Reason Codes

| Code | Description | Use Case |
|------|-------------|----------|
| BE08 | Beneficiary bank error | Creditor account issue identified post-settlement |
| DS27 | User requested | End-user requested the return via their PSP |
| FR01 | Fraud | Suspected or confirmed fraud |
| MD06 | Refund request by end customer | Customer-initiated return |
| SL02 | Specific service | Service-related return |
| FOCR | Following cancellation request | Return following a cancellation |
| AM09 | Wrong amount | Incorrect amount was transferred |
| AC03 | Invalid creditor account | Creditor account number is invalid |

---

## Full Message Envelope Example

A complete SPI message combines the BAH and document body:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<BizMsg xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
  <AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02">
    <Fr>
      <FIId>
        <FinInstnId>
          <Othr>
            <Id>12345678</Id>
          </Othr>
        </FinInstnId>
      </FIId>
    </Fr>
    <To>
      <FIId>
        <FinInstnId>
          <Othr>
            <Id>00038166</Id>
          </Othr>
        </FinInstnId>
      </FIId>
    </To>
    <BizMsgIdr>M12345678202502151030abcdefgh</BizMsgIdr>
    <MsgDefIdr>pacs.008.001.10.spi.1.13</MsgDefIdr>
    <CreDt>2025-02-15T10:30:00.000-03:00</CreDt>
  </AppHdr>
  <Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.10.spi.1.13">
    <!-- pacs.008 content here -->
  </Document>
</BizMsg>
```

---

## Message Flow Summary

```
Originating PSP                    SPI (Bacen)                    Receiving PSP
      |                               |                               |
      |-- pacs.008 (payment) -------->|                               |
      |                               |-- pacs.008 (forwarded) ------>|
      |                               |                               |
      |                               |<---- pacs.002 (ACSP/RJCT) ---|
      |<---- pacs.002 (forwarded) ----|                               |
      |                               |                               |
      |                          [Settlement]                         |
      |                               |                               |
      |                               |<---- pacs.004 (return) -------|  (optional)
      |<---- pacs.004 (forwarded) ----|                               |
```
