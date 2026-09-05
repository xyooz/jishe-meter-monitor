import app from "./index.js";

const BASE_URL = "https://yff.jisheyun.com/yzxcx/prod/u/api";
const READ_URL = `${BASE_URL}/kwh/ammter/Reading`;
const QUERY_URL = `${BASE_URL}/Customer/Login/GetMeterVistor`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function requireSecret(env, name) {
  const value = env[name];
  if (value == null || String(value).trim() === "") {
    throw new Error(`Missing Cloudflare secret: ${name}`);
  }
  return String(value).trim();
}

function errorMessage(error) {
  if (error?.name === "AbortError") return "request timed out";
  return String(error?.message || error || "unknown error").slice(0, 500);
}

function logCron(payload) {
  console.log(JSON.stringify({ event: "meter_cron", ...payload }));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readMeterOnce(env) {
  const phoneNumber = requireSecret(env, "JISHE_PHONE");
  const customerId = Number(requireSecret(env, "JISHE_CUSTOMER_ID"));
  const roomId = Number(requireSecret(env, "JISHE_ROOM_ID"));
  const meterId = Number(requireSecret(env, "JISHE_METER_ID"));
  const sign = requireSecret(env, "JISHE_SIGN");

  if (![customerId, roomId, meterId].every(Number.isFinite)) {
    throw new Error("Invalid numeric meter identifiers");
  }

  const response = await fetchWithTimeout(
    READ_URL,
    {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        Token: "",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({ customerId, roomId, meterId, phoneNumber, sign }),
    },
    15000
  );

  if (!response.ok) throw new Error(`Meter read HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.Code) throw new Error(payload?.Message || "Meter read failed");
  return payload;
}

async function readMeterWithRetry(env) {
  const retryDelays = [0, 1500, 3000];
  let lastError;

  for (let attempt = 1; attempt <= retryDelays.length; attempt += 1) {
    if (retryDelays[attempt - 1]) await sleep(retryDelays[attempt - 1]);
    try {
      await readMeterOnce(env);
      return attempt;
    } catch (error) {
      lastError = error;
      logCron({ ok: false, stage: "reading", attempt, error: errorMessage(error) });
    }
  }

  const error = new Error(`Reading failed after ${retryDelays.length} attempts: ${errorMessage(lastError)}`);
  error.stage = "reading";
  error.attempt = retryDelays.length;
  throw error;
}

async function queryMeterOnce(env) {
  const phoneNumber = requireSecret(env, "JISHE_PHONE");
  const url = new URL(QUERY_URL);
  url.searchParams.set("phoneNumber", phoneNumber);

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        Token: "",
        "User-Agent": "Mozilla/5.0",
      },
    },
    12000
  );

  if (!response.ok) throw new Error(`Meter query HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.Code) throw new Error(payload?.Message || "Meter query failed");

  const meter = payload?.Data?.[0];
  if (!meter) throw new Error("Meter query returned no data");

  const status = {
    balance: Number(meter.RoomBalance ?? 0),
    kwh: Number(meter.ReadKwh ?? 0),
    lastRead: meter.LastReadTime || null,
    valveState: Boolean(meter.ValveState),
  };

  if (!status.lastRead || !Number.isFinite(status.balance) || !Number.isFinite(status.kwh)) {
    throw new Error("Meter query returned incomplete status");
  }

  return status;
}

async function queryMeterWithRetry(env) {
  const waitsBeforeAttempt = [2000, 3000, 5000];
  let lastError;

  for (let attempt = 1; attempt <= waitsBeforeAttempt.length; attempt += 1) {
    await sleep(waitsBeforeAttempt[attempt - 1]);
    try {
      const status = await queryMeterOnce(env);
      return { status, attempt };
    } catch (error) {
      lastError = error;
      logCron({ ok: false, stage: "query", attempt, error: errorMessage(error) });
    }
  }

  const error = new Error(`Query failed after ${waitsBeforeAttempt.length} attempts: ${errorMessage(lastError)}`);
  error.stage = "query";
  error.attempt = waitsBeforeAttempt.length;
  throw error;
}

async function saveReading(env, status) {
  if (!env.DB) throw new Error("D1 binding DB is missing");

  const duplicate = await env.DB.prepare(
    `SELECT 1 FROM meter_readings
     WHERE read_time = ? AND kwh = ? AND balance = ?
     ORDER BY id DESC LIMIT 1`
  )
    .bind(status.lastRead, status.kwh, status.balance)
    .first();

  if (duplicate) return false;

  await env.DB.prepare(
    `INSERT INTO meter_readings (read_time, kwh, balance, valve_state, source)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(status.lastRead, status.kwh, status.balance, status.valveState ? 1 : 0, "cloudflare-cron-read")
    .run();
  return true;
}

async function saveReadingWithRetry(env, status) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) await sleep(500);
    try {
      const inserted = await saveReading(env, status);
      return { inserted, attempt };
    } catch (error) {
      lastError = error;
      logCron({ ok: false, stage: "d1", attempt, error: errorMessage(error) });
    }
  }

  const error = new Error(`D1 save failed after 2 attempts: ${errorMessage(lastError)}`);
  error.stage = "d1";
  error.attempt = 2;
  throw error;
}

async function runScheduledRead(env) {
  const startedAt = Date.now();
  const readAttempt = await readMeterWithRetry(env);
  const { status, attempt: queryAttempt } = await queryMeterWithRetry(env);
  const { inserted, attempt: d1Attempt } = await saveReadingWithRetry(env, status);

  logCron({
    ok: true,
    stage: "complete",
    readTime: status.lastRead,
    kwh: status.kwh,
    balance: status.balance,
    inserted,
    attempts: {
      reading: readAttempt,
      query: queryAttempt,
      d1: d1Attempt,
    },
    durationMs: Date.now() - startedAt,
  });
}

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(_event, env, _ctx) {
    try {
      await runScheduledRead(env);
    } catch (error) {
      logCron({
        ok: false,
        stage: error?.stage || "unknown",
        attempt: error?.attempt || null,
        error: errorMessage(error),
      });
      throw error;
    }
  },
};
