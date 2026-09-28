# Pix Direct Participant Homologation: SPI Functionality

SPI functionality testing is the most detailed and time-consuming phase of homologation. You must demonstrate that your system correctly implements the SPI message types, handles the local instruments, manages timeouts, processes errors, and interacts correctly with Bacen's virtual participants.

## Business Application Header (BAH)

Every SPI message travels inside an `Envelope` that holds the Business Application Header (`AppHdr`) and the `Document`. The envelope has a single default namespace per message type and version; `AppHdr` and `Document` carry no namespace of their own (there is no separate `head.001` or `urn:iso:...` namespace).

### BAH Structure

```xml
<Envelope xmlns="https://www.bcb.gov.br/pi/pacs.008/1.16">
  <AppHdr>
    <Fr>
      <FIId>
        <FinInstnId>
          <Othr>
            <Id>{YOUR_ISPB}</Id>
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
    <BizMsgIdr>{BUSINESS_MESSAGE_ID}</BizMsgIdr>
    <MsgDefIdr>pacs.008.spi.1.16</MsgDefIdr>
    <CreDt>{UTC_TIMESTAMP}</CreDt>
    <Sgntr/>
  </AppHdr>
  <Document>
    <!-- message body -->
  </Document>
</Envelope>
```

`Sgntr` carries the XMLDSig signature (Manual de Segurança da RSFN). Bacen's own examples leave it empty; the toolkit does the same, so sign before sending.

### Key BAH Fields

| Field | Description | Example |
|-------|-------------|---------|
| `Fr` | ISPB of the sender of *this* message | `12345678` (you) or `00038166` (SPI) |
| `To` | ISPB of the receiver of *this* message. A PSP always sends to the SPI, so `To` is always `00038166`; the counterparty PSP only appears in `DbtrAgt`/`CdtrAgt` inside the Document | `00038166` |
| `BizMsgIdr` | Unique message identifier (32 chars) | `M12345678abcdefghijklmnopqrstuvw` |
| `MsgDefIdr` | Message type and version, `<type>.spi.<version>` | `pacs.008.spi.1.16` |
| `CreDt` | Creation timestamp, UTC with milliseconds | `2026-09-28T14:35:12.345Z` |

All date-times in SPI messages are UTC with milliseconds (`YYYY-MM-DDThh:mm:ss.sssZ`); the XSD pattern enforces the `.sss` and the `Z`. Local offsets such as `-03:00` are rejected.

## Identifier Formats

### EndToEndId (E2E ID)

The EndToEndId uniquely identifies a Pix transaction across all participants. It is present in `pacs.008`, in the `pacs.002` (`OrgnlEndToEndId`), and in the `pacs.004` (`OrgnlEndToEndId`).

**Format**: `E{ISPB}{yyyyMMddHHmm UTC}{11 alphanumeric}` = **32 characters total**

```
E 12345678 202609281435 abcDEF12345
│ │        │            │
│ │        │            └─ 11 alphanumeric chars [a-zA-Z0-9]
│ │        └─ Date and time in UTC (yyyyMMddHHmm)
│ └─ ISPB, 8 chars [0-9A-Z] (e.g. 99999A04 is valid)
└─ Literal "E" prefix
```

**Rules:**
- Must be exactly 32 characters
- Must start with uppercase `E`
- The ISPB is the one of the participant that generated the id (direct or indirect participant); the first 8 digits of the initiator's CNPJ may also be used
- Date/time is **UTC**, not Brasília time; the SPI tolerates ±12 hours relative to its processing time
- The 11-char suffix must be unique within each `yyyyMMddHHmm`
- Alphanumeric characters only (a-z, A-Z, 0-9)

### BizMsgIdr (Business Message Identifier)

The BizMsgIdr uniquely identifies each ICOM message (not the transaction, but the specific XML message). The Document's `GrpHdr/MsgId` uses the same format.

**Format**: `M{ISPB}{23 alphanumeric}` = **32 characters total**

```
M 12345678 abcdefghijklmnopqrstuvw
│ │        │
│ │        └─ 23 alphanumeric chars [a-zA-Z0-9], case sensitive
│ └─ Your ISPB, 8 chars [0-9A-Z]
└─ Literal "M" prefix
```

**Rules:**
- Must be exactly 32 characters
- Must start with uppercase `M`
- Must never repeat across all messages you send
- A single transaction may have multiple BizMsgIdrs (one for the pacs.008, one for the pacs.002, etc.)

## pacs.008 - FIToFICustomerCreditTransfer

The `pacs.008` is the payment order. It flows from the payer's PSP to the SPI, which makes it available to the receiver's PSP.

### Message Versions

Each SPI message has its own version; there is no single catalog-wide "spi.1.x" version. In catalog 5.13:

| Message | Namespace | `MsgDefIdr` |
|---------|-----------|-------------|
| pacs.008 | `https://www.bcb.gov.br/pi/pacs.008/1.16` | `pacs.008.spi.1.16` |
| pacs.002 | `https://www.bcb.gov.br/pi/pacs.002/1.17` | `pacs.002.spi.1.17` |
| pacs.004 | `https://www.bcb.gov.br/pi/pacs.004/1.5` | `pacs.004.spi.1.5` |

Which versions are enabled in an environment is published by the ICOM catalog: `GET /api/v1/in/catalog` (what you may send) and `GET /api/v1/out/catalog` (what you may receive). An error like "Schema desconhecido ou não habilitado para uso" means you sent a version that is not in the catalog; check the catalog instead of guessing another version. When Bacen publishes a new catalog, keep parsing the versions that the `out` catalog still lists.

### Required Fields

The structure below follows Bacen's official example (`simulator/spec/spi-5.13.1/exemplos/pacs.008_*.xml`) and is what `generatePacs008` produces:

```xml
<Document>
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>{MESSAGE_ID}</MsgId>
      <CreDtTm>{UTC_TIMESTAMP}</CreDtTm>
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
        <EndToEndId>{E2E_ID}</EndToEndId>
      </PmtId>
      <IntrBkSttlmAmt Ccy="BRL">{AMOUNT}</IntrBkSttlmAmt>
      <AccptncDtTm>{UTC_TIMESTAMP_ACCEPTED_BY_PAYER_PSP}</AccptncDtTm>
      <ChrgBr>SLEV</ChrgBr>
      <MndtRltdInf>
        <Tp>
          <LclInstrm>
            <Prtry>{LOCAL_INSTRUMENT}</Prtry>
          </LclInstrm>
        </Tp>
      </MndtRltdInf>
      <Dbtr>
        <Nm>{DEBTOR_NAME}</Nm>
        <Id>
          <PrvtId>
            <Othr>
              <Id>{DEBTOR_CPF}</Id>
            </Othr>
          </PrvtId>
        </Id>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <Othr>
            <Id>{DEBTOR_ACCOUNT}</Id>
            <Issr>{DEBTOR_BRANCH}</Issr>
          </Othr>
        </Id>
        <Tp>
          <Cd>CACC</Cd>
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
        <Id>
          <PrvtId>
            <Othr>
              <Id>{CREDITOR_CPF}</Id>
            </Othr>
          </PrvtId>
        </Id>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <Othr>
            <Id>{CREDITOR_ACCOUNT}</Id>
            <Issr>{CREDITOR_BRANCH}</Issr>
          </Othr>
        </Id>
        <Tp>
          <Cd>CACC</Cd>
        </Tp>
        <Prxy>
          <Id>{PIX_KEY}</Id>
        </Prxy>
      </CdtrAcct>
      <Purp>
        <Cd>IPAY</Cd>
      </Purp>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>
```

Points that commonly go wrong:

- `PmtTpInf` lives in `GrpHdr`. `InstrPrty` `HIGH` requires `SvcLvl` `PAGPRI`; `NORM` requires `PAGAGD` (scheduled) or `PAGFRD` (under fraud analysis).
- `AccptncDtTm` (t0') is when the payer's PSP accepted the order. The 40-second settlement limit counts from it.
- There is no `IntrBkSttlmDt` in the pacs.008, and the local instrument sits in `MndtRltdInf/Tp/LclInstrm`, not in `PmtTpInf`.
- The creditor (`Cdtr`) has **no name**, only CPF/CNPJ. The debtor needs `Nm` and CPF/CNPJ. CNPJs may be alphanumeric (`[0-9A-Z]{12}[0-9]{2}`).
- Account `Id` is `[0-9A-Z]{1,20}`; `Issr` is the branch (up to 4 digits, optional); `Tp/Cd` is one of `CACC`, `SVGS`, `TRAN`, `SLRY`, `OTHR`.
- `Purp/Cd` is one of `IPAY`, `GSCB`, `OTHR`, `REFU`, `IPRT`.

### Local Instruments

The local instrument (`MndtRltdInf/Tp/LclInstrm/Prtry`) specifies how the payment was initiated:

| Instrument | Description | `CdtrAcct/Prxy` (Pix key) |
|------------|-------------|---------------------------|
| **MANU** | Manual entry of the account data | Forbidden |
| **DICT** | Manual entry of a Pix key (DICT lookup precedes the payment) | Required |
| **QRDN** | Dynamic QR code | Required |
| **QRES** | Static QR code | Required |
| **INIC** | Initiated through a payment initiation service, with all receiver data known | Required |
| **AUTO** | Pix Automático | Forbidden |
| **APDN** | Pix by proximity, from dynamic QR code data | Required |
| **APES** | Pix by proximity, from static QR code data | Required |

QR code and payment initiation payments may also carry `TxId` (the receiver's reconciliation id) and, for INIC, the initiator's CNPJ in `InitgPty`; `generatePacs008` exposes them as `txId` and `initiatingPartyCnpj`.

### Generating with the toolkit

```typescript
import { generatePacs008 } from "../scripts/spi/pacs008-generator.js";

const xml = generatePacs008({
  senderIspb: "12345678",          // your ISPB: AppHdr/Fr and DbtrAgt
  receiverIspb: "99999A04",        // CdtrAgt; AppHdr/To is always 00038166
  amount: 10.5,
  localInstrument: "DICT",
  proxy: "+5561988887777",
  debitParty: { name: "Fulano de Tal", document: "11111111111", branch: "0001", accountNumber: "123456", accountType: "CACC" },
  creditParty: { document: "22222222222", branch: "1", accountNumber: "1", accountType: "CACC" },
});
```

## pacs.002 - FIToFIPaymentStatusReport

The `pacs.002` is the status report for a `pacs.008` or `pacs.004`. When your institution receives a `pacs.008` (someone is sending money to your customer), you must answer with a `pacs.002` addressed to the SPI (`AppHdr/To` = `00038166`) indicating acceptance or rejection. The SPI then settles and sends its own `pacs.002` (`ACSC` to the payer's PSP, `ACCC` to the receiver's PSP, or `RJCT`) to both sides.

### Acceptance (ACSP)

```xml
<Envelope xmlns="https://www.bcb.gov.br/pi/pacs.002/1.17">
  <AppHdr>
    <!-- Fr = your ISPB, To = 00038166, MsgDefIdr = pacs.002.spi.1.17 -->
  </AppHdr>
  <Document>
    <FIToFIPmtStsRpt>
      <GrpHdr>
        <MsgId>{MESSAGE_ID}</MsgId>
        <CreDtTm>{UTC_TIMESTAMP}</CreDtTm>
      </GrpHdr>
      <TxInfAndSts>
        <OrgnlInstrId>{ORIGINAL_E2E_ID}</OrgnlInstrId>
        <OrgnlEndToEndId>{ORIGINAL_E2E_ID}</OrgnlEndToEndId>
        <TxSts>ACSP</TxSts>
      </TxInfAndSts>
    </FIToFIPmtStsRpt>
  </Document>
</Envelope>
```

There is no `OrgnlGrpInfAndSts`. `OrgnlInstrId` repeats the EndToEndId for a normal Pix. `ACSP` (Accepted Settlement in Process) tells the SPI that you accept the payment and it can settle.

### Rejection (RJCT)

```xml
<TxInfAndSts>
  <OrgnlInstrId>{ORIGINAL_E2E_ID}</OrgnlInstrId>
  <OrgnlEndToEndId>{ORIGINAL_E2E_ID}</OrgnlEndToEndId>
  <TxSts>RJCT</TxSts>
  <StsRsnInf>
    <Rsn>
      <Cd>{REASON_CODE}</Cd>
    </Rsn>
    <AddtlInf>{OPTIONAL_TEXT_UP_TO_105_CHARS}</AddtlInf>
  </StsRsnInf>
</TxInfAndSts>
```

```typescript
import { generatePacs002 } from "../scripts/spi/pacs002-generator.js";

const xml = generatePacs002({
  senderIspb: "12345678",
  originalEndToEndId: e2eId,
  status: "RJCT",
  rejectReasonCode: "AC03",
});
```

Common rejection reason codes (from the catalog's `ExternalStatusReason1Code`; the full enum is in the XSD):

| Code | Meaning | Raised by |
|------|---------|-----------|
| `AC03` | Receiver's branch/account missing or invalid | Receiver's PSP |
| `AC06` | Receiver's account is blocked | Receiver's PSP |
| `AC07` | Receiver's account is closed | Receiver's PSP |
| `AC14` | Wrong account type for the receiver's account | Receiver's PSP |
| `AG03` | Transaction type not supported on the account (e.g. salary account) | Receiver's PSP |
| `AM02` | Amount exceeds the limit allowed for the credited account type | Receiver's PSP |
| `BE01` | Receiver's CPF/CNPJ does not match the account holder | Receiver's PSP |
| `BE17` | QR code rejected by the receiver's PSP | Receiver's PSP |
| `DS04` | Order rejected by the receiver's PSP | Receiver's PSP |
| `FRAD` | Rejected for well-founded suspicion of fraud | Receiver's PSP |
| `RR04` | Regulatory reason (payer sanctioned by UN Security Council resolution) | Receiver's PSP |
| `AM09` | Return would exceed the amount of the original payment | Receiver's PSP of the return |
| `AG13` | A return cannot itself be returned | SPI |
| `AB03` | Settlement aborted due to timeout in the SPI | SPI |
| `DS27` | Participant not registered or not yet operating in the SPI | SPI |
| `RC09` | Payer's PSP ISPB invalid or missing | SPI |
| `ED05` | Generic processing error | SPI / receiver's PSP |

`MD06` and `FOCR` are **not** pacs.002 codes; `MD06` is a pacs.004 return reason.

### The 40-Second Limit (AB03)

This is one of the most critical constraints in the Pix protocol (Manual de Tempos do Pix):

**A Pix on the primary channel must be settled within 40 seconds, counted from `AccptncDtTm` (t0', when the payer's PSP accepted the order) until settlement (t4).** For payments under fraud analysis the count starts at t1' (SPI receipt); scheduled Pix on the secondary channel have 45 minutes.

If the cycle does not complete in time, the SPI rejects the transaction with `AB03` (settlement aborted due to timeout in the SPI) and sends it to both PSPs. A `pacs.002` that arrives after that is useless.

The 40 seconds are shared by everyone in the chain, and the receiving PSP is measured separately. Its time to answer (t3' − t2, from the SPI making the pacs.008 available to the SPI receiving your pacs.002) has service levels of **1.4 s at p50 and 2.3 s at p95**. The payer's PSP has 0.9 s p50 / 1.5 s p95 between accepting the order and the SPI receiving the pacs.008 (t1 − t0').

This means your entire receive pipeline (stream read, parsing, account validation, response generation, sending) must be fast. In practice, aim for well under a second.

Timing is a common source of failures during homologation and in production. Design your architecture with it as a first-class concern.

## pacs.004 - PaymentReturn (Devolution)

The `pacs.004` returns (devolves) a previously settled payment. It is sent by the PSP of the original receiver to the SPI. This is distinct from rejecting a payment (which happens before settlement via `pacs.002` RJCT).

### When Devolutions Occur

The return reason (`RtrRsnInf/Rsn/Cd`) accepts only four codes (`ExternalReturnReason1Code` in the XSD):

| Code | Meaning | Use Case |
|------|---------|----------|
| `BE08` | Bank error | Return by the receiver's PSP under the MED for an operational failure of the payer's PSP, or of its own systems |
| `FR01` | Fraud | Return by the receiver's PSP under the MED (Mecanismo Especial de Devolução) for well-founded suspicion of fraud |
| `MD06` | Refund requested by end customer | Return requested by the receiving user |
| `SL02` | Specific service offered by creditor agent | Return related to Pix Saque or Pix Troco |

`FOCR` and `FRAD` are **not** valid pacs.004 return reasons.

### D-Prefixed Return Ids

The return has its own identifier, `RtrId`, with the same layout as an EndToEndId but a `D` prefix:

**Format**: `D{ISPB of who returns}{yyyyMMddHHmm UTC}{11 alphanumeric}` = **32 characters total**

`OrgnlEndToEndId` keeps the original `E` id unchanged. The toolkit generates `RtrId` with `generateDevolutionEndToEndId`.

### pacs.004 Structure

Following Bacen's official example (`simulator/spec/spi-5.13.1/exemplos/pacs.004_SPI_1_msg.xml`):

```xml
<Envelope xmlns="https://www.bcb.gov.br/pi/pacs.004/1.5">
  <AppHdr>
    <!-- Fr = your ISPB, To = 00038166, MsgDefIdr = pacs.004.spi.1.5 -->
  </AppHdr>
  <Document>
    <PmtRtr>
      <GrpHdr>
        <MsgId>{MESSAGE_ID}</MsgId>
        <CreDtTm>{UTC_TIMESTAMP}</CreDtTm>
        <NbOfTxs>1</NbOfTxs>
        <SttlmInf>
          <SttlmMtd>CLRG</SttlmMtd>
        </SttlmInf>
      </GrpHdr>
      <TxInf>
        <RtrId>{RETURN_ID}</RtrId>
        <OrgnlEndToEndId>{ORIGINAL_E2E_ID}</OrgnlEndToEndId>
        <RtrdIntrBkSttlmAmt Ccy="BRL">{RETURN_AMOUNT}</RtrdIntrBkSttlmAmt>
        <SttlmPrty>HIGH</SttlmPrty>
        <ChrgBr>SLEV</ChrgBr>
        <RtrRsnInf>
          <Rsn>
            <Cd>{RETURN_REASON_CODE}</Cd>
          </Rsn>
        </RtrRsnInf>
        <OrgnlTxRef>
          <DbtrAgt>
            <FinInstnId>
              <ClrSysMmbId>
                <MmbId>{ORIGINAL_PAYER_PSP_ISPB}</MmbId>
              </ClrSysMmbId>
            </FinInstnId>
          </DbtrAgt>
          <CdtrAgt>
            <FinInstnId>
              <ClrSysMmbId>
                <MmbId>{ORIGINAL_RECEIVER_PSP_ISPB}</MmbId>
              </ClrSysMmbId>
            </FinInstnId>
          </CdtrAgt>
        </OrgnlTxRef>
      </TxInf>
    </PmtRtr>
  </Document>
</Envelope>
```

`OrgnlTxRef` keeps the agents of the **original** transaction: `DbtrAgt` is the original payer's PSP and `CdtrAgt` is the original receiver's PSP (you, when you return).

```typescript
import { generatePacs004 } from "../scripts/spi/pacs004-generator.js";

const xml = generatePacs004({
  senderIspb: "12345678",          // original receiver's PSP (you)
  originalPayerIspb: "99999A03",   // original payer's PSP
  originalEndToEndId: e2eId,
  amount: 10.5,
  returnReasonCode: "MD06",
});
```

### Devolution Rules

- A payment can be partially or fully returned
- Multiple partial returns are allowed, but their sum cannot exceed the original amount (the SPI/receiver rejects with `AM09`)
- A return cannot itself be returned (`AG13`)
- Returns reference the original transaction by `OrgnlEndToEndId` and the original agents in `OrgnlTxRef`
- There are time limits for devolutions, which depend on the reason (see the Regulamento Pix; MED returns follow the DICT refund flow)

## Homologation Tests (Roteiro, item 2)

The Roteiro para Participação Direta no SPI lists the payment and return tests you must pass:

| Item | Test |
|------|------|
| 2a | Send a pacs.008 on the **primary** channel and receive the SPI pacs.002 confirming settlement |
| 2b | Receive a pacs.008 on the primary channel and accept it with a pacs.002 |
| 2c | Send a pacs.008 on the **secondary** channel and receive the SPI pacs.002 confirming settlement |
| 2d | Receive a pacs.008 on the secondary channel and accept it with a pacs.002 |
| 2e | Receive a pacs.008 on the primary channel and **reject** it with a pacs.002 and reason code, before the SPI times the transaction out |
| 2f | Send a pacs.004 and receive the SPI pacs.002 confirming settlement |
| 2g | Receive a pacs.004 and accept it with a pacs.002 |
| 2h | Receive a pacs.004 and reject it with a pacs.002 and reason code, before the SPI timeout |
| 2i–2k | camt.060 balance/entry queries answered with camt.053 (current and previous-day balance) and camt.054 (entry details) |

Item 1 (connectivity) is the pibr.001/pibr.002 echo, and item 3 is the camt.060 → camt.052 statement request plus the file download (see [02 - Basic Connectivity](./02-basic-connectivity.md)).

## Testing with Bacen Virtual Participants

Bacen provides virtual participants in the homologation environment. The Roteiro names two:

| ISPB | Name | Behavior |
|------|------|----------|
| `99999A04` | Cooperativa de Crédito Virtual | Answers **any** pacs.008 with a pacs.002 `ACSP`, regardless of customer and account data. Use it as the creditor when you test as payer. |
| `99999A03` | Banco Virtual | The payer in the tests where you receive. Payer: account type `CACC`, branch `1`, account `1`, CPF `11111111111`, name `Fulano`. Receiver (your customer): `CACC`, branch `1`, account `1`, CPF `11111111111`. |

Note that ISPBs are `[0-9A-Z]{8}`, so your ISPB validation must accept letters. Other virtual ISPBs that circulate in the community (for example for DICT tests) are not in the official documents; confirm them with Bacen before relying on them.

### As Sender (You Send pacs.008 to 99999A04)

When you send a `pacs.008` with `CdtrAgt` = `99999A04` (the `AppHdr/To` is still `00038166`):

1. The SPI makes the order available to the virtual participant
2. The virtual participant answers `ACSP`
3. The SPI settles and sends you its `pacs.002` (`ACSC`), or a `pacs.002` `RJCT` if the SPI itself rejected the message (e.g. `AB03`, `RC09`)

ICOM does not validate syntax or signature when you POST (it answers 201 and stores the message); schema and signature errors come back asynchronously as an `admi.002` that references the `PI-ResourceId`. This allows you to test your sending pipeline without needing a partner.

### As Receiver (99999A03 Sends pacs.008 to You)

Bacen (Deban/Gemon) sends `pacs.008` messages with `99999A03` as payer to your ISPB. You must:

1. Read the incoming `pacs.008` from your ICOM stream (`GET /api/v1/out/{ispb}/stream/start`, then `PI-Pull-Next`)
2. Parse and validate the message
3. Send a `pacs.002` (ACSP or RJCT) with `POST /api/v1/in/{ispb}/msgs`
4. Answer well within the 40-second settlement limit (receiver SLA: 1.4 s p50, 2.3 s p95)

This is how Bacen tests your receiving pipeline.

```typescript
import { IcomClient } from "../scripts/utils/http-client.js";

const icom = new IcomClient({ baseUrl: "https://icom-h.pi.rsfn.net.br:16522", ispb, certPath, keyPath, caPath });
const received = await icom.readUntil((m) => m.xml.includes("https://www.bcb.gov.br/pi/pacs.008/"), 60_000);
// ...validate, then answer each one:
await icom.sendMessages(generatePacs002({ senderIspb: ispb, originalEndToEndId, status: "ACSP" }));
```

### Test Scenarios

Follow the Roteiro items above exactly, keep evidence (message dumps, logs) and do not improvise test data. The Roteiro requires keeping the complete test documentation for 5 years.

## Testing with Partner PSP (Bilateral)

Bilateral testing validates end-to-end behavior between two real institutions. The Roteiro does not require it (the official tests run against Bacen and its virtual participants), but in practice it is a useful rehearsal before go-live.

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
- Test with different local instruments (MANU, DICT, QRDN, QRES, and INIC/AUTO/APDN/APES if you offer them)

## Common Errors and Solutions

### XML Schema Validation Failures

**Symptom**: an `admi.002` from the SPI referencing your message's `PI-ResourceId` (ICOM accepts the POST with 201 and validates later), or an error such as "Schema desconhecido ou não habilitado para uso".

**Solution**: Validate your XML against the official XSD schemas before sending (copies in `simulator/spec/spi-5.13.1/xsd`; `npm run test:simulator` validates the toolkit's generated messages against them). Common issues:
- Wrong namespace or `MsgDefIdr` for the message version, or a version not enabled in `GET /api/v1/in/catalog`
- Date-times without milliseconds or not in UTC (`Z`)
- Missing required fields
- Incorrect field ordering (XML element order matters in XSD validation)
- Invalid characters in text fields

### EndToEndId Collisions

**Symptom**: Rejection due to duplicate E2E ID.

**Solution**: Ensure the 11-character suffix is unique within each `yyyyMMddHHmm` (for example a random or sequence-based suffix). Never reuse E2E IDs, even in the homologation environment. Remember the timestamp is UTC.

### Timeout Failures (AB03)

**Symptom**: The SPI rejects transactions with `AB03` because settlement did not complete within 40 seconds of `AccptncDtTm`, or your answer time (t3' − t2) is above the 1.4 s p50 / 2.3 s p95 service levels.

**Solution**:
- Profile your receive pipeline to identify bottlenecks
- Keep read streams permanently open (`/api/v1/out/{ispb}/stream/start` + `PI-Pull-Next`, up to 6 per participant and channel) and use `Accept: multipart/mixed` to get up to 10 messages per read
- Process messages asynchronously (do not block the read loop), but always finish each stream with `DELETE` on the last `PI-Pull-Next`
- Reduce database query time for account validation
- As payer, set `AccptncDtTm` to the real acceptance time and send the pacs.008 promptly; the clock starts there

### Incorrect Amount Formatting

**Symptom**: Amount-related rejections.

**Solution**: Amounts are in BRL (`Ccy="BRL"`), with at most 2 decimal places (XSD `fractionDigits` 2), no thousands separators, and a period as decimal separator. The toolkit always emits two decimals (`10.50`).

### BAH Routing Errors

**Symptom**: Message not delivered or rejected by Bacen before reaching the recipient.

**Solution**: `AppHdr/Fr` must be your ISPB (matching your certificate and the `{ispb}` in the URL) and `AppHdr/To` must be the SPI, `00038166`. The counterparty PSP goes only in `DbtrAgt`/`CdtrAgt` inside the Document.

---

**Sources:** [Catálogo de Mensagens e Serviços do SPI 5.13.1](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip) (XSDs, examples and rules; copies in `simulator/spec/spi-5.13.1`), [Manual das Interfaces de Comunicação 1.12](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf), [Manual de Tempos do Pix 7.0](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf), [Roteiro para Participação Direta no SPI](https://www.bcb.gov.br/content/estabilidadefinanceira/sistemapagamentosinstantaneos_docs/Roteiro_para_Participacao_Direta_no_SPI_e_abertura_de_Conta_PI.pdf).

---

**Previous:** [02 - Basic Connectivity](./02-basic-connectivity.md) | **Next:** [04 - SPI Capacity](./04-spi-capacity.md)
