/**
 * SPI message envelope (Catalogo de Mensagens e Servicos do SPI 5.13).
 *
 * Every message exchanged through ICOM has the same shape:
 *
 *   <Envelope xmlns="https://www.bcb.gov.br/pi/pacs.008/1.16">
 *     <AppHdr> Fr, To, BizMsgIdr, MsgDefIdr, CreDt, Sgntr </AppHdr>
 *     <Document> ... </Document>
 *   </Envelope>
 *
 * - One default namespace per message type and version; AppHdr and Document
 *   carry no namespace of their own.
 * - AppHdr/Fr is the ISPB of the sender and AppHdr/To is the ISPB of the
 *   receiver of *this* message. A PSP always sends to the SPI (00038166) and
 *   always receives from it; the counterparty PSP only appears in the Document
 *   (DbtrAgt/CdtrAgt).
 * - Dates are UTC with milliseconds: YYYY-MM-DDThh:mm:ss.sssZ.
 * - Sgntr holds the XMLDSig signature (Manual de Seguranca da RSFN). It is
 *   left empty here, as in Bacen's own examples; sign before sending.
 */

import { assertIspb } from "../utils/endtoendid-generator.js";

/** ISPB of the SPI itself (Banco Central do Brasil). */
export const SPI_ISPB = "00038166";

/** Message versions in catalog 5.13. */
export const SPI_MESSAGE_VERSIONS = {
  "pacs.008": "1.16",
  "pacs.002": "1.17",
  "pacs.004": "1.5",
} as const;

export type SpiMessageType = keyof typeof SPI_MESSAGE_VERSIONS;

export function spiNamespace(type: SpiMessageType): string {
  return `https://www.bcb.gov.br/pi/${type}/${SPI_MESSAGE_VERSIONS[type]}`;
}

export function spiMsgDefIdr(type: SpiMessageType): string {
  return `${type}.spi.${SPI_MESSAGE_VERSIONS[type]}`;
}

/** ISO 8601 UTC with milliseconds, as the XSD type ISONormalisedDateTime requires. */
export function isoUtc(d: Date = new Date()): string {
  return d.toISOString();
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Amount with two decimals and dot separator. */
export function formatAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  return amount.toFixed(2);
}

export function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line) => (line.trim() ? pad + line : line))
    .join("\n");
}

export interface EnvelopeParams {
  type: SpiMessageType;
  from: string;
  to: string;
  bizMsgIdr: string;
  createdAt: string;
  /** Document body, already rendered, without the <Document> tag. */
  document: string;
}

function partyXml(ispb: string): string {
  return `<FIId>
    <FinInstnId>
        <Othr>
            <Id>${assertIspb(ispb)}</Id>
        </Othr>
    </FinInstnId>
</FIId>`;
}

export function buildEnvelope(p: EnvelopeParams): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="${spiNamespace(p.type)}">
    <AppHdr>
        <Fr>
${indent(partyXml(p.from), 12)}
        </Fr>
        <To>
${indent(partyXml(p.to), 12)}
        </To>
        <BizMsgIdr>${p.bizMsgIdr}</BizMsgIdr>
        <MsgDefIdr>${spiMsgDefIdr(p.type)}</MsgDefIdr>
        <CreDt>${p.createdAt}</CreDt>
        <Sgntr/>
    </AppHdr>
    <Document>
${indent(p.document, 8)}
    </Document>
</Envelope>
`;
}

/** Element with ISPB of a financial institution inside the Document. */
export function agentXml(tag: "DbtrAgt" | "CdtrAgt", ispb: string): string {
  return `<${tag}>
    <FinInstnId>
        <ClrSysMmbId>
            <MmbId>${assertIspb(ispb)}</MmbId>
        </ClrSysMmbId>
    </FinInstnId>
</${tag}>`;
}
