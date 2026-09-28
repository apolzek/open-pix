/**
 * k6 Load Test for DICT Capacity Homologation.
 *
 * Calls the DICT API v2.12.1 getEntry operation directly over mTLS:
 *   GET {DICT_BASE_URL}/api/v2/entries/{urlencoded Key}
 *   PI-RequestingParticipant: <PSP_ISPB>
 *   PI-PayerId:               <CPF/CNPJ of the paying user, digits only>
 *   PI-EndToEndId:            <EndToEndId of the payment being prepared>
 *   Accept: application/xml
 *   Accept-Encoding: gzip
 * Expected: 200 (GetEntryResponse, key found) or 404 (key not found).
 * 429 means a rate-limit bucket ran dry.
 *
 * Rate limiting (spec "Limitacao de requisicoes"): the user antiscan buckets
 * are scoped by PI-PayerId (PF: 2/min refill, bucket 100; a 404 costs 20), so
 * this test uses a fresh random valid CPF as PayerId on every request. The
 * participant antiscan bucket (ENTRIES_READ_PARTICIPANT_ANTISCAN) still
 * applies to the whole PSP; its size depends on the participant category.
 *
 * Target: 1,000+ successful lookups (DICT capacity step). The test keys used
 * below (cliente-NNNNNN@pix.bcb.gov.br and +5561900NNNNNN) follow the ranges
 * seen in homologation; they are not in the API spec, so confirm the ranges
 * Bacen gives you and adjust DICT_EMAIL_KEYS / DICT_PHONE_KEYS.
 *
 * Env:
 *   DICT_BASE_URL   default https://dict-h.pi.rsfn.net.br:16522 (production: https://dict.pi.rsfn.net.br:16422)
 *   PSP_ISPB        your ISPB ([0-9A-Z]{8}), used in PI-RequestingParticipant and EndToEndIds
 *   MTLS_CERT_PATH  client certificate (PEM)
 *   MTLS_KEY_PATH   client private key (PEM)
 *   DICT_EMAIL_KEYS number of email test keys (default 10000)
 *   DICT_PHONE_KEYS number of phone test keys (default 10000)
 * k6 has no per-script CA option: trust the RSFN CA chain through the system
 * store or SSL_CERT_FILE=$MTLS_CA_PATH when running k6.
 *
 * Usage:
 *   SSL_CERT_FILE=./certs/ca-chain.pem k6 run -e PSP_ISPB=12345678 \
 *     -e MTLS_CERT_PATH=./certs/client.pem -e MTLS_KEY_PATH=./certs/client-key.pem \
 *     scripts/dict/k6-dict-capacity.js
 *
 * Inspect options without running:
 *   k6 inspect scripts/dict/k6-dict-capacity.js
 */

import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const lookupsCompleted = new Counter("dict_lookups_completed");
const lookupsFound = new Counter("dict_lookups_found");
const lookupsNotFound = new Counter("dict_lookups_not_found");
const lookupsRateLimited = new Counter("dict_lookups_rate_limited");
const lookupSuccess = new Rate("dict_lookup_success_rate");
const lookupLatency = new Trend("dict_lookup_latency", true);

const BASE_URL = (__ENV.DICT_BASE_URL || "https://dict-h.pi.rsfn.net.br:16522").replace(/\/+$/, "");
const HOST = BASE_URL.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
const ISPB = __ENV.PSP_ISPB || "12345678";
const EMAIL_KEYS = parseInt(__ENV.DICT_EMAIL_KEYS || "10000", 10);
const PHONE_KEYS = parseInt(__ENV.DICT_PHONE_KEYS || "10000", 10);

const tlsAuth = __ENV.MTLS_CERT_PATH && __ENV.MTLS_KEY_PATH
  ? [{ domains: [HOST], cert: open(__ENV.MTLS_CERT_PATH), key: open(__ENV.MTLS_KEY_PATH) }]
  : [];

export const options = {
  tlsAuth,
  scenarios: {
    dict_capacity: {
      executor: "constant-arrival-rate",
      rate: 200,               // 200 lookups per minute
      timeUnit: "1m",
      duration: "6m",          // 6 minutes = 1,200 lookups (> 1,000 min)
      preAllocatedVUs: 10,
      maxVUs: 100,
    },
  },
  thresholds: {
    dict_lookup_success_rate: ["rate>0.95"],
    dict_lookup_latency: ["p(95)<3000"],
    dict_lookups_completed: ["count>=1000"],
  },
};

const ALNUM = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function pad(n, len) {
  return String(n).padStart(len, "0");
}

/** E + ISPB + yyyyMMddHHmm (UTC) + 11 alphanumeric = 32 chars. */
function endToEndId() {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}`;
  let suffix = "";
  for (let i = 0; i < 11; i++) suffix += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return `E${ISPB}${stamp}${suffix}`;
}

/** Random CPF with valid check digits (PI-PayerId). */
function randomCpf() {
  const d = [];
  for (let i = 0; i < 9; i++) d.push(Math.floor(Math.random() * 10));
  if (d.every((x) => x === d[0])) d[8] = (d[8] + 1) % 10;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += d[i] * (len + 1 - i);
    const r = sum % 11;
    d.push(r < 2 ? 0 : 11 - r);
  }
  return d.join("");
}

function randomTestKey() {
  const i = Math.floor(Math.random() * (EMAIL_KEYS + PHONE_KEYS));
  return i < EMAIL_KEYS
    ? `cliente-${pad(i, 6)}@pix.bcb.gov.br`
    : `+5561900${pad(i - EMAIL_KEYS, 6)}`;
}

export function setup() {
  if (tlsAuth.length === 0) {
    console.warn("MTLS_CERT_PATH/MTLS_KEY_PATH not set: requests will fail the mTLS handshake.");
  }
  console.log("DICT Capacity Test starting...");
  console.log("Target: 1,000+ key lookups (GET /api/v2/entries/{Key})");
  console.log(`Endpoint: ${BASE_URL}/api/v2/entries/`);
  return { startTime: Date.now() };
}

export default function () {
  const key = randomTestKey();

  const params = {
    headers: {
      Host: HOST, // no port in Host
      Accept: "application/xml",
      "Accept-Encoding": "gzip",
      "PI-RequestingParticipant": ISPB,
      "PI-PayerId": randomCpf(),
      "PI-EndToEndId": endToEndId(),
    },
    timeout: "10s",
    responseCallback: http.expectedStatuses(200, 404),
    tags: { name: "getEntry" },
  };

  const res = http.get(`${BASE_URL}/api/v2/entries/${encodeURIComponent(key)}`, params);

  lookupLatency.add(res.timings.duration);
  lookupsCompleted.add(1);
  if (res.status === 200) lookupsFound.add(1);
  else if (res.status === 404) lookupsNotFound.add(1);
  else if (res.status === 429) lookupsRateLimited.add(1);

  const success = check(res, {
    "status is 200 or 404": (r) => r.status === 200 || r.status === 404,
    "200 carries GetEntryResponse/Entry": (r) =>
      r.status !== 200 || (String(r.body).includes("<GetEntryResponse") && String(r.body).includes("<Entry>")),
  });

  lookupSuccess.add(success ? 1 : 0);
}

export function teardown(data) {
  const elapsed = ((Date.now() - data.startTime) / 1000).toFixed(0);
  console.log(`\n=== DICT Capacity Test finished in ${elapsed}s ===`);
  console.log("See dict_lookups_completed / _found / _not_found / _rate_limited in the summary.");
  console.log("Result: PASS requires dict_lookups_completed >= 1000 and success rate > 95%.");
}
