/**
 * Gera a PKI local do simulador em simulator/certs (ignorada pelo git):
 *
 *   ca.pem / ca.key          autoridade certificadora de teste ("RSFN" local)
 *   server.pem / server.key  certificado do ICOM e do DICT (localhost)
 *   <ISPB>.pem / <ISPB>.key  certificado de cliente de cada participante,
 *                            com CN = ISPB, que e como o simulador sabe quem
 *                            esta chamando (mTLS)
 *
 * Uso: npx tsx simulator/tools/gen-certs.ts [ISPB ...]
 * Sem argumentos, gera para os participantes de SIM_PARTICIPANTS.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../src/config.js";

function openssl(cwd: string, ...args: string[]): void {
  const r = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} falhou: ${r.stderr}`);
}

export function generateCerts(dir: string, ispbs: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "ca.pem"))) {
    openssl(dir, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825", "-subj", "/CN=Open Pix Simulator CA", "-keyout", "ca.key", "-out", "ca.pem");
  }
  fs.writeFileSync(path.join(dir, "server.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  fs.writeFileSync(path.join(dir, "client.ext"), "extendedKeyUsage=clientAuth\n");

  const issue = (name: string, cn: string, ext: string) => {
    if (fs.existsSync(path.join(dir, `${name}.pem`))) return;
    openssl(dir, "req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${cn}`, "-keyout", `${name}.key`, "-out", `${name}.csr`);
    openssl(dir, "x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "825", "-extfile", ext, "-out", `${name}.pem`);
    fs.rmSync(path.join(dir, `${name}.csr`));
  };
  issue("server", "localhost", "server.ext");
  for (const ispb of ispbs) issue(ispb, ispb, "client.ext");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ispbs = process.argv.slice(2).length
    ? process.argv.slice(2)
    : config.participants.split(",").map((p) => p.split(":")[0].trim()).filter(Boolean);
  generateCerts(config.certDir, ispbs);
  console.log(`Certificados em ${config.certDir}: ca, server, ${ispbs.join(", ")}`);
}
