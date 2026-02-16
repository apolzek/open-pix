# open-pix

Open-source toolkit for Pix Direct Participant homologation with Bacen (Brazilian Central Bank).

Built from real-world experience during actual homologation processes, documenting every pitfall, technical detail, and workflow pattern discovered over ~12 months of hands-on testing.

## What is this?

When a PSP (Payment Service Provider) wants to become a Direct Participant in Pix (Brazil's instant payment system), they must pass Bacen's homologation process. This involves:

1. **Basic Connectivity** — Connecting to ICOM (Bacen's messaging system) via mTLS
2. **SPI Functionality** — Sending/receiving ISO 20022 messages (pacs.008, pacs.002, pacs.004)
3. **SPI Capacity** — Processing 20,000 transactions in 10 minutes (sender + receiver)
4. **DICT Functionality** — Managing Pix keys, claims, infractions, and refunds
5. **DICT Capacity** — 1,000+ key lookups against Bacen's test directory
6. **Advanced Features** — QR codes, Pix Automatico, MED 2.0
7. **Go-Live** — Production cutover

This toolkit provides **automation scripts**, **documentation**, and a **Claude Code skill** to guide you through each phase.

## Quick Start

```bash
# Clone the repository
git clone git@github.com:fernandocruz/open-pix.git
cd open-pix

# Install dependencies
npm install

# Configure your PSP
cp config/homolog.env.example .env
# Edit .env with your ISPB, certificates, etc.

# Generate test data
npx tsx scripts/utils/test-data-generator.ts <YOUR_ISPB>

# Generate a sample pacs.008
npx tsx scripts/spi/pacs008-generator.ts <YOUR_ISPB> 99999004

# Validate a QR code payload
npx tsx scripts/qrcode/qr-parser.ts "<payload>"
```

## Claude Code Integration

If you use [Claude Code](https://claude.com/claude-code), the `/homolog-pix` skill provides an interactive guide:

```
/homolog-pix status              # Progress dashboard
/homolog-pix phase 2             # Basic connectivity guide
/homolog-pix generate pacs008    # Generate payment XML
/homolog-pix debug "AB03"        # Diagnose errors
/homolog-pix checklist spi       # Test checklist
/homolog-pix partner-template    # Partner data exchange
/homolog-pix test-data           # Generate test data
```

## Project Structure

```
open-pix/
├── .claude/commands/homolog-pix.md   # Claude Code slash command
├── docs/
│   ├── playbook/                     # 9-chapter homologation guide
│   │   ├── 00-overview.md
│   │   ├── 01-prerequisites.md
│   │   ├── 02-basic-connectivity.md
│   │   ├── 03-spi-functionality.md
│   │   ├── 04-spi-capacity.md
│   │   ├── 05-dict-functionality.md
│   │   ├── 06-dict-capacity.md
│   │   ├── 07-advanced-features.md
│   │   ├── 08-go-live.md
│   │   ├── pitfalls.md
│   │   └── glossary.md
│   └── reference/                    # Technical reference
│       ├── iso-messages.md
│       ├── dict-api.md
│       ├── icom-api.md
│       ├── endtoendid-format.md
│       └── error-codes.md
├── scripts/
│   ├── spi/                          # SPI (payment) scripts
│   │   ├── k6-spi-capacity.js        # k6 load test (2k/min for 10min)
│   │   ├── pacs008-generator.ts      # pacs.008 XML builder
│   │   ├── pacs002-generator.ts      # pacs.002 XML builder
│   │   ├── pacs004-generator.ts      # pacs.004 XML builder
│   │   ├── send-pix.ts               # Single payment sender
│   │   └── batch-sender.ts           # HTTP endpoint for k6
│   ├── dict/                         # DICT (key directory) scripts
│   │   ├── k6-dict-capacity.js       # k6 load test for lookups
│   │   ├── key-bulk-creator.ts       # Create 1000+ keys
│   │   ├── key-lookup.ts             # Key lookup utility
│   │   ├── claims-helper.ts          # Portability + ownership
│   │   ├── infraction-helper.ts      # MED flows
│   │   └── refund-helper.ts          # Refund solicitations
│   ├── qrcode/                       # QR code tools
│   │   ├── qr-generator.ts           # Static/COB/COBV generator
│   │   └── qr-parser.ts              # EMV payload parser
│   └── utils/                        # Shared utilities
│       ├── cpf-cnpj-generator.ts     # Valid document generator
│       ├── endtoendid-generator.ts   # E2E ID generator
│       ├── biz-message-id-generator.ts
│       ├── test-data-generator.ts    # Full test data generator
│       └── http-client.ts            # ICOM client (mTLS, gzip)
├── templates/                        # Coordination templates
│   ├── partner-test-data.csv
│   ├── dict-test-roadmap.csv
│   ├── spi-test-checklist.csv
│   └── bacen-scheduling-email.md
├── config/
│   ├── homolog.env.example
│   └── psp-config.example.json
└── state/
    └── progress.json.example         # Homologation progress tracker
```

## Scripts

### Utilities

| Script | Description |
|--------|-------------|
| `npm run generate:cpf` | Generate valid CPF numbers |
| `npm run generate:test-data` | Generate complete test data sets |
| `npm run generate:e2eid` | Generate EndToEndId values |

### SPI (Payments)

| Script | Description |
|--------|-------------|
| `npm run generate:pacs008` | Generate pacs.008 payment XML |
| `npm run generate:pacs002` | Generate pacs.002 status XML |
| `npm run generate:pacs004` | Generate pacs.004 devolution XML |
| `npm run send:pix` | Send a single Pix payment |
| `npm run test:spi-capacity` | Run SPI capacity load test (k6) |

### DICT (Key Directory)

| Script | Description |
|--------|-------------|
| `npm run dict:create-keys` | Bulk create DICT keys |
| `npm run dict:lookup` | Look up a Pix key |
| `npm run dict:claim` | Manage portability/ownership claims |
| `npm run dict:infraction` | Manage MED infraction reports |
| `npm run dict:refund` | Manage refund solicitations |
| `npm run test:dict-capacity` | Run DICT capacity load test (k6) |

### QR Codes

| Script | Description |
|--------|-------------|
| `npm run generate:qr` | Generate Pix QR code payloads |
| `npm run parse:qr` | Parse and validate QR payloads |

## Top Pitfalls

These are the most common issues encountered during real homologation:

1. **Wrong ISO message version** — Bacen silently changes required versions. Try 1.13 first.
2. **APM headers cause 403** — DataDog/NewRelic inject forbidden HTTP headers. Use a strict whitelist.
3. **pacs.002 timeout (AB03)** — Must respond within ~10 seconds or SPI auto-rejects.
4. **Event loop blocking** — Single Node.js process can't sustain 2k/min. Use multiple pods.
5. **DICT ownership claims** — Only works for PHONE keys (Resolution 457/2025).
6. **PI account has zero balance** — Must receive Pix or use STR Web first.

See [docs/playbook/pitfalls.md](docs/playbook/pitfalls.md) for all 12+ documented pitfalls with solutions.

## Typical Timeline

| Month | Milestones |
|-------|-----------|
| 1 | Basic connectivity + SPI functionality + first capacity rehearsals |
| 2 | SPI capacity test with Bacen + DICT functionality development |
| 3 | DICT functionality + DICT capacity + QR codes |
| 3-4 | Advanced features + production go-live |

**Total: ~3-4.5 months** from first connection to production.

## Prerequisites

- Node.js >= 18
- [k6](https://k6.io/) for load testing
- ICP-Brasil digital certificates for mTLS
- RSFN network access (STA/STR configured)
- Active PI account at Bacen
- Partner PSP for bilateral testing

## License

MIT
