/**
 * Jornada de estudo: sobe o "Bacen" simulado (ICOM + SPI + DICT) e dois
 * bancos digitais, cada um com sua pagina web.
 *
 *   npm run demo
 *
 *   Banco Alfa  http://localhost:3001   ISPB 10000001
 *   Banco Beta  http://localhost:3002   ISPB 20000002
 *   Bacen       http://localhost:18080  API de controle (JSON)
 *
 * No console, cada passo aparece com o banco ([ALFA], [BETA]) ou o Bacen
 * ([BACEN]) que o executou e uma explicacao do porque.
 */

import { createSimulator, type SimulatorOptions } from "../../../simulator/src/index.js";
import { config as simConfig } from "../../../simulator/src/config.js";
import { generateCerts } from "../../../simulator/tools/gen-certs.js";
import type { SimEvent } from "../../../simulator/src/core/events.js";
import { Bank } from "./bank.js";
import { startWeb } from "./web.js";

const ALFA = "10000001";
const BETA = "20000002";
const color = process.stdout.isTTY;
const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

export interface DemoOptions {
  alfaPort?: number;
  betaPort?: number;
  ctlPort?: number;
  icomPort?: number;
  dictPort?: number;
  certDir?: string;
  quiet?: boolean;
  /** Ajustes do simulador, ex. settlementTimeoutMs menor nos testes. */
  sim?: SimulatorOptions;
}

export async function startDemo(opts: DemoOptions = {}) {
  const certDir = opts.certDir ?? simConfig.certDir;
  generateCerts(certDir, [ALFA, BETA]);

  const sim = createSimulator({
    certDir,
    logLevel: "warn",
    icomPort: opts.icomPort ?? simConfig.icomPort,
    dictPort: opts.dictPort ?? simConfig.dictPort,
    ctlPort: opts.ctlPort ?? simConfig.ctlPort,
    participants: `${ALFA}:Banco Alfa:1000000,${BETA}:Banco Beta:1000000`,
    ...opts.sim,
  });
  if (!opts.quiet) {
    sim.timeline.on("event", (e: SimEvent) => {
      if (e.actor === "ICOM" && /leu /.test(e.message)) return; // leitura de stream e ruido
      console.log(`${paint("1;33", "[BACEN]")} ${paint("33", e.actor.padEnd(7))} ${e.message}`);
    });
  }
  await sim.start();

  const common = { icomUrl: sim.urls.icom, dictUrl: sim.urls.dict, certDir };
  const alfa = new Bank({ ...common, ispb: ALFA, name: "Banco Alfa", label: "ALFA", color: "\x1b[34m" });
  const beta = new Bank({ ...common, ispb: BETA, name: "Banco Beta", label: "BETA", color: "\x1b[35m" });

  const ana = alfa.addCustomer({ name: "Ana Silva", taxId: "52998224725", personType: "NATURAL_PERSON", branch: "1", account: "10001", accountType: "CACC", balance: 1500 });
  const bruno = alfa.addCustomer({ name: "Bruno Costa", taxId: "11144477735", personType: "NATURAL_PERSON", branch: "1", account: "10002", accountType: "CACC", balance: 300 });
  const maria = beta.addCustomer({ name: "Maria Souza", taxId: "98765432100", personType: "NATURAL_PERSON", branch: "7", account: "20001", accountType: "CACC", balance: 800 });
  const padaria = beta.addCustomer({ name: "Padaria Pao Quente Ltda", taxId: "11222333000181", personType: "LEGAL_PERSON", branch: "7", account: "20002", accountType: "CACC", balance: 5000 });

  alfa.start();
  beta.start();

  await alfa.registerKey(ana.id, "EMAIL", "ana@alfa.com.br");
  await alfa.registerKey(ana.id, "CPF");
  await alfa.registerKey(bruno.id, "PHONE", "+5511988887777");
  await beta.registerKey(maria.id, "EMAIL", "maria@beta.com.br");
  await beta.registerKey(maria.id, "PHONE", "+5521999990000");
  await beta.registerKey(padaria.id, "CNPJ");
  await beta.registerKey(padaria.id, "EVP");

  const alfaWeb = await startWeb(alfa, opts.alfaPort ?? 3001, { ctlUrl: sim.urls.ctl, theme: "alfa" });
  const betaWeb = await startWeb(beta, opts.betaPort ?? 3002, { ctlUrl: sim.urls.ctl, theme: "beta" });
  const port = (s: unknown) => (s as { port: number }).port;

  if (!opts.quiet) {
    console.log(`
${paint("1", "Pronto! Abra no navegador:")}
  Banco Alfa  http://localhost:${port(alfaWeb)}   (Ana Silva, Bruno Costa)
  Banco Beta  http://localhost:${port(betaWeb)}   (Maria Souza, Padaria Pao Quente)
  Bacen       ${sim.urls.ctl}/participants   (contas PI) e ${sim.urls.ctl}/transactions

Chaves para testar: maria@beta.com.br, +5521999990000, 11222333000181 (Beta)
                    ana@alfa.com.br, 52998224725, +5511988887777 (Alfa)
Ctrl+C encerra.
`);
  }

  return {
    sim,
    alfa,
    beta,
    urls: { alfa: `http://localhost:${port(alfaWeb)}`, beta: `http://localhost:${port(betaWeb)}`, ctl: sim.urls.ctl },
    async stop() {
      await Promise.all([alfa.stop(), beta.stop()]);
      await new Promise((r) => alfaWeb.close(r));
      await new Promise((r) => betaWeb.close(r));
      await sim.stop();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const demo = await startDemo();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await demo.stop();
      process.exit(0);
    });
  }
}
