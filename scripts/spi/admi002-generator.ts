/**
 * admi.002 (MessageReject) XML Generator.
 *
 * The SPI answers with an admi.002 when a message cannot be processed:
 * invalid XML or schema, version not enabled, wrong header, invalid
 * signature. ICOM stores messages without validating them (201 Created), so
 * these errors always arrive later, through the read stream.
 *
 * <RltdRef><Ref> carries the PI-ResourceId returned by ICOM when the
 * rejected message was stored (catalog 5.13, admi.002.spi.1.5).
 */

import { generateBizMsgIdr } from "../utils/biz-message-id-generator.js";
import { SPI_ISPB, buildEnvelope, escapeXml, isoUtc } from "./spi-envelope.js";

export interface Admi002Params {
  /** Participant that sent the rejected message. */
  receiverIspb: string;
  /** PI-ResourceId of the rejected message (up to 33 chars). */
  resourceId: string;
  /** Short reason, up to 35 chars (RjctgPtyRsn). */
  reason: string;
  /** Where the error is, up to 350 chars (ErrLctn). */
  location?: string;
  /** Description, up to 350 chars (RsnDesc). */
  description?: string;
  /** Extra data, up to 1000 chars (AddtlData). */
  additionalData?: string;
  rejectedAt?: Date;
}

function cut(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

export function generateAdmi002(params: Admi002Params): string {
  const bizMsgIdr = generateBizMsgIdr(SPI_ISPB);
  const createdAt = isoUtc();
  const opt = (tag: string, value: string | undefined, max: number) =>
    value ? `\n        <${tag}>${escapeXml(cut(value, max))}</${tag}>` : "";

  const document = `<admi.002.001.01>
    <RltdRef>
        <Ref>${escapeXml(cut(params.resourceId, 33))}</Ref>
    </RltdRef>
    <Rsn>
        <RjctgPtyRsn>${escapeXml(cut(params.reason, 35))}</RjctgPtyRsn>
        <RjctnDtTm>${isoUtc(params.rejectedAt ?? new Date())}</RjctnDtTm>${opt("ErrLctn", params.location, 350)}${opt("RsnDesc", params.description, 350)}${opt("AddtlData", params.additionalData, 1000)}
    </Rsn>
</admi.002.001.01>`;

  return buildEnvelope({
    type: "admi.002",
    from: SPI_ISPB,
    to: params.receiverIspb,
    bizMsgIdr,
    createdAt,
    document,
  });
}
