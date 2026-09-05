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

function errorMessage(error) {
  if (error?.name === "AbortError") return "request timed out";
  return String(error?.message || error || "unknown error").slice(0, 500);
}

function logMeter(event, payload) {
  console.log(JSON.stringify({ event, ...payload }));
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

async function parseMeterResponse(response, stage) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${stage} HTTP ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${stage} returned non-JSON: ${text.slice(0, 200)}`);
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

  const payload = await parseMeterResponse(response, "Meter read");
  if (!payload?.Code) throw new Error(payload?.Message || "Meter read failed");
  return payload;
}

async function readMeterWithRetry(env, eventName) {
  const retryDelays = [0, 1500, 3000];
  let lastError;

  for (let attempt = 1; attempt <= retryDelays.length; attempt += 1) {
    if (retryDelays[attempt - 1]) await sleep(retryDelays[attempt - 1]);
    try {
      await readMeterOnce(env);
      return attempt;
    } catch (error) {
      lastError = error;
      logMeter(eventName, { ok: false, stage: "reading", attempt, error: errorMessage(error) });
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

  const payload = await parseMeterResponse(response, "Meter query");
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

async function queryMeterWithRetry(env, eventName) {
  const waitsBeforeAttempt = [2000, 3000, 5000];
  let lastError;

  for (let attempt = 1; attempt <= waitsBeforeAttempt.length; attempt += 1) {
    await sleep(waitsBeforeAttempt[attempt - 1]);
    try {
      const status = await queryMeterOnce(env);
      return { status, attempt };
    } catch (error) {
      lastError = error;
      logMeter(eventName, { ok: false, stage: "query", attempt, error: errorMessage(error) });
    }
  }

  const error = new Error(`Query failed after ${waitsBeforeAttempt.length} attempts: ${errorMessage(lastError)}`);
  error.stage = "query";
  error.attempt = waitsBeforeAttempt.length;
  throw error;
}

async function saveReading(env, status, source) {
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
    .bind(status.lastRead, status.kwh, status.balance, status.valveState ? 1 : 0, source)
    .run();
  return true;
}

async function saveReadingWithRetry(env, status, source, eventName) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) await sleep(500);
    try {
      const inserted = await saveReading(env, status, source);
      return { inserted, attempt };
    } catch (error) {
      lastError = error;
      logMeter(eventName, { ok: false, stage: "d1", attempt, error: errorMessage(error) });
    }
  }

  const error = new Error(`D1 save failed after 2 attempts: ${errorMessage(lastError)}`);
  error.stage = "d1";
  error.attempt = 2;
  throw error;
}

async function runMeterRead(env, { eventName = "meter_cron", source = "cloudflare-cron-read" } = {}) {
  const startedAt = Date.now();
  const readAttempt = await readMeterWithRetry(env, eventName);
  const { status, attempt: queryAttempt } = await queryMeterWithRetry(env, eventName);
  const { inserted, attempt: d1Attempt } = await saveReadingWithRetry(env, status, source, eventName);

  const result = {
    ok: true,
    stage: "complete",
    readTime: status.lastRead,
    kwh: status.kwh,
    balance: status.balance,
    valveState: status.valveState,
    inserted,
    attempts: {
      reading: readAttempt,
      query: queryAttempt,
      d1: d1Attempt,
    },
    durationMs: Date.now() - startedAt,
  };
  logMeter(eventName, result);
  return result;
}

function manualReadButtonScript() {
  return `<script>
  (() => {
    const actions = document.querySelector('.actions');
    if (!actions || document.getElementById('manualReadBtn')) return;
    const button = document.createElement('button');
    button.id = 'manualReadBtn';
    button.className = 'ghost';
    button.textContent = '立即抄读';
    actions.prepend(button);
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = '正在抄读...';
      try {
        const response = await fetch('/api/manual-read', { method: 'POST', credentials: 'same-origin' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || '手动抄读失败');
        button.textContent = '✓ 抄读成功';
        if (typeof window.showToast === 'function') window.showToast('手动抄读成功');
        setTimeout(() => location.reload(), 700);
      } catch (error) {
        button.textContent = '抄读失败';
        alert(error.message || '手动抄读失败');
        setTimeout(() => { button.disabled = false; button.textContent = original; }, 1500);
      }
    });
  })();
  </script>`;
}

async function injectManualReadButton(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/html")) return response;
  const html = await response.text();
  if (html.includes("manualReadBtn")) return new Response(html, response);
  const body = html.includes("</body>")
    ? html.replace("</body>", `${manualReadButtonScript()}</body>`)
    : `${html}${manualReadButtonScript()}`;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/manual-read" && request.method === "POST") {
      if (!isDashboardAuthorized(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }

      try {
        const result = await runMeterRead(env, {
          eventName: "meter_manual",
          source: "cloudflare-manual-read",
        });
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      } catch (error) {
        logMeter("meter_manual", {
          ok: false,
          stage: error?.stage || "unknown",
          attempt: error?.attempt || null,
          error: errorMessage(error),
        });
        return new Response(JSON.stringify({
          ok: false,
          stage: error?.stage || "unknown",
          error: errorMessage(error),
        }), {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }

    const response = await app.fetch(request, env, ctx);
    return injectManualReadButton(response);
  },

  async scheduled(_event, env, _ctx) {
    try {
      await runMeterRead(env, {
        eventName: "meter_cron",
        source: "cloudflare-cron-read",
      });
    } catch (error) {
      logMeter("meter_cron", {
        ok: false,
        stage: error?.stage || "unknown",
        attempt: error?.attempt || null,
        error: errorMessage(error),
      });
      throw error;
    }
  },
};
