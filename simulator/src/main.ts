/**
 * Sobe o simulador do lado Bacen (ICOM + SPI, DICT e API de controle).
 *
 *   npm run sim:certs   # uma vez: gera a PKI local
 *   npm run sim:start
 */

import { createSimulator } from "./index.js";

const sim = createSimulator();
await sim.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await sim.stop();
    process.exit(0);
  });
}
