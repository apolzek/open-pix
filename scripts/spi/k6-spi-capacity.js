/**
 * k6 Load Test for SPI Capacity Homologation.
 *
 * Bacen requirements:
 * - 20,000 transactions in 10 minutes (2,000/min)
 * - Must operate as BOTH sender and receiver simultaneously
 * - All transactions must complete with pacs.002 within timeout
 *
 * This script calls the batch-sender HTTP endpoint which handles
 * the actual ICOM communication.
 *
 * Usage:
 *   1. Start the batch sender:  npx tsx scripts/spi/batch-sender.ts
 *   2. Run this script:         k6 run scripts/spi/k6-spi-capacity.js
 *
 * Dry run (syntax check):
 *   k6 run --dry-run scripts/spi/k6-spi-capacity.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// Custom metrics
const pixSent = new Counter("pix_sent");
const pixSuccess = new Rate("pix_success_rate");
const pixLatency = new Trend("pix_latency", true);

// Configuration
const BATCH_SENDER_URL = __ENV.BATCH_SENDER_URL || "http://localhost:3100";

export const options = {
  scenarios: {
    spi_capacity: {
      executor: "constant-arrival-rate",
      rate: 2000,             // 2000 iterations per timeUnit
      timeUnit: "1m",         // per minute
      duration: "10m",        // for 10 minutes = 20,000 total
      preAllocatedVUs: 20,    // initial VUs
      maxVUs: 500,            // scale up if needed
    },
  },
  thresholds: {
    pix_success_rate: ["rate>0.95"],      // 95%+ success rate
    pix_latency: ["p(95)<5000"],          // 95th percentile under 5s
    http_req_duration: ["p(99)<10000"],   // 99th percentile under 10s
  },
};

export function setup() {
  // Reset batch sender stats before test
  const resetRes = http.get(`${BATCH_SENDER_URL}/reset`);
  check(resetRes, {
    "reset successful": (r) => r.status === 200,
  });

  // Health check
  const healthRes = http.get(`${BATCH_SENDER_URL}/health`);
  if (healthRes.status !== 200) {
    throw new Error(
      `Batch sender not available at ${BATCH_SENDER_URL}. ` +
      "Start it with: npx tsx scripts/spi/batch-sender.ts"
    );
  }

  console.log("SPI Capacity Test starting...");
  console.log(`Target: 20,000 transactions in 10 minutes (2,000/min)`);
  console.log(`Batch sender: ${BATCH_SENDER_URL}`);

  return { startTime: Date.now() };
}

export default function () {
  const amount = (Math.floor(Math.random() * 10000) + 1) / 100; // R$ 0.01 - R$ 100.00

  const payload = JSON.stringify({
    amount: amount,
    version: "1.13",
  });

  const params = {
    headers: { "Content-Type": "application/json" },
    timeout: "15s",
  };

  const startTime = Date.now();
  const res = http.post(`${BATCH_SENDER_URL}/send`, payload, params);
  const latency = Date.now() - startTime;

  pixLatency.add(latency);
  pixSent.add(1);

  const success = check(res, {
    "status is 200-299": (r) => r.status >= 200 && r.status < 300,
    "response has status": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status !== undefined;
      } catch {
        return false;
      }
    },
  });

  pixSuccess.add(success ? 1 : 0);

  // Small sleep to avoid overwhelming the event loop
  sleep(0.01);
}

export function teardown(data) {
  // Get final stats from batch sender
  const statsRes = http.get(`${BATCH_SENDER_URL}/stats`);
  if (statsRes.status === 200) {
    const stats = JSON.parse(statsRes.body);
    console.log("\n=== SPI Capacity Test Results ===");
    console.log(`Total sent:     ${stats.sent}`);
    console.log(`Accepted:       ${stats.accepted}`);
    console.log(`Rejected:       ${stats.rejected}`);
    console.log(`Errors:         ${stats.errors}`);
    console.log(`Rate (per min): ${stats.ratePerMinute}`);
    console.log(`Duration:       ${stats.elapsedSeconds}s`);

    const passed = stats.sent >= 20000 && stats.ratePerMinute >= 1900;
    console.log(`\nResult: ${passed ? "PASS ✓" : "FAIL ✗"}`);

    if (!passed) {
      console.log("\nTroubleshooting:");
      if (stats.sent < 20000) {
        console.log("  - Sent fewer than 20k: increase VUs or check connection pooling");
      }
      if (stats.errors > stats.sent * 0.05) {
        console.log("  - High error rate: check ICOM connectivity and cert validity");
      }
      if (stats.ratePerMinute < 1900) {
        console.log("  - Rate too low: check Node.js event loop, consider multiple pods");
      }
    }
  }
}
