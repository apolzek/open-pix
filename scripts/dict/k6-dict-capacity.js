/**
 * k6 Load Test for DICT Capacity Homologation.
 *
 * Bacen requirements:
 * - 1,000+ key lookups successfully completed
 * - Bacen pre-registers ~20k test keys (emails + phones)
 * - Keys are in format:
 *   - Emails: cliente-000000@pix.bcb.gov.br to cliente-999999@pix.bcb.gov.br
 *   - Phones: +5561900000000 to +5561900009999
 *
 * This test calls the DICT API directly via mTLS.
 * Alternatively, you can use a batch-sender pattern similar to SPI capacity.
 *
 * Usage:
 *   k6 run scripts/dict/k6-dict-capacity.js
 *
 * Dry run:
 *   k6 run --dry-run scripts/dict/k6-dict-capacity.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const lookupsCompleted = new Counter("dict_lookups_completed");
const lookupSuccess = new Rate("dict_lookup_success_rate");
const lookupLatency = new Trend("dict_lookup_latency", true);

const BATCH_SENDER_URL = __ENV.DICT_SENDER_URL || "http://localhost:3101";

export const options = {
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
  },
};

export function setup() {
  const healthRes = http.get(`${BATCH_SENDER_URL}/health`);
  if (healthRes.status !== 200) {
    throw new Error(
      `DICT batch sender not available at ${BATCH_SENDER_URL}. ` +
      "Start a DICT lookup endpoint or configure DICT_SENDER_URL."
    );
  }

  // Reset stats
  http.get(`${BATCH_SENDER_URL}/reset`);

  console.log("DICT Capacity Test starting...");
  console.log("Target: 1,000+ key lookups");
  console.log(`Endpoint: ${BATCH_SENDER_URL}`);

  return { startTime: Date.now() };
}

export default function () {
  // Generate a random Bacen test email key
  const keyIndex = Math.floor(Math.random() * 20000);
  const email = `cliente-${String(keyIndex).padStart(6, "0")}@pix.bcb.gov.br`;

  const payload = JSON.stringify({
    keyType: "EMAIL",
    key: email,
  });

  const params = {
    headers: { "Content-Type": "application/json" },
    timeout: "10s",
  };

  const startTime = Date.now();
  const res = http.post(`${BATCH_SENDER_URL}/lookup`, payload, params);
  const latency = Date.now() - startTime;

  lookupLatency.add(latency);
  lookupsCompleted.add(1);

  const success = check(res, {
    "status is 200": (r) => r.status === 200,
    "has account data": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.account !== undefined || body.owner !== undefined;
      } catch {
        return false;
      }
    },
  });

  lookupSuccess.add(success ? 1 : 0);

  sleep(0.05);
}

export function teardown(data) {
  const statsRes = http.get(`${BATCH_SENDER_URL}/stats`);
  if (statsRes.status === 200) {
    const stats = JSON.parse(statsRes.body);
    console.log("\n=== DICT Capacity Test Results ===");
    console.log(`Total lookups:  ${stats.total || stats.sent || "N/A"}`);
    console.log(`Successful:     ${stats.successful || stats.accepted || "N/A"}`);
    console.log(`Failed:         ${stats.failed || stats.errors || "N/A"}`);
    console.log(`Duration:       ${stats.elapsedSeconds || "N/A"}s`);

    const total = stats.total || stats.sent || 0;
    const passed = total >= 1000;
    console.log(`\nResult: ${passed ? "PASS" : "FAIL"} (${total}/1000 minimum)`);
  }
}
