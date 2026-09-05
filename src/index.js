const BASE_URL = "https://yff.jisheyun.com/yzxcx/prod/u/api";
const QUERY_URL = `${BASE_URL}/Customer/Login/GetMeterVistor`;
const READ_URL = `${BASE_URL}/kwh/ammter/Reading`;

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

async function triggerRead(env) {
  const body = {
    customerId: Number(env.JISHE_CUSTOMER_ID),
    roomId: Number(env.JISHE_ROOM_ID),
    meterId: Number(env.JISHE_METER_ID),
    phoneNumber: env.JISHE_PHONE,
    sign: env.JISHE_SIGN,
  };

  const response = await fetch(READ_URL, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/json",
      Token: "",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`抄读接口 HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.Code) throw new Error(payload?.Message || "抄读失败");
  return payload;
}

async function saveReading(env, status, source) {
  if (!env.DB) return;

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
    `SELECT id, read_time, kwh, balance, valve_state, source
     FROM meter_readings
     WHERE datetime(read_time) >= datetime('now', ?)
     ORDER BY datetime(read_time) ASC`
  )
    .bind(`-${safeDays} days`)
    .all();
  return result.results || [];
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
    (a, b) => new Date(a.read_time).getTime() - new Date(b.read_time).getTime()
  );
  const latest = sorted.at(-1);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  const firstToday = sorted.find((r) => new Date(r.read_time) >= today) || latest;
  const first24h = [...sorted].reverse().find((r) => new Date(r.read_time) <= dayAgo) || sorted[0];
  const first7d = [...sorted].reverse().find((r) => new Date(r.read_time) <= weekAgo) || sorted[0];

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
    if (url.pathname === "/api/status" && request.method === "GET") {
      return json({ ok: true, data: await latestStatus(env, "query") });
    }

    if (url.pathname === "/api/read" && request.method === "POST") {
      const readResult = await triggerRead(env);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = await latestStatus(env, "manual_read");
      return json({ ok: true, readResult, data: status });
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      const days = url.searchParams.get("days") || "7";
      const rows = await getHistory(env, days);
      return json({ ok: true, data: rows });
    }

    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      const days = url.searchParams.get("days") || "7";
      const [status, rows] = await Promise.all([
        latestStatus(env, "dashboard"),
        getHistory(env, days),
      ]);
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
    return json({ ok: false, error: error.message || String(error) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const apiResponse = await apiRouter(request, env);
    if (apiResponse) return apiResponse;
    return env.ASSETS.fetch(request);
  },
};
