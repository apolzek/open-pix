# EndToEndId Format Reference

The EndToEndId (End-to-End Identification, also abbreviated E2E ID) is a 32-character identifier that uniquely tracks a Pix transaction from origination through settlement. It is present in pacs.008 (payment), pacs.002 (status report), and pacs.004 (return) messages.

---

## Format Specification

### Origination (Pix Payment)

```
E{ISPB}{YYYYMMDD}{HHMM}{RANDOM}
```

| Segment | Length | Description |
|---------|--------|-------------|
| Prefix | 1 | Always `E` for originations |
| ISPB | 8 | 8-digit ISPB of the originating PSP |
| Date | 8 | Date in `YYYYMMDD` format |
| Time | 4 | Time in `HHMM` format (24-hour, BRT timezone) |
| Random | 11 | Random alphanumeric characters |
| **Total** | **32** | |

**Example:**
```
E12345678202502151030a1B2c3D4e5F
|--------|--------|----|---------|
 ISPB      Date   Time  Random
```

### Devolution (Pix Return)

```
D{ISPB}{YYYYMMDD}{HHMM}{RANDOM}
```

| Segment | Length | Description |
|---------|--------|-------------|
| Prefix | 1 | Always `D` for devolutions (returns) |
| ISPB | 8 | 8-digit ISPB of the PSP initiating the return |
| Date | 8 | Date in `YYYYMMDD` format |
| Time | 4 | Time in `HHMM` format (24-hour, BRT timezone) |
| Random | 11 | Random alphanumeric characters |
| **Total** | **32** | |

**Example:**
```
D12345678202502151045xYz7890AbCdE
```

---

## Character Restrictions

| Position | Allowed Characters |
|----------|--------------------|
| Prefix (position 1) | `E` (origination) or `D` (devolution) |
| ISPB (positions 2-9) | Digits `0-9` only |
| Date (positions 10-17) | Digits `0-9` only, valid date |
| Time (positions 18-21) | Digits `0-9` only, valid time (00-23 for hours, 00-59 for minutes) |
| Random (positions 22-32) | Alphanumeric: `A-Z`, `a-z`, `0-9` |

**Not allowed in the random segment:**
- Special characters (`-`, `_`, `.`, `/`, etc.)
- Whitespace
- Unicode or accented characters

---

## Uniqueness Requirements

1. **Global Uniqueness:** Each EndToEndId must be globally unique across the entire SPI. No two transactions (from any PSP) should share the same EndToEndId.

2. **ISPB Binding:** The ISPB segment must match the originating institution's ISPB. Bacen validates this -- you cannot use another institution's ISPB.

3. **Date/Time Accuracy:** The date and time segments should reflect the actual creation time of the transaction. While Bacen does not enforce strict time matching, significant discrepancies may trigger validation warnings.

4. **Random Segment Entropy:** The 11-character random segment provides the uniqueness guarantee. With 62 possible characters per position (a-z, A-Z, 0-9), the random space is 62^11 (approximately 5.2 x 10^19), which is sufficient for collision avoidance.

5. **No Reuse:** An EndToEndId must never be reused, even for retries. If a transaction fails and needs to be retried, generate a new EndToEndId.

---

## Generation Algorithm

### Pseudocode

```
function generateEndToEndId(ispb, isDevolution = false):
    prefix = isDevolution ? "D" : "E"
    date = formatDate(now(), "YYYYMMDD")    // BRT timezone
    time = formatDate(now(), "HHMM")        // BRT timezone
    random = generateAlphanumeric(11)

    endToEndId = prefix + ispb + date + time + random

    assert length(endToEndId) == 32
    return endToEndId
```

### Node.js Implementation

```js
const crypto = require('crypto');

function generateEndToEndId(ispb, isDevolution = false) {
  const prefix = isDevolution ? 'D' : 'E';

  // Use BRT (UTC-3) timezone
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

  const year = brt.getUTCFullYear().toString();
  const month = (brt.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = brt.getUTCDate().toString().padStart(2, '0');
  const hours = brt.getUTCHours().toString().padStart(2, '0');
  const minutes = brt.getUTCMinutes().toString().padStart(2, '0');

  const date = `${year}${month}${day}`;
  const time = `${hours}${minutes}`;

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let random = '';
  const bytes = crypto.randomBytes(11);
  for (let i = 0; i < 11; i++) {
    random += chars[bytes[i] % chars.length];
  }

  const endToEndId = `${prefix}${ispb}${date}${time}${random}`;

  if (endToEndId.length !== 32) {
    throw new Error(
      `EndToEndId must be 32 chars, got ${endToEndId.length}: ${endToEndId}`
    );
  }

  return endToEndId;
}
```

---

## Validation

### Regex Patterns

**Origination:**
```regex
^E\d{8}\d{8}\d{4}[A-Za-z0-9]{11}$
```

**Devolution:**
```regex
^D\d{8}\d{8}\d{4}[A-Za-z0-9]{11}$
```

**Either (origination or devolution):**
```regex
^[ED]\d{8}\d{8}\d{4}[A-Za-z0-9]{11}$
```

### Validation Checks

1. Total length is exactly 32 characters.
2. First character is `E` or `D`.
3. Characters 2-9 are digits and match a valid ISPB.
4. Characters 10-17 are digits forming a valid date (YYYYMMDD).
5. Characters 18-21 are digits forming a valid time (HHMM, 00-23 hours, 00-59 minutes).
6. Characters 22-32 are alphanumeric (A-Z, a-z, 0-9).

---

## Usage in Messages

### pacs.008 (Payment)

The EndToEndId is set in the payment identification block:

```xml
<PmtId>
  <EndToEndId>E12345678202502151030a1B2c3D4e5F</EndToEndId>
  <TxId>TXN-2025-001</TxId>
</PmtId>
```

### pacs.002 (Status Report)

The original EndToEndId is referenced to link the status report to the payment:

```xml
<TxInfAndSts>
  <OrgnlEndToEndId>E12345678202502151030a1B2c3D4e5F</OrgnlEndToEndId>
  <TxSts>ACSP</TxSts>
</TxInfAndSts>
```

### pacs.004 (Return)

The return references the original EndToEndId and uses a devolution ID:

```xml
<TxInf>
  <RtrId>D12345678202502151045xYz7890AbCdE</RtrId>
  <OrgnlEndToEndId>E12345678202502151030a1B2c3D4e5F</OrgnlEndToEndId>
</TxInf>
```

---

## Common Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Wrong length (not 32 chars) | Schema validation failure | Verify length after generation |
| Using counterpart's ISPB instead of own | Bacen rejects the message | Always use your institution's ISPB |
| Special characters in random segment | Schema validation failure | Use only `[A-Za-z0-9]` |
| Reusing an EndToEndId | Duplicate detection, message rejected | Generate a fresh ID for every transaction |
| Wrong prefix for devolution | Message type mismatch | Use `D` for pacs.004, `E` for pacs.008 |
| Date/time in UTC instead of BRT | Minor discrepancy, may trigger warnings | Always use BRT (UTC-3) |
