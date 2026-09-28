# open-pix

Open-source toolkit for Pix Direct Participant homologation with Bacen (Brazilian Central Bank).

Built from real-world experience during actual homologation processes, documenting every pitfall, technical detail, and workflow pattern discovered over ~12 months of hands-on testing.

## What is this?

When a PSP (Payment Service Provider) wants to become a Direct Participant in Pix (Brazil's instant payment system), they must pass Bacen's homologation process. This involves:

1. **Basic Connectivity** — Connecting to ICOM (Bacen's messaging system) via mTLS
2. **SPI Functionality** — Sending/receiving ISO 20022 messages (pacs.008, pacs.002, pacs.004)
3. **SPI Capacity** — Sending and receiving pacs.008 for 10 minutes at 1,000, 2,000 or 4,000 per minute depending on PSP size (10,000 / 20,000 / 40,000 messages)
4. **DICT Functionality** — Managing Pix keys, claims, infractions, and refunds
5. **DICT Capacity** — Sustained key lookups against Bacen's homologation DICT
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
# (99999A04 is Bacen's virtual credit union: it answers any pacs.008 with ACSP)
npx tsx scripts/spi/pacs008-generator.ts <YOUR_ISPB> 99999A04

# Validate a QR code payload
npx tsx scripts/qrcode/qr-parser.ts "<payload>"
```

## Pix simulator and study bank

To practice without Bacen's network, the repo ships a simulated Bacen side and
a digital bank web app that talks to it like a real PSP:

```bash
npm run demo        # Bacen simulator + Banco Alfa (:3001) + Banco Beta (:3002)
npm run sim:start   # only the simulator (ICOM :16522, DICT :16523, control :18080)
```

- [`simulator/`](simulator/README.md): ICOM (send, stream, PI-Pull-Next, DELETE, limits), SPI (XSD validation, routing, settlement on PI accounts, rejections, AB03 after 40 s), virtual participants 99999A04/99999A03 and a DICT subset with antiscan buckets.
- [`apps/banco-digital/`](apps/banco-digital/README.md): web app (in Portuguese) that shows every step of a Pix, with the reason behind it, in the browser and in the console.

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
│   │   ├── k6-spi-capacity.js        # k6 load test (1k/2k/4k per min for 10min)
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
│       └── http-client.ts            # ICOM + DICT clients (mTLS, gzip)
├── templates/                        # Coordination templates
│   ├── partner-test-data.csv
│   ├── dict-test-roadmap.csv
│   ├── spi-test-checklist.csv
│   └── bacen-scheduling-email.md
├── simulator/
│   ├── spec/                         # Copies of Bacen's official XSDs, examples and DICT OpenAPI
│   ├── src/
│   └── test/                         # npm run test:simulator
├── config/
│   ├── homolog.env.example
│   └── psp-config.example.json
└── state/
    └── progress.json.example         # Homologation progress tracker
```

## Official specifications and tests

`simulator/spec/` holds copies of the artifacts published by Bacen: the SPI message catalog 5.13.1 (XSDs and examples, pacs.008 1.16 / pacs.002 1.17 / pacs.004 1.5) and the DICT API 2.12.1 OpenAPI. `npm run test:simulator` validates the messages generated by the toolkit against those XSDs, so a generator change that breaks the official schema fails the tests.

Sources: [SPI catalog 5.13.1](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip), [DICT API](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/API-DICT.html), [ICOM manual 1.12](https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Manual%20das%20Interfaces%20de%20Comunica%C3%A7%C3%A3o-1.12.pdf), [Roteiro para Participação Direta no SPI](https://www.bcb.gov.br/content/estabilidadefinanceira/sistemapagamentosinstantaneos_docs/Roteiro_para_Participacao_Direta_no_SPI_e_abertura_de_Conta_PI.pdf), [Manual de Tempos do Pix](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/IX_ManualdeTemposdoPix.pdf).

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
| `npm run test:simulator` | Validate generated messages against the official XSDs |

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

1. **Wrong ISO message version** — Each SPI message has its own version (catalog 5.13: pacs.008 1.16, pacs.002 1.17, pacs.004 1.5). "Schema desconhecido ou não habilitado" means the version is not enabled: check `GET /api/v1/in/catalog` instead of guessing.
2. **APM headers get refused** — DataDog/NewRelic inject tracing headers that ICOM does not accept. Send only the headers in the ICOM manual's whitelist.
3. **Settlement timeout (AB03)** — The SPI rejects with AB03 when a Pix is not settled within 40 seconds of `AccptncDtTm`. The receiving PSP is measured separately: p50 1.4s / p95 2.3s to answer the pacs.008.
4. **Event loop blocking** — In our experience a single Node.js process couldn't sustain 2k/min while also consuming the stream within 200 ms. Use multiple pods.
5. **DICT ownership claims** — Only PHONE keys can be claimed by ownership (DICT API 2.12.1); every key type can be ported.
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
