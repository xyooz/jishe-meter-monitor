import dashboardHtml from "./dashboard.html";

const BASE_URL = "https://yff.jisheyun.com/yzxcx/prod/u/api";
const QUERY_URL = `${BASE_URL}/Customer/Login/GetMeterVistor`;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

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

  if (!response.ok) {
    throw new Error(`查询接口 HTTP ${response.status}`);
  }

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
  if (!env.DB) return;

  const duplicate = await env.DB.prepare(
    `SELECT 1 FROM meter_readings
     WHERE read_time = ? AND kwh = ? AND balance = ?
     ORDER BY id DESC LIMIT 1`
  )
    .bind(status.lastRead || "", status.kwh, status.balance)
    .first();
  if (duplicate) return;

  await env.DB.prepare(
    `INSERT INTO meter_readings (read_time, kwh, balance, valve_state, source)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      status.lastRead || new Date().toISOString(),
      status.kwh,
      status.balance,
      status.valveState ? 1 : 0,
      source
    )
    .run();
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
     ORDER BY datetime(created_at) ASC`
  )
    .bind(`-${safeDays} days`)
    .all();
  return result.results || [];
}

async function getCalendar(env, requestedMonth) {
  if (!env.DB) return { month: requestedMonth, days: [] };
  const currentMonth = new Date(Date.now() + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 7);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth || "")
    ? requestedMonth
    : currentMonth;
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(year, monthNumber, 1))
    .toISOString()
    .slice(0, 10);

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
              CASE WHEN previous_balance IS NOT NULL AND balance <= previous_balance
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

function summarize(rows) {
  if (!rows.length) {
    return {
      todayKwh: 0,
      todayCost: 0,
      last24hKwh: 0,
      avgDailyKwh7d: 0,
      estimatedDaysLeft: null,
      pricePerKwh: null,
    };
  }

  const sorted = [...rows].sort(
    (a, b) => new Date(a.collected_at).getTime() - new Date(b.collected_at).getTime()
  );
  const latest = sorted.at(-1);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  const firstToday = sorted.find((r) => new Date(r.collected_at) >= today) || latest;
  const first24h = [...sorted].reverse().find((r) => new Date(r.collected_at) <= dayAgo) || sorted[0];
  const first7d = [...sorted].reverse().find((r) => new Date(r.collected_at) <= weekAgo) || sorted[0];

  const todayKwh = Math.max(0, Number(latest.kwh) - Number(firstToday.kwh));
  const last24hKwh = Math.max(0, Number(latest.kwh) - Number(first24h.kwh));
  const sevenDayKwh = Math.max(0, Number(latest.kwh) - Number(first7d.kwh));
  const avgDailyKwh7d = sevenDayKwh / 7;

  const kwhDelta = Number(latest.kwh) - Number(sorted[0].kwh);
  const balanceDelta = Number(sorted[0].balance) - Number(latest.balance);
  const pricePerKwh = kwhDelta > 0 && balanceDelta >= 0 ? balanceDelta / kwhDelta : null;
  const todayCost = pricePerKwh ? todayKwh * pricePerKwh : 0;
  const avgDailyCost = pricePerKwh ? avgDailyKwh7d * pricePerKwh : 0;
  const estimatedDaysLeft = avgDailyCost > 0 ? Number(latest.balance) / avgDailyCost : null;

  return {
    todayKwh,
    todayCost,
    last24hKwh,
    avgDailyKwh7d,
    estimatedDaysLeft,
    pricePerKwh,
  };
}

async function apiRouter(request, env) {
  const url = new URL(request.url);

  try {
    if (["/api/status", "/api/read", "/api/dashboard"].includes(url.pathname)) {
      const required = ["JISHE_PHONE"];
      if (required.some(name => !env[name])) return json({ok:false,error:"请先在 Cloudflare 配置电表 Secrets。"},503);
    }
    if (url.pathname === "/api/status" && request.method === "GET") {
      return json({ ok: true, data: await latestStatus(env, "query") });
    }

    if (url.pathname === "/api/read" && request.method === "POST") {
      const status = await latestStatus(env, "query");
      const rows = await getHistory(env, 7);
      return json({
        ok: true,
        data: {
          status,
          history: rows,
          summary: summarize(rows),
        },
      });
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      const days = url.searchParams.get("days") || "7";
      const rows = await getHistory(env, days);
      return json({ ok: true, data: rows });
    }

    if (url.pathname === "/api/calendar" && request.method === "GET") {
      return json({
        ok: true,
        data: await getCalendar(env, url.searchParams.get("month")),
      });
    }

    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      const days = url.searchParams.get("days") || "7";
      const status = await latestStatus(env, "dashboard");
      const rows = await getHistory(env, days);
      return json({
        ok: true,
        data: {
          status,
          history: rows,
          summary: summarize(rows),
        },
      });
    }

    return null;
  } catch (error) {
    return json({ ok: false, error: "电表服务暂时不可用，请稍后重试。" }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (!env.DASHBOARD_PASSWORD) return new Response("请先在 Cloudflare Secrets 配置 DASHBOARD_PASSWORD。", {status:503,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
    let password = "";
    try {
      const auth = request.headers.get("Authorization") || "";
      if (auth.startsWith("Basic ")) {const decoded = atob(auth.slice(6)); password = decoded.slice(decoded.indexOf(":") + 1);}
    } catch {}
    const digest = value => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    const [actual, expected] = await Promise.all([digest(password), digest(env.DASHBOARD_PASSWORD)]);
    if (!crypto.subtle.timingSafeEqual(actual, expected)) return new Response("需要登录", {status:401,headers:{"WWW-Authenticate":'Basic realm="Meter dashboard", charset="UTF-8"',"cache-control":"no-store"}});
    const apiResponse = await apiRouter(request, env);
    if (apiResponse) return apiResponse;
    if (env.ASSETS) return env.ASSETS.fetch(request);
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/index.html") return new Response(request.method === "HEAD" ? null : dashboardHtml, {headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-cache"}});
    return new Response("Not found", {status:404});
  },
};

