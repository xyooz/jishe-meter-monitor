import app from "./index.js";

const BASE_URL = "https://yff.jisheyun.com/yzxcx/prod/u/api";
const READ_URL = `${BASE_URL}/kwh/ammter/Reading`;
const QUERY_URL = `${BASE_URL}/Customer/Login/GetMeterVistor`;

function requireSecret(env, name) {
  const value = env[name];
  if (value == null || String(value).trim() === "") {
    throw new Error(`Missing Cloudflare secret: ${name}`);
  }
  return String(value).trim();
}

async function readMeter(env) {
  const phoneNumber = requireSecret(env, "JISHE_PHONE");
  const customerId = Number(requireSecret(env, "JISHE_CUSTOMER_ID"));
  const roomId = Number(requireSecret(env, "JISHE_ROOM_ID"));
  const meterId = Number(requireSecret(env, "JISHE_METER_ID"));
  const sign = requireSecret(env, "JISHE_SIGN");

  if (![customerId, roomId, meterId].every(Number.isFinite)) {
    throw new Error("Invalid numeric meter identifiers");
  }

  const response = await fetch(READ_URL, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/json",
      Token: "",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({ customerId, roomId, meterId, phoneNumber, sign }),
  });

  if (!response.ok) throw new Error(`Meter read HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.Code) throw new Error(payload?.Message || "Meter read failed");
}

async function queryMeter(env) {
  const phoneNumber = requireSecret(env, "JISHE_PHONE");
  const url = new URL(QUERY_URL);
  url.searchParams.set("phoneNumber", phoneNumber);

  const response = await fetch(url, {
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      Token: "",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) throw new Error(`Meter query HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.Code) throw new Error(payload?.Message || "Meter query failed");

  const meter = payload?.Data?.[0];
  if (!meter) throw new Error("Meter query returned no data");

  return {
    balance: Number(meter.RoomBalance ?? 0),
    kwh: Number(meter.ReadKwh ?? 0),
    lastRead: meter.LastReadTime || null,
    valveState: Boolean(meter.ValveState),
  };
}

async function saveReading(env, status) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  if (!status.lastRead || !Number.isFinite(status.balance) || !Number.isFinite(status.kwh)) {
    throw new Error("Meter status is incomplete");
  }

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runScheduledRead(env) {
  await readMeter(env);
  await sleep(2000);
  const status = await queryMeter(env);
  const inserted = await saveReading(env, status);
  console.log(
    `Scheduled meter read complete: read_time=${status.lastRead}, kwh=${status.kwh}, balance=${status.balance}, inserted=${inserted}`
  );
}

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(_event, env, _ctx) {
    await runScheduledRead(env);
  },
};
