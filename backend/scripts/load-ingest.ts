/**
 * Broker-free load generator for the ingest → normalize → store → persistence →
 * WebSocket-broadcast pipeline.
 *
 * Unlike mock-mqtt.ts (which needs a broker), this hammers the authenticated
 * POST /api/debug/ingest endpoint over HTTP so the hot path can be stress-tested
 * on any machine. It logs in, fires devices×iterations requests through a fixed
 * concurrency pool, reports throughput + latency percentiles, then reads /metrics.
 *
 * Requires the backend running with DEBUG_INGEST_ENABLED=true and an admin login.
 * Usage:
 *   npx tsx scripts/load-ingest.ts [--url http://127.0.0.1:3000] [--user admin]
 *     [--pass admin123] [--devices 50] [--iterations 20] [--concurrency 25]
 */

interface Options {
  url: string;
  user: string;
  pass: string;
  devices: number;
  iterations: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    url: process.env.LOAD_URL || "http://127.0.0.1:3000",
    user: process.env.ADMIN_USERNAME || "admin",
    pass: process.env.ADMIN_PASSWORD || "admin123",
    devices: 50,
    iterations: 20,
    concurrency: 25,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--url" && value) {
      options.url = value;
      i += 1;
    } else if (key === "--user" && value) {
      options.user = value;
      i += 1;
    } else if (key === "--pass" && value) {
      options.pass = value;
      i += 1;
    } else if (key === "--devices" && value) {
      options.devices = Math.max(1, Number(value));
      i += 1;
    } else if (key === "--iterations" && value) {
      options.iterations = Math.max(1, Number(value));
      i += 1;
    } else if (key === "--concurrency" && value) {
      options.concurrency = Math.max(1, Number(value));
      i += 1;
    } else if (key === "--help" || key === "-h") {
      console.log(
        "Usage: npx tsx scripts/load-ingest.ts [--devices N] [--iterations M] [--concurrency C]",
      );
      process.exit(0);
    }
  }
  return options;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function login(options: Options): Promise<string> {
  const response = await fetch(`${options.url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: options.user, password: options.pass }),
  });
  if (!response.ok) {
    throw new Error(`login failed: HTTP ${response.status}`);
  }
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((entry) => entry.split(";")[0]).join("; ");
  if (!cookie) {
    throw new Error("login succeeded but no session cookie was returned");
  }
  return cookie;
}

function buildPayload(deviceId: string, tick: number): unknown {
  return {
    deviceId,
    deviceName: deviceId,
    scene_id: "kangcheng-airy",
    vehicle_info: { control_mode: 1, gear: 1, soc: 90 - (tick % 80), speed: 1.5 },
    fusion_loc: { x: 10 + tick * 0.3, y: 12 + (tick % 20) * 0.2, yaw: 0.3 },
    gps: { lat: 31.23, lng: 121.47, heading: 45 },
    task_status: 1,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `load: ${options.devices} devices × ${options.iterations} iters ` +
      `(${options.devices * options.iterations} requests, concurrency ${options.concurrency})`,
  );
  const cookie = await login(options);

  const tasks: Array<{ deviceId: string; tick: number }> = [];
  for (let t = 0; t < options.iterations; t += 1) {
    for (let d = 0; d < options.devices; d += 1) {
      tasks.push({ deviceId: `load-${String(d + 1).padStart(4, "0")}`, tick: t });
    }
  }

  const latencies: number[] = [];
  let errors = 0;
  let next = 0;
  const startedAt = Date.now();

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      const t0 = Date.now();
      try {
        const response = await fetch(`${options.url}/api/debug/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify(buildPayload(task.deviceId, task.tick)),
        });
        if (!response.ok) errors += 1;
        // Drain the body so the socket is reusable.
        await response.text();
      } catch {
        errors += 1;
      }
      latencies.push(Date.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

  const elapsedMs = Date.now() - startedAt;
  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  console.log("── results ──────────────────────────────");
  console.log(`requests:    ${total} (errors: ${errors})`);
  console.log(`elapsed:     ${(elapsedMs / 1000).toFixed(2)} s`);
  console.log(`throughput:  ${(total / (elapsedMs / 1000)).toFixed(0)} req/s`);
  console.log(`latency p50: ${percentile(latencies, 50)} ms`);
  console.log(`latency p95: ${percentile(latencies, 95)} ms`);
  console.log(`latency p99: ${percentile(latencies, 99)} ms`);
  console.log(`latency max: ${latencies[total - 1] ?? 0} ms`);

  try {
    const metrics = await fetch(`${options.url}/metrics`).then((r) => r.text());
    const pick = (name: string) => metrics.match(new RegExp(`^${name} (.+)$`, "m"))?.[1] ?? "n/a";
    console.log("── /metrics snapshot ────────────────────");
    console.log(`devices_total:        ${pick("navfleet_devices_total")}`);
    console.log(`mongo_buffer_pending: ${pick("navfleet_mongo_buffer_pending")}`);
    console.log(`ws_connections:       ${pick("navfleet_ws_connections")}`);
  } catch {
    console.log("(could not read /metrics)");
  }

  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
