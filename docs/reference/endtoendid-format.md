# EndToEndId Format Reference

The EndToEndId (End-to-End Identification, also abbreviated E2E ID, `idFimAFim` in the catalog) is a 32-character identifier that uniquely tracks a Pix transaction from origination through settlement. It is set in pacs.008 (`PmtId/EndToEndId`) and referenced in pacs.002 (`OrgnlEndToEndId`) and pacs.004 (`OrgnlEndToEndId`). Returns have their own identifier with the same layout, the `RtrId` (`idOperacao`), prefixed with `D`.

---

## Format Specification

### Origination (Pix Payment)

```
E{ISPB}{yyyyMMdd}{HHmm}{SUFFIX}
```

| Segment | Length | Description |
|---------|--------|-------------|
| Prefix | 1 | Always `E` for payments |
| ISPB | 8 | Identifier of the agent that generated the id, `[0-9A-Z]{8}`: the ISPB of the direct participant, the ISPB of the indirect participant, or the first 8 digits of the payment initiator's CNPJ |
| Date | 8 | Date in `yyyyMMdd` format, **UTC** |
| Time | 4 | Time in `HHmm` format (24-hour), **UTC** |
| Suffix | 11 | Alphanumeric `[a-zA-Z0-9]`, unique within each `yyyyMMddHHmm` |
| **Total** | **32** | Case sensitive |

**Example** (a payment created at 14:35 UTC on 2026-09-28, i.e. 11:35 in Brasília):
```
E12345678202609281435abcDEF12345
|--------|--------|----|---------|
 ISPB      Date   Time  Suffix
```

### Return (pacs.004 RtrId)

```
D{ISPB}{yyyyMMdd}{HHmm}{SUFFIX}
```

| Segment | Length | Description |
|---------|--------|-------------|
| Prefix | 1 | Always `D` for returns |
| ISPB | 8 | ISPB of the PSP sending the return, `[0-9A-Z]{8}` |
| Date | 8 | Date in `yyyyMMdd` format, **UTC** |
| Time | 4 | Time in `HHmm` format (24-hour), **UTC** |
| Suffix | 11 | Alphanumeric `[a-zA-Z0-9]` |
| **Total** | **32** | |

**Example:**
```
D12345678202609281500abcDEF12345
```

The `RtrId` is a separate field. The pacs.004 keeps the original payment id, with its `E` prefix, in `OrgnlEndToEndId`.

---

## Character Restrictions

| Position | Allowed Characters |
|----------|--------------------|
| Prefix (position 1) | `E` (payment) or `D` (return) |
| ISPB (positions 2-9) | `0-9` and uppercase `A-Z` (e.g. Bacen's virtual participants `99999A03` and `99999A04` in homologation) |
| Date (positions 10-17) | Digits `0-9`, valid date |
| Time (positions 18-21) | Digits `0-9`, valid time (00-23 for hours, 00-59 for minutes) |
| Suffix (positions 22-32) | Alphanumeric: `A-Z`, `a-z`, `0-9` |

**Not allowed in the suffix:**
- Special characters (`-`, `_`, `.`, `/`, etc.)
- Whitespace
- Unicode or accented characters

---

## Uniqueness and Time Requirements

1. **Uniqueness:** An EndToEndId must be unique and cannot be repeated in any other operation sent to the SPI. The 11-character suffix must be unique within each `yyyyMMddHHmm` of the generating agent.

2. **ISPB Binding:** The ISPB segment identifies whoever generated the id (direct participant, indirect participant or payment initiator). Do not use the counterparty's ISPB.

3. **UTC timestamp:** The date and time segments are in UTC, not Brasília time. They are the time the payment order is submitted (priority payments) or the planned time of sending to the SPI (scheduled payments). A pacs.008 generated from a pain.013 (Pix Automático) reuses the pain.013 EndToEndId. The SPI accepts a tolerance of **12 hours** to the past or future relative to its processing time; ids outside that window are rejected.

4. **Suffix Entropy:** With 62 possible characters per position (a-z, A-Z, 0-9), the suffix space is 62^11 (approximately 5.2 x 10^19) per minute, which is enough when generated randomly with a CSPRNG.

5. **No Reuse (practical rule):** Never reuse an EndToEndId for a new payment. A resend of the *same* message (for example after a 5xx from ICOM) keeps the same ids, since the SPI applies idempotency over a 24-hour window; a *new* attempt after a rejection is a new payment and needs a new EndToEndId.

---

## Generation Algorithm

### Pseudocode

```
function generateEndToEndId(ispb, isReturn = false):
    prefix = isReturn ? "D" : "E"
    stamp  = formatUtc(now(), "yyyyMMddHHmm")   // UTC
    suffix = randomAlphanumeric(11)

    id = prefix + ispb + stamp + suffix
    assert length(id) == 32
    return id
```

### Toolkit (TypeScript)

`scripts/utils/endtoendid-generator.ts` implements this:

```ts
import {
  generateEndToEndId,
  generateDevolutionEndToEndId,
  parseEndToEndId,
  END_TO_END_ID_PATTERN,
} from "./scripts/utils/endtoendid-generator.js";

const e2eId = generateEndToEndId("12345678");            // E12345678 + UTC yyyyMMddHHmm + 11
const rtrId = generateDevolutionEndToEndId("12345678");  // D... for a pacs.004 RtrId
parseEndToEndId(e2eId); // { prefix, ispb, date, time, random }
```

From the command line: `npm run generate:e2eid -- 12345678 5`.

### Plain Node.js Implementation

```js
const crypto = require('crypto');

function generateEndToEndId(ispb, isReturn = false) {
  if (!/^[0-9A-Z]{8}$/.test(ispb)) throw new Error(`Invalid ISPB: ${ispb}`);
  const prefix = isReturn ? 'D' : 'E';

  // UTC, not Brasília time
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    now.getUTCFullYear() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes());

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  const bytes = crypto.randomBytes(11);
  for (let i = 0; i < 11; i++) {
    suffix += chars[bytes[i] % chars.length];
  }

  const id = `${prefix}${ispb}${stamp}${suffix}`;
  if (id.length !== 32) {
    throw new Error(`EndToEndId must be 32 chars, got ${id.length}: ${id}`);
  }
  return id;
}
```

---

## Validation

### Regex Patterns

These match the XSD patterns of the SPI catalog (`EndToEndIdType` in pacs.008 and the return id in pacs.004).

**Payment (EndToEndId):**
```regex
^E[0-9A-Z]{8}[0-9]{4}[0-1][0-9][0-3][0-9][0-2][0-9][0-5][0-9][a-zA-Z0-9]{11}$
```

**Return (RtrId):**
```regex
^D[0-9A-Z]{8}[0-9]{4}[0-1][0-9][0-3][0-9][0-2][0-9][0-5][0-9][a-zA-Z0-9]{11}$
```

**Either:**
```regex
^[ED][0-9A-Z]{8}[0-9]{4}[0-1][0-9][0-3][0-9][0-2][0-9][0-5][0-9][a-zA-Z0-9]{11}$
```

### Validation Checks

1. Total length is exactly 32 characters.
2. First character is `E` or `D`.
3. Characters 2-9 match `[0-9A-Z]{8}` and identify the generating agent.
4. Characters 10-17 form a valid date (`yyyyMMdd`, UTC).
5. Characters 18-21 form a valid time (`HHmm`, UTC).
6. The timestamp is within 12 hours of the current time.
7. Characters 22-32 are alphanumeric (A-Z, a-z, 0-9).

---

## Usage in Messages

### pacs.008 (Payment)

```xml
<PmtId>
  <EndToEndId>E12345678202609281435abcDEF12345</EndToEndId>
</PmtId>
```

`TxId` is a different field (the receiver's reconciliation id from a QR code or payment initiation) and is only present for some local instruments. See [ISO Message Reference](iso-messages.md#pacs008----fitoficustomercredittransfer).

### pacs.002 (Status Report)

The original id is referenced in both `OrgnlInstrId` and `OrgnlEndToEndId`:

```xml
<TxInfAndSts>
  <OrgnlInstrId>E12345678202609281435abcDEF12345</OrgnlInstrId>
  <OrgnlEndToEndId>E12345678202609281435abcDEF12345</OrgnlEndToEndId>
  <TxSts>ACSP</TxSts>
</TxInfAndSts>
```

For a pacs.002 about a return, `OrgnlInstrId` carries the `RtrId` (`D...`) of the pacs.004.

### pacs.004 (Return)

```xml
<TxInf>
  <RtrId>D12345678202609281500abcDEF12345</RtrId>
  <OrgnlEndToEndId>E99999A03202609281435abcDEF12345</OrgnlEndToEndId>
</TxInf>
```

---

## Common Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Wrong length (not 32 chars) | Schema validation failure (admi.002) | Verify length after generation |
| Using counterpart's ISPB instead of your own | Rejection | Use the ISPB of whoever generated the id |
| Special characters in the suffix | Schema validation failure | Use only `[A-Za-z0-9]` |
| Validating the ISPB as 8 digits (`\d{8}`) | Valid ids from ISPBs with letters (e.g. `99999A04`) are refused by your own code | Use `[0-9A-Z]{8}` |
| Reusing an EndToEndId for a new payment | Duplicate detection, rejection | Generate a fresh id for every new transaction |
| Using the `E` id as `RtrId`, or putting the `D` id in `OrgnlEndToEndId` | Schema or business rejection | `RtrId` = new `D` id; `OrgnlEndToEndId` = original `E` id |
| Date/time in Brasília time (UTC-3) instead of UTC | Ids 3 hours off and not compliant with the catalog rule | Always use UTC |

---

## Sources

- Catálogo de Mensagens e Serviços do SPI 5.13 (pacs.008 `EndToEndId` and pacs.004 `RtrId` rules and XSD patterns): https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip (local copy in `simulator/spec/spi-5.13.1/`)
