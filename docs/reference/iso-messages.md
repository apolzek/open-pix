# ISO 20022 Message Reference

Reference documentation for ISO 20022 messages used in the Bacen SPI (Sistema de Pagamentos Instantaneos) for Pix transactions. All messages follow the Bacen SPI catalog (Catálogo de Mensagens e Serviços do SPI), which adapts the ISO 20022 standard. This page reflects **catalog 5.13** (files `spi.5.13.1`); copies of the official XSDs and examples live in `simulator/spec/spi-5.13.1/`.

---

## Version Numbering

There is no single "SPI version" for all messages. The catalog has its own version (5.13), and **each message type has its own version** inside it. The version appears in two places: the envelope namespace and `AppHdr/MsgDefIdr`.

| Message | Version (catalog 5.13) | Envelope namespace | MsgDefIdr |
|---------|------------------------|--------------------|-----------|
| pacs.008 | 1.16 | `https://www.bcb.gov.br/pi/pacs.008/1.16` | `pacs.008.spi.1.16` |
| pacs.002 | 1.17 | `https://www.bcb.gov.br/pi/pacs.002/1.17` | `pacs.002.spi.1.17` |
| pacs.004 | 1.5 | `https://www.bcb.gov.br/pi/pacs.004/1.5` | `pacs.004.spi.1.5` |

Other messages have their own versions too (e.g. camt.054 1.16, admi.002 1.5, reda.016 1.5); check the catalog for each one.

**Important:** Bacen enables and retires message versions over time. Do not guess or "bump to the next version": ask the ICOM which versions are enabled with `GET /api/v1/in/catalog` (messages you may send) and `GET /api/v1/out/catalog` (messages you may receive), and make the version configurable. In the toolkit: `await icom.catalog("in")`. See [Known Pitfalls](../playbook/pitfalls.md#1-wrong-iso-message-version).

### Namespaces

The SPI does **not** use `urn:iso:std:iso:20022:...` namespaces, nor a separate `head.001` namespace for the header. Each message has one default namespace on `<Envelope>`; `AppHdr` and `Document` carry no namespace of their own:

```
pacs.008:  https://www.bcb.gov.br/pi/pacs.008/1.16
pacs.002:  https://www.bcb.gov.br/pi/pacs.002/1.17
pacs.004:  https://www.bcb.gov.br/pi/pacs.004/1.5
```

### Date and time format

Every date-time in SPI messages (`CreDt`, `CreDtTm`, `AccptncDtTm`, ...) is **UTC with milliseconds**: `YYYY-MM-DDThh:mm:ss.sssZ` (e.g. `2026-09-28T14:35:12.345Z`). The XSD type `ISONormalisedDateTime` enforces the `.sss` and the `Z`; offsets such as `-03:00` are rejected.

---

## Business Application Header (BAH / AppHdr)

Every message sent through the SPI is an `<Envelope>` with an `AppHdr` (routing and identification metadata) and a `Document`.

### XML Structure

```xml
<Envelope xmlns="https://www.bcb.gov.br/pi/pacs.008/1.16">
  <AppHdr>
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
            <Id>00038166</Id>
          </Othr>
        </FinInstnId>
      </FIId>
    </To>
    <BizMsgIdr>{M + ISPB + 23 alphanumeric}</BizMsgIdr>
    <MsgDefIdr>pacs.008.spi.1.16</MsgDefIdr>
    <CreDt>{UTC date-time, e.g. 2026-09-28T14:35:12.345Z}</CreDt>
    <Sgntr>{XMLDSig signature}</Sgntr>
  </AppHdr>
  <Document>
    <!-- message body -->
  </Document>
</Envelope>
```

### Fields

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| Sender ISPB | `Fr/FIId/FinInstnId/Othr/Id` | Yes | ISPB of the sender of *this* message, pattern `[0-9A-Z]{8}`. Your ISPB when you send; `00038166` when the SPI sends to you |
| Receiver ISPB | `To/FIId/FinInstnId/Othr/Id` | Yes | ISPB of the receiver of *this* message. A PSP always sends to the SPI, so it is always `00038166` (Bacen/SPI) on messages you send. The counterparty PSP only appears in the Document (`DbtrAgt`/`CdtrAgt`) |
| BizMsgIdr | `BizMsgIdr` | Yes | `M` + ISPB (8, `[0-9A-Z]`) + 23 `[a-zA-Z0-9]` = 32 chars, case sensitive, never repeated. Same value as `GrpHdr/MsgId` |
| MsgDefIdr | `MsgDefIdr` | Yes | Message type and version. Example: `pacs.008.spi.1.16` |
| CreDt | `CreDt` | Yes | Creation date-time, UTC with milliseconds. Example: `2026-09-28T14:35:12.345Z` |
| Sgntr | `Sgntr` | Yes | XMLDSig signature of the message (Manual de Segurança da RSFN). Bacen's examples leave it empty (`<Sgntr/>`); real messages must be signed |

---

## pacs.008 -- FIToFICustomerCreditTransfer

The Pix payment order. Sent by the payer's PSP to the SPI, which forwards it to the receiving PSP (identified by `CdtrAgt`).

### XML Structure (Document)

Based on Bacen's example `pacs.008_CONTA_1_msg.xml` and the output of `scripts/spi/pacs008-generator.ts`:

```xml
<Document>
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>{Same as BizMsgIdr}</MsgId>
      <CreDtTm>{UTC date-time}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>CLRG</SttlmMtd>
      </SttlmInf>
      <PmtTpInf>
        <InstrPrty>HIGH</InstrPrty>
        <SvcLvl>
          <Prtry>PAGPRI</Prtry>
        </SvcLvl>
      </PmtTpInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <EndToEndId>{E2E ID, 32 chars}</EndToEndId>
        <!-- <TxId> only for QRDN/QRES/APDN/APES/INIC/AUTO, see below -->
      </PmtId>
      <IntrBkSttlmAmt Ccy="BRL">{Amount}</IntrBkSttlmAmt>
      <AccptncDtTm>{UTC date-time the payer's PSP accepted the order (t0')}</AccptncDtTm>
      <ChrgBr>SLEV</ChrgBr>
      <MndtRltdInf>
        <Tp>
          <LclInstrm>
            <Prtry>{MANU|DICT|QRDN|QRES|INIC|AUTO|APDN|APES}</Prtry>
          </LclInstrm>
        </Tp>
      </MndtRltdInf>
      <Dbtr>
        <Nm>{Payer name}</Nm>
        <Id>
          <PrvtId>
            <Othr>
              <Id>{Payer CPF or CNPJ}</Id>
            </Othr>
          </PrvtId>
        </Id>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <Othr>
            <Id>{Account number}</Id>
            <Issr>{Branch, optional}</Issr>
          </Othr>
        </Id>
        <Tp>
          <Cd>{CACC|SVGS|TRAN|SLRY|OTHR}</Cd>
        </Tp>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <ClrSysMmbId>
            <MmbId>{Payer PSP ISPB}</MmbId>
          </ClrSysMmbId>
        </FinInstnId>
      </DbtrAgt>
      <CdtrAgt>
        <FinInstnId>
          <ClrSysMmbId>
            <MmbId>{Receiving PSP ISPB}</MmbId>
          </ClrSysMmbId>
        </FinInstnId>
      </CdtrAgt>
      <Cdtr>
        <Id>
          <PrvtId>
            <Othr>
              <Id>{Receiver CPF or CNPJ}</Id>
            </Othr>
          </PrvtId>
        </Id>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <Othr>
            <Id>{Account number}</Id>
            <Issr>{Branch, optional}</Issr>
          </Othr>
        </Id>
        <Tp>
          <Cd>{CACC|SVGS|TRAN|OTHR}</Cd>
        </Tp>
        <Prxy>
          <Id>{Pix key; only for DICT/QRDN/QRES/APDN/APES/INIC}</Id>
        </Prxy>
      </CdtrAcct>
      <Purp>
        <Cd>IPAY</Cd>
      </Purp>
      <RmtInf>
        <Ustrd>{Free text, optional}</Ustrd>
      </RmtInf>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>
```

Note what is **not** in a Pix pacs.008: no `IntrBkSttlmDt` (the SPI fills the accounting date in its own pacs.002), no creditor name (`Cdtr/Nm`), and `PmtTpInf` lives in `GrpHdr`, not in `CdtTrfTxInf`.

### Field Reference

#### Group Header (GrpHdr)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| MsgId | `GrpHdr/MsgId` | Yes | Message id, `M` + ISPB + 23 alphanumeric (32 chars) |
| CreDtTm | `GrpHdr/CreDtTm` | Yes | Creation date-time, UTC `YYYY-MM-DDThh:mm:ss.sssZ` |
| NbOfTxs | `GrpHdr/NbOfTxs` | Yes | Number of transactions. Always `1` for Pix |
| SttlmMtd | `GrpHdr/SttlmInf/SttlmMtd` | Yes | Settlement method. Always `CLRG` |
| InstrPrty | `GrpHdr/PmtTpInf/InstrPrty` | Yes | `HIGH` (instant) or `NORM` (non-priority). Must be `HIGH` when `Purp` is `REFU` or `IPRT` |
| SvcLvl/Prtry | `GrpHdr/PmtTpInf/SvcLvl/Prtry` | Yes | `PAGPRI` with `HIGH`; `PAGAGD` (scheduled Pix) or `PAGFRD` (payment under anti-fraud analysis) with `NORM` |

#### Payment Identification (PmtId)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| EndToEndId | `CdtTrfTxInf/PmtId/EndToEndId` | Yes | 32-character End-to-End ID (UTC timestamp). See [EndToEndId Format](endtoendid-format.md) |
| TxId | `CdtTrfTxInf/PmtId/TxId` | Conditional | Receiver's reconciliation id (`[a-zA-Z0-9]`). Required for `QRDN`/`APDN` (26-35 chars, from the dynamic QR payload) and `INIC` (up to 25); filled for `QRES`/`APES` when the static QR has one (up to 25); rules for `AUTO` depend on the payment initiator; must be absent for `MANU` and `DICT` |

#### Amount, time and charges

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| IntrBkSttlmAmt | `CdtTrfTxInf/IntrBkSttlmAmt` | Yes | Amount with `Ccy="BRL"`, dot as decimal separator, two decimals: `100.50` |
| AccptncDtTm | `CdtTrfTxInf/AccptncDtTm` | Yes | When the payer's PSP accepted the user's order (t0'), UTC. The 40-second limit of the Manual de Tempos counts from here |
| ChrgBr | `CdtTrfTxInf/ChrgBr` | Yes | Always `SLEV` |
| LclInstrm/Prtry | `CdtTrfTxInf/MndtRltdInf/Tp/LclInstrm/Prtry` | Yes | How the payment was initiated: `MANU` (manual account data), `DICT` (Pix key), `QRDN` (dynamic QR), `QRES` (static QR), `INIC` (payment initiator), `AUTO` (Pix Automático), `APDN`/`APES` (dynamic/static QR via approximation). Must be `MANU` when `Purp` is `REFU` or `IPRT` |
| InitgPty | `CdtTrfTxInf/InitgPty/Id/OrgId/Othr/Id` | Conditional | CNPJ of the payment initiator, when there is one |

#### Debtor (payer)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| Dbtr/Nm | `CdtTrfTxInf/Dbtr/Nm` | Yes | Payer name, up to 140 characters |
| Dbtr/Id | `CdtTrfTxInf/Dbtr/Id/PrvtId/Othr/Id` | Yes | Payer CPF (11 digits) or CNPJ (14 characters; `[0-9A-Z]{12}[0-9]{2}`, alphanumeric CNPJ accepted) |
| DbtrAcct/Id | `CdtTrfTxInf/DbtrAcct/Id/Othr/Id` | Yes | Account number, `[0-9A-Z]{1,20}`, with check digit if any |
| DbtrAcct/Issr | `CdtTrfTxInf/DbtrAcct/Id/Othr/Issr` | No | Branch, up to 4 digits, without check digit. Omit if the account has no branch |
| DbtrAcct/Tp | `CdtTrfTxInf/DbtrAcct/Tp/Cd` | Yes | `CACC` (checking), `SVGS` (savings), `TRAN` (payment account), `SLRY` (salary), `OTHR` |
| DbtrAgt | `CdtTrfTxInf/DbtrAgt/FinInstnId/ClrSysMmbId/MmbId` | Yes | Payer PSP ISPB (`[0-9A-Z]{8}`) |

#### Creditor (receiver)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| CdtrAgt | `CdtTrfTxInf/CdtrAgt/FinInstnId/ClrSysMmbId/MmbId` | Yes | Receiving PSP ISPB. This is how the SPI routes the payment |
| Cdtr/Id | `CdtTrfTxInf/Cdtr/Id/PrvtId/Othr/Id` | Yes | Receiver CPF or CNPJ. There is **no** creditor name element |
| CdtrAcct/Id | `CdtTrfTxInf/CdtrAcct/Id/Othr/Id` | Yes | Receiver account number |
| CdtrAcct/Issr | `CdtTrfTxInf/CdtrAcct/Id/Othr/Issr` | No | Receiver branch |
| CdtrAcct/Tp | `CdtTrfTxInf/CdtrAcct/Tp/Cd` | Yes | `CACC`, `SVGS`, `TRAN` or `OTHR` (`SLRY` must not be used: salary accounts do not receive payments) |
| CdtrAcct/Prxy | `CdtTrfTxInf/CdtrAcct/Prxy/Id` | Conditional | The Pix key. Required when `LclInstrm` is `DICT`, `QRDN`, `QRES`, `APDN`, `APES` or `INIC`; forbidden for `MANU` and `AUTO` |

#### Purpose and remittance information

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| Purp/Cd | `CdtTrfTxInf/Purp/Cd` | Yes | `IPAY` (regular Pix), `GSCB` (Pix Troco), `OTHR` (Pix Saque), `REFU` (MED refund for Pix Automático), `IPRT` (MED 2.0 return from the PSP's own account). `IPAY` for `AUTO` |
| RmtInf/Ustrd | `CdtTrfTxInf/RmtInf/Ustrd` | No | Free-text message between users |
| RmtInf/Strd | `CdtTrfTxInf/RmtInf/Strd` | Conditional | Required for `GSCB`/`OTHR` (Saque/Troco amounts), forbidden for `IPAY`/`REFU`/`IPRT` |

---

## pacs.002 -- FIToFIPaymentStatusReport

Status report. The receiving PSP sends one to the SPI in response to each pacs.008 (or pacs.004) it receives (`ACSP` or `RJCT`); the SPI then settles and sends its own pacs.002 to both PSPs (`ACSC` to the payer's PSP, `ACCC` to the receiving PSP, or `RJCT`).

**Timing (Manual de Tempos do Pix):** there is no fixed "pacs.002 deadline" for the receiver. The whole cycle has **40 seconds**, counted from `AccptncDtTm` (t0') to settlement (t4); if it is not settled in time the SPI rejects the payment with `AB03`. The receiving PSP is measured separately on its own processing time (t3' − t2): **p50 ≤ 1.4 s, p95 ≤ 2.3 s**.

### XML Structure (Document)

Based on Bacen's example `pacs.002_PSP_1_msg.xml` and `scripts/spi/pacs002-generator.ts`:

```xml
<Document>
  <FIToFIPmtStsRpt>
    <GrpHdr>
      <MsgId>{Same as BizMsgIdr}</MsgId>
      <CreDtTm>{UTC date-time}</CreDtTm>
    </GrpHdr>
    <TxInfAndSts>
      <OrgnlInstrId>{EndToEndId of the pacs.008, or RtrId of the pacs.004}</OrgnlInstrId>
      <OrgnlEndToEndId>{Original E2E ID}</OrgnlEndToEndId>
      <TxSts>RJCT</TxSts>
      <StsRsnInf>
        <Rsn>
          <Cd>{Reason code, only when RJCT}</Cd>
        </Rsn>
        <AddtlInf>{Optional details, up to 105 chars}</AddtlInf>
      </StsRsnInf>
    </TxInfAndSts>
  </FIToFIPmtStsRpt>
</Document>
```

There is no `OrgnlGrpInfAndSts` block. In the pacs.002 sent by the SPI there are also `FctvIntrBkSttlmDt/DtTm` (settlement time) and `OrgnlTxRef/IntrBkSttlmDt` (accounting date); participants must not fill them.

### Field Reference

#### Group Header (GrpHdr)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| MsgId | `GrpHdr/MsgId` | Yes | Message id for this status report (`M` + ISPB + 23) |
| CreDtTm | `GrpHdr/CreDtTm` | Yes | Creation date-time, UTC |

#### Transaction Information and Status (TxInfAndSts)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| OrgnlInstrId | `TxInfAndSts/OrgnlInstrId` | Yes | `EndToEndId` of the original pacs.008, or `RtrId` of the original pacs.004 |
| OrgnlEndToEndId | `TxInfAndSts/OrgnlEndToEndId` | Yes | The EndToEndId of the original payment |
| TxSts | `TxInfAndSts/TxSts` | Yes | Status code (see below) |
| Rsn/Cd | `TxInfAndSts/StsRsnInf/Rsn/Cd` | Conditional | Reason code, used when `TxSts` is `RJCT` |
| AddtlInf | `TxInfAndSts/StsRsnInf/AddtlInf` | No | Free text, up to 105 characters |

### Status Codes (TxSts)

| Code | Name | Sent by | Description |
|------|------|---------|-------------|
| `ACSP` | AcceptedSettlementInProcess | Receiving PSP | Payment accepted after the receiver's checks. This is the success response of the receiving PSP |
| `RJCT` | Rejected | Receiving PSP or SPI | Payment/return rejected. A reason code goes in `StsRsnInf` |
| `ACSC` | AcceptedSettlementCompletedDebitorAccount | SPI | Settlement completed, notice to the payer's PSP |
| `ACCC` | AcceptedSettlementCompleted | SPI | Settlement completed, notice to the receiving PSP |

### Common Rejection Reason Codes

Names from the catalog's domain table (`ExternalStatusReason1Code`); the XSD enumeration is the full list (see [Error Codes](error-codes.md)).

| Code | Name | Typical Cause |
|------|------|---------------|
| AB03 | AbortedSettlementTimeout | SPI-generated: the payment was not settled within the 40-second limit |
| AB09 | ErrorCreditorAgent | Error at the receiving PSP |
| AC03 | InvalidCreditorAccountNumber | Creditor account does not exist or is invalid |
| AC06 | BlockedAccount | Creditor account is blocked |
| AC07 | ClosedCreditorAccountNumber | Creditor account is closed |
| AG03 | TransactionNotSupported | Transaction type not supported |
| AM02 | NotAllowedAmount | Amount not allowed |
| AM04 | InsufficientFunds | Insufficient funds (e.g. payer PSP's PI account) |
| AM12 | InvalidAmount | Amount malformed or invalid |
| BE01 | InconsistenWithEndCustomer | Creditor CPF/CNPJ inconsistent with the account |
| DS04 | OrderRejected | Rejected by the receiving PSP |
| FRAD | FraudulentOrigin | Fraud |
| MD01 | NoMandate | No mandate/authorization |
| RC09 / RC10 | Invalid debtor / creditor clearing system member identifier | Invalid ISPB in `DbtrAgt` / `CdtrAgt` |
| RR04 | Regulatory Reason | Regulatory reason |
| SL02 | SpecificServiceOfferedByCreditorAgent | Specific service not offered by the receiving PSP |

---

## pacs.004 -- PaymentReturn

Used to return (devolve) all or part of a settled Pix. Sent to the SPI by the PSP of the **original receiver**; the SPI forwards it to the original payer's PSP and answers with pacs.002 like a payment.

### XML Structure (Document)

Based on Bacen's example `pacs.004_SPI_1_msg.xml` and `scripts/spi/pacs004-generator.ts`:

```xml
<Document>
  <PmtRtr>
    <GrpHdr>
      <MsgId>{Same as BizMsgIdr}</MsgId>
      <CreDtTm>{UTC date-time}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>CLRG</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <TxInf>
      <RtrId>{D + ISPB + yyyyMMddHHmm UTC + 11}</RtrId>
      <OrgnlEndToEndId>{Original E2E ID}</OrgnlEndToEndId>
      <RtrdIntrBkSttlmAmt Ccy="BRL">{Return Amount}</RtrdIntrBkSttlmAmt>
      <SttlmPrty>HIGH</SttlmPrty>
      <ChrgBr>SLEV</ChrgBr>
      <RtrRsnInf>
        <Rsn>
          <Cd>{BE08|FR01|MD06|SL02}</Cd>
        </Rsn>
      </RtrRsnInf>
      <OrgnlTxRef>
        <DbtrAgt>
          <FinInstnId>
            <ClrSysMmbId>
              <MmbId>{ISPB of the ORIGINAL payer's PSP}</MmbId>
            </ClrSysMmbId>
          </FinInstnId>
        </DbtrAgt>
        <CdtrAgt>
          <FinInstnId>
            <ClrSysMmbId>
              <MmbId>{ISPB of the ORIGINAL receiver's PSP}</MmbId>
            </ClrSysMmbId>
          </FinInstnId>
        </CdtrAgt>
      </OrgnlTxRef>
    </TxInf>
  </PmtRtr>
</Document>
```

### Field Reference

#### Group Header (GrpHdr)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| MsgId | `GrpHdr/MsgId` | Yes | Message id for this return |
| CreDtTm | `GrpHdr/CreDtTm` | Yes | Creation date-time, UTC |
| NbOfTxs | `GrpHdr/NbOfTxs` | Yes | Always `1` |
| SttlmMtd | `GrpHdr/SttlmInf/SttlmMtd` | Yes | Always `CLRG` |

#### Transaction Information (TxInf)

| Field | Path | Required | Description |
|-------|------|----------|-------------|
| RtrId | `TxInf/RtrId` | Yes | Return identifier: `D` + ISPB of the returning PSP + UTC `yyyyMMddHHmm` + 11 alphanumeric. See [EndToEndId Format](endtoendid-format.md) |
| OrgnlEndToEndId | `TxInf/OrgnlEndToEndId` | Yes | The `E` EndToEndId of the original pacs.008, unchanged |
| RtrdIntrBkSttlmAmt | `TxInf/RtrdIntrBkSttlmAmt` | Yes | Amount returned, `Ccy="BRL"`. Can be partial (less than the original amount) |
| SttlmPrty | `TxInf/SttlmPrty` | Yes | `HIGH` (return sent immediately) or `NORM` (return postponed at the user's request, or delayed by the PSP with justification) |
| ChrgBr | `TxInf/ChrgBr` | Yes | Always `SLEV` |
| RtrRsnInf/Rsn/Cd | `TxInf/RtrRsnInf/Rsn/Cd` | Yes | Return reason code (see below) |
| OrgnlTxRef | `TxInf/OrgnlTxRef/DbtrAgt`, `/CdtrAgt` | Yes | Agents of the **original** transaction: `DbtrAgt` = original payer's PSP, `CdtrAgt` = original receiver's PSP |

There is no `IntrBkSttlmDt` in a pacs.004 (the element does not exist in the XSD).

### Return Reason Codes

The XSD (`ExternalReturnReason1Code`) accepts only these four:

| Code | Name | Use Case |
|------|------|----------|
| BE08 | BankError | Return due to an error of the receiving PSP |
| FR01 | Fraud | Return due to fraud (MED - Mecanismo Especial de Devolução) |
| MD06 | RefundRequestByEndCustomer | Return requested by the receiving user |
| SL02 | SpecificServiceOfferedByCreditorAgent | Return of Pix Saque / Pix Troco |

Codes such as `DS27`, `FOCR`, `AM09` or `AC03` are **not** valid return reasons.

---

## Full Message Envelope Example

A complete pacs.008 as generated by `scripts/spi/pacs008-generator.ts` (matches the official XSD `pacs.008.spi.1.16.xsd`; `npm run test:simulator` validates it). The payer PSP `12345678` pays a Pix key held at Bacen's virtual participant `99999A04`; the message itself goes to the SPI (`00038166`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="https://www.bcb.gov.br/pi/pacs.008/1.16">
    <AppHdr>
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
        <BizMsgIdr>M12345678abcdefghijklmnopqrstuvw</BizMsgIdr>
        <MsgDefIdr>pacs.008.spi.1.16</MsgDefIdr>
        <CreDt>2026-09-28T14:35:12.512Z</CreDt>
        <Sgntr/>
    </AppHdr>
    <Document>
        <FIToFICstmrCdtTrf>
            <GrpHdr>
                <MsgId>M12345678abcdefghijklmnopqrstuvw</MsgId>
                <CreDtTm>2026-09-28T14:35:12.512Z</CreDtTm>
                <NbOfTxs>1</NbOfTxs>
                <SttlmInf>
                    <SttlmMtd>CLRG</SttlmMtd>
                </SttlmInf>
                <PmtTpInf>
                    <InstrPrty>HIGH</InstrPrty>
                    <SvcLvl>
                        <Prtry>PAGPRI</Prtry>
                    </SvcLvl>
                </PmtTpInf>
            </GrpHdr>
            <CdtTrfTxInf>
                <PmtId>
                    <EndToEndId>E12345678202609281435abcDEF12345</EndToEndId>
                </PmtId>
                <IntrBkSttlmAmt Ccy="BRL">10.50</IntrBkSttlmAmt>
                <AccptncDtTm>2026-09-28T14:35:12.345Z</AccptncDtTm>
                <ChrgBr>SLEV</ChrgBr>
                <MndtRltdInf>
                    <Tp>
                        <LclInstrm>
                            <Prtry>DICT</Prtry>
                        </LclInstrm>
                    </Tp>
                </MndtRltdInf>
                <Dbtr>
                    <Nm>Fulano de Tal</Nm>
                    <Id>
                        <PrvtId>
                            <Othr>
                                <Id>11111111111</Id>
                            </Othr>
                        </PrvtId>
                    </Id>
                </Dbtr>
                <DbtrAcct>
                    <Id>
                        <Othr>
                            <Id>123456</Id>
                            <Issr>0001</Issr>
                        </Othr>
                    </Id>
                    <Tp>
                        <Cd>CACC</Cd>
                    </Tp>
                </DbtrAcct>
                <DbtrAgt>
                    <FinInstnId>
                        <ClrSysMmbId>
                            <MmbId>12345678</MmbId>
                        </ClrSysMmbId>
                    </FinInstnId>
                </DbtrAgt>
                <CdtrAgt>
                    <FinInstnId>
                        <ClrSysMmbId>
                            <MmbId>99999A04</MmbId>
                        </ClrSysMmbId>
                    </FinInstnId>
                </CdtrAgt>
                <Cdtr>
                    <Id>
                        <PrvtId>
                            <Othr>
                                <Id>22222222222</Id>
                            </Othr>
                        </PrvtId>
                    </Id>
                </Cdtr>
                <CdtrAcct>
                    <Id>
                        <Othr>
                            <Id>1</Id>
                            <Issr>1</Issr>
                        </Othr>
                    </Id>
                    <Tp>
                        <Cd>CACC</Cd>
                    </Tp>
                    <Prxy>
                        <Id>+5561988887777</Id>
                    </Prxy>
                </CdtrAcct>
                <Purp>
                    <Cd>IPAY</Cd>
                </Purp>
                <RmtInf>
                    <Ustrd>Teste</Ustrd>
                </RmtInf>
            </CdtTrfTxInf>
        </FIToFICstmrCdtTrf>
    </Document>
</Envelope>
```

Generating it with the toolkit:

```ts
import { generatePacs008 } from "./scripts/spi/pacs008-generator.js";

const xml = generatePacs008({
  senderIspb: "12345678",
  receiverIspb: "99999A04",          // goes to CdtrAgt; AppHdr/To is always 00038166
  amount: 10.5,
  localInstrument: "DICT",
  proxy: "+5561988887777",
  debitParty: { name: "Fulano de Tal", document: "11111111111", branch: "0001", accountNumber: "123456", accountType: "CACC" },
  creditParty: { document: "22222222222", branch: "1", accountNumber: "1", accountType: "CACC" },
  description: "Teste",
});
```

---

## Message Flow Summary

```
Payer PSP                          SPI (00038166)                  Receiving PSP
      |                               |                               |
      |-- pacs.008 (To=00038166) --->|                               |
      |                               |-- pacs.008 (Fr=00038166) ---->|
      |                               |                               |
      |                               |<-- pacs.002 ACSP/RJCT --------|
      |                               |                               |
      |                          [Settlement, within 40 s of AccptncDtTm]
      |                               |                               |
      |<-- pacs.002 ACSC / RJCT ------|-- pacs.002 ACCC / RJCT ------>|
      |                               |                               |
      |                               |<-- pacs.004 (return) ---------|  (optional)
      |<-- pacs.004 ------------------|                               |
      |<-- pacs.002 (result) ---------|-- pacs.002 (result) --------->|
```

The pacs.004 and the pacs.002 messages that result from it always travel on the primary channel. Check the flow diagrams in the catalog ("Participante solicita devolução de pagamento instantâneo") for the exact sequence of status messages in a return.

Every message is sent with `POST /api/v1/in/{ispb}/msgs` and received by reading the ICOM stream (`GET /api/v1/out/{ispb}/stream/start`, then `PI-Pull-Next`). Syntax, signature and version errors are not reported on the POST: they come back asynchronously as an `admi.002` on the stream. See [ICOM API](icom-api.md).

---

## Sources

- Catálogo de Mensagens e Serviços do SPI 5.13 (XSDs, examples and field rules): https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip (local copy in `simulator/spec/spi-5.13.1/`)
- Manual das Interfaces de Comunicação (ICOM) 1.12: https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf
- Manual de Tempos do Pix 7.0: https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf
