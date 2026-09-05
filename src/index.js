import dashboardHtml from "./dashboard.html";

const BASE_URL = "https://yff.jisheyun.com/yzxcx/prod/u/api";
const QUERY_URL = `${BASE_URL}/Customer/Login/GetMeterVistor`;
const SHANGHAI_TZ = "Asia/Shanghai";

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

async function queryMeter(env) {
  const url = new URL(QUERY_URL);
  url.searchParams.set("phoneNumber", env.JISHE_PHONE);

  const response = await fetch(url, {
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      Token: "",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) throw new Error(`查询接口 HTTP ${response.status}`);

  const payload = await response.json();
  if (!payload?.Code) throw new Error(payload?.Message || "查询失败");

  const meter = payload?.Data?.[0];
  if (!meter) throw new Error("查询成功，但 Data 为空");

  return {
    balance: Number(meter.RoomBalance ?? 0),
    kwh: Number(meter.ReadKwh ?? 0),
    lastRead: meter.LastReadTime || null,
    valveState: Boolean(meter.ValveState),
  };
}

async function saveReading(env, status, source) {
  if (!env.DB) return false;

  const readTime = status.lastRead || new Date().toISOString();
  const duplicate = await env.DB.prepare(
    `SELECT 1 FROM meter_readings
     WHERE read_time = ? AND kwh = ? AND balance = ?
     ORDER BY id DESC LIMIT 1`
  )
    .bind(readTime, status.kwh, status.balance)
    .first();
  if (duplicate) return false;

  await env.DB.prepare(
    `INSERT INTO meter_readings (read_time, kwh, balance, valve_state, source)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(readTime, status.kwh, status.balance, status.valveState ? 1 : 0, source)
    .run();
  return true;
}

async function latestStatus(env, source = "query") {
  const status = await queryMeter(env);
  await saveReading(env, status, source);
  return status;
}

async function getHistory(env, days = 7) {
  if (!env.DB) return [];
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const result = await env.DB.prepare(
    `SELECT id, read_time, kwh, balance, valve_state, source,
            replace(created_at, ' ', 'T') || 'Z' AS collected_at
     FROM meter_readings
     WHERE datetime(created_at) >= datetime('now', ?)
     ORDER BY datetime(created_at) ASC, id ASC`
  )
    .bind(`-${safeDays} days`)
    .all();
  return result.results || [];
}

async function getCalendar(env, requestedMonth) {
  if (!env.DB) return { month: requestedMonth, days: [] };
  const currentMonth = shanghaiDateKey(new Date()).slice(0, 7);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth || "")
    ? requestedMonth
    : currentMonth;
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);

  const result = await env.DB.prepare(
    `WITH ordered AS (
       SELECT id, read_time, kwh, balance,
              LAG(kwh) OVER (ORDER BY datetime(read_time), id) AS previous_kwh,
              LAG(balance) OVER (ORDER BY datetime(read_time), id) AS previous_balance
       FROM meter_readings
     ), daily AS (
       SELECT substr(read_time, 1, 10) AS day,
              CASE WHEN previous_kwh IS NOT NULL AND kwh >= previous_kwh
                   THEN kwh - previous_kwh ELSE 0 END AS kwh_delta,
              CASE WHEN previous_kwh IS NOT NULL AND kwh > previous_kwh
                         AND previous_balance IS NOT NULL AND balance <= previous_balance
                   THEN previous_balance - balance ELSE 0 END AS cost_delta
       FROM ordered
       WHERE read_time >= ? AND read_time < ?
     )
     SELECT day,
            ROUND(SUM(kwh_delta), 3) AS kwh,
            ROUND(SUM(cost_delta), 3) AS cost,
            COUNT(*) AS samples
     FROM daily
     GROUP BY day
     ORDER BY day ASC`
  )
    .bind(start, end)
    .all();

  return { month, days: result.results || [] };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

async function ingestReading(request, env) {
  if (!env.INGEST_TOKEN) return json({ ok: false, error: "INGEST_TOKEN 未配置" }, 503);
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!constantTimeEqual(token, env.INGEST_TOKEN)) return json({ ok: false, error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "请求体必须是 JSON" }, 400);
  }

  const status = {
    balance: Number(body.balance),
    kwh: Number(body.kwh),
    lastRead: body.last_read || body.lastRead || null,
    valveState: Boolean(body.valve ?? body.valveState),
  };

  if (!Number.isFinite(status.balance) || !Number.isFinite(status.kwh) || !status.lastRead) {
    return json({ ok: false, error: "缺少有效的 balance、kwh 或 last_read" }, 400);
  }

  const inserted = await saveReading(env, status, "github-scheduled-read");
  return json({ ok: true, inserted, data: status });
}

async function apiRouter(request, env) {
  const url = new URL(request.url);

  try {
    if (["/api/status", "/api/read", "/api/dashboard"].includes(url.pathname)) {
      if (!env.JISHE_PHONE) return json({ ok: false, error: "请先在 Cloudflare 配置 JISHE_PHONE。" }, 503);
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return json({ ok: true, data: await latestStatus(env, "query") });
    }

    if (url.pathname === "/api/read" && request.method === "POST") {
      const status = await latestStatus(env, "query");
      const rows = await getHistory(env, 7);
      return json({ ok: true, data: { status, history: rows, summary: summarize(rows) } });
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      const days = url.searchParams.get("days") || "7";
      return json({ ok: true, data: await getHistory(env, days) });
    }

    if (url.pathname === "/api/calendar" && request.method === "GET") {
      return json({ ok: true, data: await getCalendar(env, url.searchParams.get("month")) });
    }

    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      const days = url.searchParams.get("days") || "7";
      const status = await latestStatus(env, "dashboard");
      const rows = await getHistory(env, days);
      return json({ ok: true, data: { status, history: rows, summary: summarize(rows) } });
    }

    return null;
  } catch {
    return json({ ok: false, error: "电表服务暂时不可用，请稍后重试。" }, 500);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    if (path === "/api/ingest" && request.method === "POST") {
      return ingestReading(request, env);
    }

    if (!env.DASHBOARD_PASSWORD) {
      return new Response("请先在 Cloudflare Secrets 配置 DASHBOARD_PASSWORD。", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    let password = "";
    try {
      const auth = request.headers.get("Authorization") || "";
      if (auth.startsWith("Basic ")) {
        const decoded = atob(auth.slice(6));
        password = decoded.slice(decoded.indexOf(":") + 1);
      }
    } catch {}

    if (!constantTimeEqual(password, env.DASHBOARD_PASSWORD)) {
      return new Response("需要登录", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Meter dashboard", charset="UTF-8"',
          "cache-control": "no-store",
        },
      });
    }

    const apiResponse = await apiRouter(request, env);
    if (apiResponse) return apiResponse;
    if (env.ASSETS) return env.ASSETS.fetch(request);
    if (path === "/" || path === "/index.html") {
      return new Response(request.method === "HEAD" ? null : dashboardHtml, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
