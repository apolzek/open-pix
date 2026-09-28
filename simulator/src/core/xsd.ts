/**
 * Validacao de mensagens do SPI contra os XSDs oficiais do catalogo.
 *
 * Usa o xmllint (libxml2), que precisa estar instalado. Os XSDs ficam em
 * simulator/spec/spi-5.13.1/xsd; veja o README da pasta para a origem.
 *
 * O elemento Sgntr exige uma assinatura XMLDSig. Enquanto a mensagem nao e
 * assinada ele vem vazio, como nos proprios exemplos do Bacen, e esse unico
 * erro e aceito quando allowUnsigned e verdadeiro.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const XSD_DIR = fileURLToPath(new URL("../../spec/spi-5.13.1/xsd/", import.meta.url));

/** XSD de cada namespace aceito. O namespace carrega tipo e versao da mensagem. */
const SCHEMAS: Record<string, string> = {
  "https://www.bcb.gov.br/pi/pacs.008/1.16": "pacs.008.spi.1.16.xsd",
  "https://www.bcb.gov.br/pi/pacs.002/1.17": "pacs.002.spi.1.17.xsd",
  "https://www.bcb.gov.br/pi/pacs.004/1.5": "pacs.004.spi.1.5.xsd",
};

export interface XsdResult {
  valid: boolean;
  namespace?: string;
  errors: string[];
}

const UNSIGNED_ERROR = /Element '\{[^}]+\}Sgntr': Missing child element\(s\)/;

export function namespaceOf(xml: string): string | undefined {
  return /<Envelope\s+xmlns="([^"]+)"/.exec(xml)?.[1];
}

export function hasXmllint(): boolean {
  return spawnSync("xmllint", ["--version"]).status === 0;
}

export function validateSpiMessage(xml: string, opts: { allowUnsigned?: boolean } = {}): XsdResult {
  const allowUnsigned = opts.allowUnsigned ?? true;
  const namespace = namespaceOf(xml);
  const schema = namespace ? SCHEMAS[namespace] : undefined;
  if (!schema) {
    return { valid: false, namespace, errors: [`Schema desconhecido ou nao habilitado para uso: ${namespace ?? "sem namespace"}`] };
  }

  const run = spawnSync("xmllint", ["--noout", "--schema", XSD_DIR + schema, "-"], {
    input: xml,
    encoding: "utf8",
  });
  if (run.error) throw run.error;

  const errors = run.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith("validates") && !line.endsWith("fails to validate"))
    .filter((line) => !(allowUnsigned && UNSIGNED_ERROR.test(line)));

  return { valid: errors.length === 0, namespace, errors };
}
