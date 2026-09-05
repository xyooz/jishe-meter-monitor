import worker from "./worker.js";

const SHANGHAI_TZ = "Asia/Shanghai";
const DATA_START_AT = "2026-09-06 00:00:00";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

function constantTimeEqual(a = "", b = "") {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  const length = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (aa[i % Math.max(aa.length, 1)] || 0) ^ (bb[i % Math.max(bb.length, 1)] || 0);
  }
  return diff === 0;
}

function isDashboardAuthorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return false;
  try {
    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Basic ")) return false;
    const decoded = atob(auth.slice(6));
    const password = decoded.slice(decoded.indexOf(":") + 1);
    return constantTimeEqual(password, env.DASHBOARD_PASSWORD);
  } catch {
    return false;
  }
}

function unauthorized(env) {
  if (!env.DASHBOARD_PASSWORD) {
    return new Response("请先在 Cloudflare Secrets 配置 DASHBOARD_PASSWORD。", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response("需要登录", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Meter dashboard", charset="UTF-8"',
      "cache-control": "no-store",
    },
  });
}

function shanghaiDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function getHistory(env, days = 7) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const result = await env.DB.prepare(
    `SELECT id, read_time, kwh, balance, valve_state, source,
            replace(created_at, ' ', 'T') || 'Z' AS collected_at
     FROM meter_readings
     WHERE datetime(created_at) >= datetime('now', ?)
       AND read_time >= ?
     ORDER BY datetime(created_at) ASC, id ASC`
  )
    .bind(`-${safeDays} days`, DATA_START_AT)
    .all();
  return result.results || [];
}

async function getLatestStatus(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  const row = await env.DB.prepare(
    `SELECT read_time, kwh, balance, valve_state,
            replace(created_at, ' ', 'T') || 'Z' AS collected_at
     FROM meter_readings
     WHERE read_time >= ?
     ORDER BY datetime(read_time) DESC, id DESC
     LIMIT 1`
  )
    .bind(DATA_START_AT)
    .first();

  if (!row) return null;
  return {
    balance: Number(row.balance),
    kwh: Number(row.kwh),
    lastRead: row.read_time || null,
    valveState: Boolean(row.valve_state),
    collectedAt: row.collected_at || null,
  };
}

function summarize(rows) {
  if (rows.length < 2) {
    return {
      todayKwh: 0,
      todayCost: 0,
      last24hKwh: 0,
      avgDailyKwh7d: 0,
      estimatedDaysLeft: null,
      pricePerKwh: null,
      sampledDays7d: rows.length ? 1 : 0,
    };
  }

  const sorted = [...rows].sort(
    (a, b) => new Date(a.collected_at).getTime() - new Date(b.collected_at).getTime()
  );
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const todayKey = shanghaiDateKey(now);

  let todayKwh = 0;
  let last24hKwh = 0;
  let sevenDayKwh = 0;
  const sampledDays = new Set();
  const unitPrices = [];

  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    const currentTime = new Date(current.collected_at);
    const kwhDelta = Number(current.kwh) - Number(previous.kwh);
    const balanceDelta = Number(previous.balance) - Number(current.balance);

    if (!Number.isFinite(kwhDelta) || kwhDelta < 0) continue;
    const currentDay = shanghaiDateKey(currentTime);

    if (currentDay === todayKey) todayKwh += kwhDelta;
    if (currentTime >= dayAgo) last24hKwh += kwhDelta;
    if (currentTime >= weekAgo) {
      sevenDayKwh += kwhDelta;
      sampledDays.add(currentDay);
    }

    if (kwhDelta > 0 && balanceDelta > 0) {
      const price = balanceDelta / kwhDelta;
      if (Number.isFinite(price) && price > 0.05 && price < 10) unitPrices.push(price);
    }
  }

  const sampledDays7d = Math.max(sampledDays.size, 1);
  const avgDailyKwh7d = sevenDayKwh / sampledDays7d;
  const pricePerKwh = median(unitPrices);
  const todayCost = pricePerKwh == null ? 0 : todayKwh * pricePerKwh;
  const avgDailyCost = pricePerKwh == null ? 0 : avgDailyKwh7d * pricePerKwh;
  const latest = sorted.at(-1);
  const estimatedDaysLeft = avgDailyCost > 0 ? Number(latest.balance) / avgDailyCost : null;

  return {
    todayKwh,
    todayCost,
    last24hKwh,
    avgDailyKwh7d,
    estimatedDaysLeft,
    pricePerKwh,
    sampledDays7d,
  };
}

async function serveD1Api(request, env, url) {
  if (!isDashboardAuthorized(request, env)) return unauthorized(env);

  try {
    if (url.pathname === "/api/status" && request.method === "GET") {
      const status = await getLatestStatus(env);
      return json({ ok: true, data: status, dataStartAt: DATA_START_AT, source: "d1" });
    }

    if (url.pathname === "/api/read" && request.method === "POST") {
      const [status, rows] = await Promise.all([getLatestStatus(env), getHistory(env, 7)]);
      return json({
        ok: true,
        data: { status, history: rows, summary: summarize(rows), dataStartAt: DATA_START_AT },
        source: "d1",
      });
    }

    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      const days = url.searchParams.get("days") || "7";
      const [status, rows] = await Promise.all([getLatestStatus(env), getHistory(env, days)]);
      return json({
        ok: true,
        data: { status, history: rows, summary: summarize(rows), dataStartAt: DATA_START_AT },
        source: "d1",
      });
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "dashboard_d1", ok: false, error: String(error?.message || error) }));
    return json({ ok: false, error: "历史数据暂时不可用，请稍后重试。" }, 500);
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (["/api/status", "/api/read", "/api/dashboard"].includes(url.pathname)) {
      const response = await serveD1Api(request, env, url);
      if (response) return response;
    }
    return worker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return worker.scheduled(event, env, ctx);
  },
};
