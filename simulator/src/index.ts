/**
 * Monta o simulador do lado Bacen: ICOM + SPI, DICT e API de controle.
 *
 *   ICOM (mTLS)  :16522  POST /api/v1/in/{ispb}/msgs, GET .../out/{ispb}/stream/...
 *   DICT (mTLS)  :16523  /api/v2/entries/...
 *   Controle     :18080  JSON sem mTLS, fora da "RSFN" simulada
 *
 * Com SIM_TLS=0 tudo sobe em HTTP puro, util para depurar com curl.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { config as defaults, type Config } from "./config.js";
import { Timeline } from "./core/events.js";
import { setLevel } from "./core/log.js";
import { RateLimiter } from "./core/bucket.js";
import { Participants, brl } from "./spi/participants.js";
import { SpiEngine } from "./spi/engine.js";
import { VirtualParticipants, VIRTUAL_CREDITOR, VIRTUAL_DEBTOR } from "./spi/virtual.js";
import { Outbox } from "./icom/outbox.js";
import { TrafficLimiter } from "./icom/traffic.js";
import { icomHandler } from "./icom/server.js";
import { DictStore } from "./dict/server.js";
import { controlHandler } from "./ctl/server.js";

export type SimulatorOptions = Partial<Omit<Config, "participants">> & { participants?: string };

export interface Simulator {
  config: Config;
  timeline: Timeline;
  participants: Participants;
  engine: SpiEngine;
  dict: DictStore;
  virtual: VirtualParticipants;
  outbox: Outbox;
  urls: { icom: string; dict: string; ctl: string };
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
}

function parseParticipants(spec: string): { ispb: string; name: string; balanceCents: number }[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [ispb, name, balance] = s.split(":");
      return { ispb, name: name || ispb, balanceCents: Math.round(Number(balance || 0) * 100) };
    });
}

export function createSimulator(overrides: SimulatorOptions = {}): Simulator {
  const config = { ...defaults, ...overrides } as Config;
  setLevel(config.logLevel);

  const timeline = new Timeline();
  const participants = new Participants();
  const traffic = new TrafficLimiter();
  const limiter = new RateLimiter(config.participantCategory);
  const outbox = new Outbox({
    maxStreams: config.maxPollConnections,
    maxPerRead: config.maxMessagesPerStream,
    longPollMs: config.longPollMs,
    streamIdleMs: config.streamIdleMs,
  });

  const seed = () => {
    for (const p of parseParticipants(config.participants)) participants.add(p);
    participants.add({ ispb: VIRTUAL_CREDITOR, name: "Cooperativa de Credito Virtual", virtual: true, balanceCents: 1e12 });
    participants.add({ ispb: VIRTUAL_DEBTOR, name: "Banco Virtual", virtual: true, balanceCents: 1e12 });
  };
  seed();

  // Referencias circulares: o motor entrega aos virtuais, que respondem ao motor.
  let virtual: VirtualParticipants;
  const deliver = (ispb: string, xml: string, type: string) => {
    if (virtual.handles(ispb)) virtual.receive(ispb, xml, type);
    else outbox.enqueue(ispb, xml, type);
  };
  const engine = new SpiEngine(participants, deliver, timeline, traffic, {
    settlementTimeoutMs: config.settlementTimeoutMs,
    validateXsd: config.validateXsd,
    e2eToleranceMs: 12 * 3600_000,
    returnWindowMs: 90 * 24 * 3600_000,
  });
  virtual = new VirtualParticipants((ispb, xml, rid) => engine.receive(ispb, xml, rid), timeline, config.virtualReplyMs);

  const dict = new DictStore({ participants, limiter, timeline, verifySignature: config.verifySignature, tls: config.tlsEnabled });
  engine.onSettled = (s) => {
    if (s.kind === "payment") dict.paymentSettled(s.endToEndId);
  };

  const reset = () => {
    engine.reset();
    dict.reset();
    outbox.reset();
    traffic.reset();
    limiter.reset();
    timeline.clear();
    seed();
    for (const p of participants.list()) {
      const initial = parseParticipants(config.participants).find((x) => x.ispb === p.ispb);
      if (initial) Object.assign(p, { balanceCents: initial.balanceCents, sendBlocked: false });
    }
    timeline.record("CTL", "Simulador reiniciado");
  };

  const icom = icomHandler({
    participants,
    outbox,
    traffic,
    timeline,
    submit: (ispb, xml, rid) => engine.receive(ispb, xml, rid),
    enforceHeaders: config.enforceHeaderWhitelist,
    tls: config.tlsEnabled,
  });

  const makeServer = (handler: http.RequestListener): http.Server => {
    if (!config.tlsEnabled) return http.createServer(handler);
    const dir = config.certDir;
    const read = (f: string) => {
      const file = path.join(dir, f);
      if (!fs.existsSync(file)) throw new Error(`Certificado ausente: ${file}. Rode: npm run sim:certs`);
      return fs.readFileSync(file);
    };
    return https.createServer(
      { key: read("server.key"), cert: read("server.pem"), ca: read("ca.pem"), requestCert: true, rejectUnauthorized: true },
      handler,
    );
  };

  const icomServer = makeServer(icom);
  const dictServer = makeServer(dict.handler());
  const ctlServer = http.createServer(controlHandler({ participants, engine, dict, virtual, outbox, timeline, reset }));

  const sim: Simulator = {
    config,
    timeline,
    participants,
    engine,
    dict,
    virtual,
    outbox,
    urls: { icom: "", dict: "", ctl: "" },
    async start() {
      const listen = (s: http.Server, port: number) =>
        new Promise<number>((resolve) => s.listen(port, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
      const scheme = config.tlsEnabled ? "https" : "http";
      sim.urls.icom = `${scheme}://localhost:${await listen(icomServer, config.icomPort)}`;
      sim.urls.dict = `${scheme}://localhost:${await listen(dictServer, config.dictPort)}`;
      sim.urls.ctl = `http://localhost:${await listen(ctlServer, config.ctlPort)}`;
      timeline.record("CTL", `Simulador no ar: ICOM ${sim.urls.icom}, DICT ${sim.urls.dict}, controle ${sim.urls.ctl}`);
      for (const p of participants.list()) {
        timeline.record("CTL", `Participante ${p.ispb} ${p.name}${p.virtual ? " (virtual)" : ""}, conta PI ${brl(p.balanceCents)}`, { ispb: p.ispb });
      }
    },
    async stop() {
      engine.reset();
      outbox.stop();
      const close = (s: http.Server) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        });
      await Promise.all([close(icomServer), close(dictServer), close(ctlServer)]);
    },
    reset,
  };
  return sim;
}
