# 07 - Advanced Features Homologation

## Overview

Beyond SPI and DICT core testing, Bacen requires homologation of several advanced features. The most immediately relevant is QR Code support, which is part of the standard homologation process. Other features such as Pix Automatico (recurring payments) and MED 2.0 (enhanced fraud detection) are newer capabilities that may be required depending on your timeline.

---

## QR Code Testing

QR Code support is a critical component of the Pix ecosystem. As a Direct Participant, you must be able to generate and decode Pix QR codes. Bacen provides a validation tool called **Pix Tester** that checks your QR code implementations.

### QR Code Types

| Type | Name | Description | Reusable? |
|------|------|-------------|-----------|
| Static | QR Code Estatico | Fixed payment info, no amount required | Yes |
| COB | Cobranca | Dynamic QR with unique URL and amount | No (single use) |
| COBV | Cobranca com Vencimento | Dynamic QR with due date, discounts, penalties | No (single use) |

### Static QR Code

A static QR code contains payment information directly encoded in the EMV TLV payload. It can be reused for multiple payments.

**Characteristics:**
- Contains the Pix key directly in the payload
- Amount may or may not be specified
- No expiration
- No unique transaction identifier
- Simplest to implement

**EMV Payload Structure (Static):**

```
00 02 "01"                          // Payload Format Indicator
01 02 "12"                          // Point of Initiation: "12" = static
26 XX                               // Merchant Account Information (Pix)
   00 14 "br.gov.bcb.pix"           // GUI
   01 XX "{pix_key}"                // Pix Key
52 04 "0000"                        // Merchant Category Code
53 03 "986"                         // Transaction Currency (BRL)
54 XX "{amount}"                    // Transaction Amount (optional)
58 02 "BR"                          // Country Code
59 XX "{merchant_name}"             // Merchant Name
60 XX "{merchant_city}"             // Merchant City
62 XX                               // Additional Data Field
   05 XX "{txid}"                   // Reference Label
63 04 "{CRC}"                       // CRC16 Checksum
```

### COB (Cobranca) - Dynamic QR Code

A COB creates a unique charge with a specific amount and optional expiration. The QR code contains a URL that the paying PSP fetches to get the current charge details.

**Characteristics:**
- Each charge has a unique `txid`
- Contains a URL (Location) instead of direct payment data
- Amount is specified and fixed
- Has an expiration time
- Single-use

**API Endpoints:**

```
PUT /api/v2/cob/{txid}    // Create a COB
GET /api/v2/cob/{txid}    // Retrieve a COB
PATCH /api/v2/cob/{txid}  // Update a COB
```

**EMV Payload Structure (Dynamic/COB):**

```
00 02 "01"                          // Payload Format Indicator
01 02 "12"                          // Point of Initiation: "12" = dynamic
26 XX                               // Merchant Account Information (Pix)
   00 14 "br.gov.bcb.pix"           // GUI
   25 XX "{location_url}"           // URL for charge details
52 04 "0000"                        // Merchant Category Code
53 03 "986"                         // Transaction Currency (BRL)
54 XX "{amount}"                    // Transaction Amount
58 02 "BR"                          // Country Code
59 XX "{merchant_name}"             // Merchant Name
60 XX "{merchant_city}"             // Merchant City
62 XX                               // Additional Data Field
   05 XX "***"                      // Reference Label (dynamic uses ***)
63 04 "{CRC}"                       // CRC16 Checksum
```

### COBV (Cobranca com Vencimento) - Dynamic QR with Due Date

A COBV extends COB with due date semantics, including support for discounts, penalties, interest, and rebates.

**Characteristics:**
- Has a due date (`dataVencimento`)
- Supports discounts for early payment
- Supports penalties and interest for late payment
- Supports rebates (abatimento)
- Requires municipal code (`codMun`) for holiday handling
- More complex to implement than COB

**API Endpoints:**

```
PUT /api/v2/cobv/{txid}    // Create a COBV
GET /api/v2/cobv/{txid}    // Retrieve a COBV
PATCH /api/v2/cobv/{txid}  // Update a COBV
```

**Due Date Considerations:**
- Calculate effective due date considering business days
- Handle national and municipal holidays
- Municipal holiday handling requires the `codMun` field (IBGE municipal code)
- Holiday lists can be sourced from the same data used by the boleto (bank slip) system

> "a gente optou por seguir as mesmas regras disponibilizadas pela instituicao de controla os boletos. Tem um arquivo com feriados que e respeitado"
> -- Swap team on holiday handling

### EMV TLV Format

All Pix QR codes use the EMV (Europay, Mastercard, Visa) Tag-Length-Value encoding format:

```
Tag (2 bytes) | Length (2 bytes) | Value (variable)
```

**Encoding rules:**
- Tags are 2-digit numeric strings (e.g., "00", "01", "26")
- Length is a 2-digit numeric string representing the byte length of the value
- Values are ASCII strings
- Nested TLV structures are used within certain tags (e.g., tag 26 for Merchant Account Info)
- Tags must appear in ascending numeric order

**Example encoding:**

```
// Tag 00, Length 02, Value "01"
"000201"

// Tag 26, Length 38 (containing nested TLV)
// Nested: Tag 00, Length 14, Value "br.gov.bcb.pix"
//         Tag 01, Length 14, Value "test@email.com"
"2638" + "0014br.gov.bcb.pix" + "0114test@email.com"
```

### CRC-16/CCITT-FALSE Checksum

Every Pix QR code payload ends with a CRC-16 checksum (tag 63, length 04).

**Algorithm:** CRC-16/CCITT-FALSE
- Polynomial: 0x1021
- Initial value: 0xFFFF
- Input reflected: No
- Output reflected: No
- Final XOR: 0x0000

**Implementation:**

```javascript
function crc16ccittFalse(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data.charCodeAt(i) << 8);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Calculate CRC: include "6304" in the input (tag + length, but not the CRC value)
const payload = "000201...6304";
const crc = crc16ccittFalse(payload);
const finalPayload = payload + crc;
```

**Common CRC mistake:** Forgetting to include the tag and length of the CRC field itself ("6304") in the CRC calculation input. The CRC is calculated over the entire payload including the "6304" prefix, but not the CRC value itself.

### Pix Tester

Bacen provides a validation tool called **Pix Tester** that verifies your QR code implementations. You should pass all Pix Tester validations before scheduling formal homologation.

**What Pix Tester checks:**
- EMV payload structure correctness
- Tag ordering
- Length field accuracy
- CRC-16 checksum validity
- Required fields presence
- Pix key format validation
- URL format for dynamic QR codes

Some Pix Tester tests include Open Finance scenarios. Only tests marked with an asterisk (*) are mandatory. Open Finance tests may not apply to all participants.

### Common QR Code Issues

**Pix Saque / Pix Troco errors:**
If you attempt to pay a QR code with Pix Saque (cash withdrawal) or Pix Troco (cash back) and you are not authorized as a facilitator, you will receive:

> "Participante facilitador de servico Pix Saque ou Pix Troco nao autorizado"

This is expected if you have not been authorized for these services. Skip these test scenarios unless they apply to your use case.

**QR Code with amount vs. without:**
- Static QR codes may or may not include an amount
- If no amount is specified, the payer enters the amount
- Dynamic QR codes (COB/COBV) always have an amount

**URL encoding in dynamic QR codes:**
- The Location URL must be properly encoded in the EMV payload
- Special characters in URLs may cause parsing issues
- Test with various URL lengths

---

## Pix Automatico (Recurring Payments)

Pix Automatico enables scheduled recurring payments, similar to direct debit but using Pix rails. This feature is newer and may not be required for initial homologation depending on your timeline.

### Setup and Authorization Flow

1. **Merchant requests recurring payment setup** through the PSP
2. **Payer's PSP** presents the authorization request to the payer
3. **Payer authorizes** the recurring payment (amount, frequency, duration)
4. **Authorization is registered** in the Pix system
5. **Scheduled payments** are executed automatically per the agreed schedule

### Key Concepts

- **Mandate:** The authorization agreement between payer and merchant
- **Frequency:** Daily, weekly, monthly, yearly
- **Amount:** Can be fixed or variable (up to a maximum)
- **Duration:** Start date, end date, or indefinite
- **Cancellation:** Payer can cancel at any time through their PSP

### Scheduling and Execution

- Payments are initiated by the merchant's PSP at the scheduled time
- The payer's PSP validates the payment against the mandate
- If the payer has insufficient funds, the payment fails
- Failed payments may be retried according to the mandate terms
- Payer receives notifications for each scheduled payment

### Implementation Considerations

- Store mandates securely with proper versioning
- Implement a scheduler for recurring payment execution
- Handle timezone correctly (Brazil has multiple timezones)
- Implement proper cancellation and modification flows
- Consider notification mechanisms for payers

---

## MED 2.0 (Enhanced Fraud Detection)

MED 2.0 is an evolution of the Mecanismo Especial de Devolucao, introducing faster fraud response times and enhanced fraud markers.

### Key Improvements Over MED 1.0

| Aspect | MED 1.0 | MED 2.0 |
|--------|---------|---------|
| Resolution time | 7 days | Shorter (near real-time for some flows) |
| Fraud markers | Basic | Enhanced with more granular categories |
| Automation | Manual review | More automated decision flows |
| Scope | Original transaction only | Can trace through multiple hops |

### New Fields and Faster Resolution

- **Enhanced fraud categories:** More specific fraud type indicators
- **Automated blocking:** Immediate precautionary blocking of suspected fraudulent accounts
- **Multi-hop tracing:** When funds are moved through multiple accounts, MED 2.0 can trace and recover across the chain
- **Faster notification:** Near real-time notification of fraud markers to all participating PSPs

### Integration with DICT Fraud Markers

When a MED 2.0 infraction is confirmed:
1. A fraud marker is created in DICT
2. The marker is associated with the account holder's CPF/CNPJ
3. All PSPs can see the fraud marker when performing key lookups
4. PSPs should use fraud markers in their risk assessment for outgoing payments
5. Multiple confirmed infractions increase the fraud risk score

### Implementation Notes

- Monitor Bacen circulars for MED 2.0 rollout timeline
- Update infraction report handling to support new fields
- Implement automated responses where appropriate
- Ensure fraud marker data is integrated into your risk engine

---

## Other Advanced Features

### Pix by Proxy (Pix por Aproximacao)

NFC-based Pix payments at point-of-sale terminals. Still in development/early rollout.

### Pix Offline

Payments that can be initiated without internet connectivity, with settlement occurring when connectivity is restored. Under development.

### Cross-Border Pix

International Pix payments. Regulatory framework still evolving.

---

## Feature Prioritization

For initial homologation as a Direct Participant, focus on:

1. **QR Codes (Static, COB, COBV)** -- Required for homologation
2. **MED / Infraction Reports** -- Required for homologation (covered in DICT functionality)
3. **Pix Automatico** -- Check with Bacen if required for your timeline
4. **MED 2.0** -- Implement as Bacen publishes requirements

Features like Pix Offline and Cross-Border Pix are future considerations and not part of current homologation requirements.
