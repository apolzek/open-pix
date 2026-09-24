/**
 * Utilitarios de XML compartilhados pelo SPI e pelo DICT.
 *
 * Usa fast-xml-parser, que ja e dependencia do projeto. O parser roda em modo
 * que preserva tudo como texto, porque numero de conta e ISPB tem zero a
 * esquerda e nao podem sofrer coercao numerica.
 */

import { XMLParser } from "fast-xml-parser";
import { escapeXml } from "./problem.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

export type XmlNode = Record<string, any>;

export function parseXml(xml: string): XmlNode {
  return parser.parse(xml) as XmlNode;
}

/** Caminha por um documento parseado usando caminho separado por ponto. */
export function pick(node: unknown, path: string): any {
  let current: any = node;
  for (const segment of path.split(".")) {
    if (current === undefined || current === null) return undefined;
    current = current[segment];
  }
  return current;
}

/** Igual a pick, mas devolve string e resolve o caso de texto com atributo. */
export function pickText(node: unknown, path: string): string | undefined {
  const value = pick(node, path);
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") {
    return value["#text"] !== undefined ? String(value["#text"]) : undefined;
  }
  return String(value);
}

/** Sempre devolve array, porque o parser colapsa lista de um item so. */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Constroi um elemento XML simples, escapando o conteudo de texto. */
export function el(name: string, value: string | number | null | undefined, attrs?: Record<string, string>): string {
  const attr = attrs
    ? Object.entries(attrs)
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join("")
    : "";
  if (value === null || value === undefined || value === "") return `<${name}${attr}/>`;
  return `<${name}${attr}>${escapeXml(String(value))}</${name}>`;
}

/** Indenta um bloco de linhas, so para deixar o XML legivel no log. */
export function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line) => (line.trim() ? pad + line : line))
    .join("\n");
}
