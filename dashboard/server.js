/**
 * Meridian Web Dashboard — read-only monitoring UI.
 *
 * Serves a small web page + JSON API that shows wallet balance, open
 * positions (live PnL), closed-position history, agent decisions, lessons,
 * and recent logs. It NEVER signs or sends transactions: there are no
 * deploy / close / swap endpoints here on purpose.
 *
 * Two ways to run it:
 *   1. Embedded (recommended) — set DASHBOARD_ENABLED=true in .env and start
 *      the bot normally (npm start / PM2). Shares the bot's caches and shows
 *      live cycle status (next management / screening run).
 *   2. Standalone — `npm run dashboard`. Reads the same files plus wallet
 *      balance. It does NOT fetch on-chain positions itself (that path writes
 *      state.json, and two processes writing it at once could corrupt it), so
 *      positions come from state.json without live PnL and cycle status is
 *      not available.
 *
 * Env:
 *   DASHBOARD_ENABLED   true to start with the bot (embedded mode only)
 *   DASHBOARD_PORT      default 3030
 *   DASHBOARD_HOST      default 127.0.0.1 (only reachable from the same machine)
 *   DASHBOARD_USER      default "admin"
 *   DASHBOARD_PASSWORD  required when DASHBOARD_HOST is not localhost
 */

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { repoPath } from "../repo-root.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const LIVE_CACHE_MS = 20_000;
const WALLET_CACHE_MS = 60_000;
const LOG_TAIL_BYTES = 256 * 1024;
const MAX_AUTH_FAILS = 10;
const AUTH_WINDOW_MS = 15 * 60_000;

const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

// ─── Small helpers ────────────────────────────────────────────

function dlog(msg) {
  console.log(`[${new Date().toISOString()}] [DASHBOARD] ${msg}`);
}

function readJson(name, fallback) {
  try {
    const file = repoPath(name);
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Strip anything that looks like a secret before it leaves the server. */
function maskSecrets(text) {
  return String(text)
    .replace(/(api[-_]?key=)[^&\s"']+/gi, "$1***")
    .replace(/sk-or-[\w-]+/g, "sk-or-***")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-***")
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "***bot-token***")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g, "***key***");
}

/** Read the last ~256KB of a file and return its last `maxLines` lines. */
function tailFile(file, maxLines) {
  if (!fs.existsSync(file)) return [];
  const { size } = fs.statSync(file);
  const start = Math.max(0, size - LOG_TAIL_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    if (start > 0) lines.shift(); // first line is probably cut in half
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

function latestLogFile(prefix, ext) {
  const dir = repoPath("logs");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(ext)).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

// ─── Live data (positions + wallet) with caching ──────────────

let _liveMods = null;
async function liveModules() {
  if (!_liveMods) {
    const [dlmm, wallet] = await Promise.all([
      import("../tools/dlmm.js"),
      import("../tools/wallet.js"),
    ]);
    _liveMods = { getMyPositions: dlmm.getMyPositions, getWalletBalances: wallet.getWalletBalances };
  }
  return _liveMods;
}

const cache = { positions: null, positionsAt: 0, wallet: null, walletAt: 0 };

async function getLivePositions(force) {
  if (!force && cache.positions && Date.now() - cache.positionsAt < LIVE_CACHE_MS) return cache.positions;
  try {
    const { getMyPositions } = await liveModules();
    const res = await getMyPositions({ silent: true });
    cache.positions = res;
    cache.positionsAt = Date.now();
    return res;
  } catch (err) {
    return { positions: [], total_positions: 0, error: err.message };
  }
}

async function getLiveWallet(force) {
  if (!force && cache.wallet && Date.now() - cache.walletAt < WALLET_CACHE_MS) return cache.wallet;
  try {
    const { getWalletBalances } = await liveModules();
    const res = await getWalletBalances();
    cache.wallet = res;
    cache.walletAt = Date.now();
    return res;
  } catch (err) {
    return { sol: null, total_usd: null, tokens: [], error: err.message };
  }
}

// ─── API builders ─────────────────────────────────────────────

async function loadConfig() {
  try {
    const { config } = await import("../config.js");
    return config;
  } catch {
    return null;
  }
}

async function buildOverview(getStatus, force, fetchLive) {
  const live = fetchLive
    ? await getLivePositions(force)
    : { positions: [], error: "Mode standalone — PnL live hanya tersedia saat dashboard jalan bareng bot (DASHBOARD_ENABLED=true)" };
  const [config, wallet] = await Promise.all([loadConfig(), getLiveWallet(force)]);
  const state = readJson("state.json", { positions: {}, recentEvents: [] });
  const lessons = readJson("lessons.json", { lessons: [], performance: [] });
  const perf = Array.isArray(lessons.performance) ? lessons.performance : [];

  // Merge live on-chain positions with what the agent tracked at deploy time.
  const tracked = state.positions || {};
  const livePositions = Array.isArray(live?.positions) ? live.positions : [];
  const positions = livePositions.map((p) => {
    const t = tracked[p.position] || {};
    return {
      position: p.position,
      pool: p.pool,
      pair: p.pair || t.pool_name || "?",
      in_range: p.in_range,
      active_bin: p.active_bin,
      lower_bin: p.lower_bin,
      upper_bin: p.upper_bin,
      value: num(p.total_value_usd),
      pnl: num(p.pnl_usd),
      pnl_pct: num(p.pnl_pct),
      unclaimed_fees: num(p.unclaimed_fees_usd),
      collected_fees: num(p.collected_fees_usd),
      age_minutes: num(p.age_minutes),
      minutes_out_of_range: num(p.minutes_out_of_range),
      strategy: t.strategy || null,
      amount_sol: num(t.amount_sol),
      deployed_at: t.deployed_at || null,
      peak_pnl_pct: num(t.peak_pnl_pct),
      trailing_active: !!t.trailing_active,
      instruction: p.instruction ?? t.instruction ?? null,
      pnl_suspicious: !!p.pnl_pct_suspicious,
    };
  });

  // If the live fetch failed, fall back to what state.json says is open.
  const usingFallback = !!live?.error && positions.length === 0;
  if (usingFallback) {
    for (const t of Object.values(tracked)) {
      if (t.closed) continue;
      positions.push({
        position: t.position, pool: t.pool, pair: t.pool_name || "?",
        in_range: t.out_of_range_since ? false : null,
        value: null, pnl: null, pnl_pct: null, unclaimed_fees: null, collected_fees: null,
        age_minutes: t.deployed_at ? Math.floor((Date.now() - new Date(t.deployed_at)) / 60000) : null,
        strategy: t.strategy || null, amount_sol: num(t.amount_sol), deployed_at: t.deployed_at || null,
        peak_pnl_pct: num(t.peak_pnl_pct), trailing_active: !!t.trailing_active, instruction: t.instruction || null,
      });
    }
  }

  const closedPnl = perf.reduce((s, x) => s + (num(x.pnl_usd) ?? 0), 0);
  const wins = perf.filter((x) => num(x.pnl_usd) > 0).length;
  const dayAgo = Date.now() - 24 * 3600_000;
  const perf24 = perf.filter((x) => x.recorded_at && new Date(x.recorded_at).getTime() >= dayAgo);

  const status = typeof getStatus === "function" ? safeCall(getStatus) : null;
  const schedule = config?.schedule || {};
  const nextRun = (last, mins) => (last && mins ? new Date(last + mins * 60_000).toISOString() : null);

  return {
    generated_at: new Date().toISOString(),
    mode: {
      embedded: !!status,
      dry_run: process.env.DRY_RUN === "true",
      sol_mode: !!config?.management?.solMode,
    },
    agent: status ? {
      management_busy: !!status.managementBusy,
      screening_busy: !!status.screeningBusy,
      management_last_run: status.managementLastRun ? new Date(status.managementLastRun).toISOString() : null,
      screening_last_run: status.screeningLastRun ? new Date(status.screeningLastRun).toISOString() : null,
      management_next_run: nextRun(status.managementLastRun, schedule.managementIntervalMin),
      screening_next_run: nextRun(status.screeningLastRun, schedule.screeningIntervalMin),
      started_at: status.startedAt ? new Date(status.startedAt).toISOString() : null,
    } : null,
    wallet: {
      address: wallet?.wallet || live?.wallet || null,
      // On error the wallet helper returns zeros — show "—" instead of a fake 0.
      sol: wallet?.error ? null : num(wallet?.sol),
      sol_price: wallet?.error ? null : num(wallet?.sol_price),
      sol_usd: wallet?.error ? null : num(wallet?.sol_usd),
      usdc: wallet?.error ? null : num(wallet?.usdc),
      total_usd: wallet?.error ? null : num(wallet?.total_usd),
      error: wallet?.error || null,
    },
    positions,
    positions_error: live?.error || null,
    positions_fallback: usingFallback,
    stats: {
      open_positions: positions.length,
      open_value: positions.reduce((s, p) => s + (p.value ?? 0), 0),
      open_pnl: positions.reduce((s, p) => s + (p.pnl ?? 0), 0),
      unclaimed_fees: positions.reduce((s, p) => s + (p.unclaimed_fees ?? 0), 0),
      closed_count: perf.length,
      closed_pnl_usd: Math.round(closedPnl * 100) / 100,
      win_rate_pct: perf.length ? Math.round((wins / perf.length) * 100) : null,
      closed_24h: perf24.length,
      closed_pnl_24h_usd: Math.round(perf24.reduce((s, x) => s + (num(x.pnl_usd) ?? 0), 0) * 100) / 100,
      lessons: Array.isArray(lessons.lessons) ? lessons.lessons.length : 0,
    },
    settings: config ? {
      strategy: config.strategy?.strategy,
      max_positions: config.risk?.maxPositions,
      deploy_amount_sol: config.management?.deployAmountSol,
      stop_loss_pct: config.management?.stopLossPct,
      take_profit_pct: config.management?.takeProfitPct,
      trailing_tp: config.management?.trailingTakeProfit,
      oor_wait_min: config.management?.outOfRangeWaitMinutes,
      management_interval_min: schedule.managementIntervalMin,
      screening_interval_min: schedule.screeningIntervalMin,
      management_model: config.llm?.managementModel,
      screening_model: config.llm?.screeningModel,
    } : null,
    recent_events: (state.recentEvents || []).slice(-20).reverse(),
  };
}

function buildHistory() {
  const lessons = readJson("lessons.json", { performance: [] });
  const perf = Array.isArray(lessons.performance) ? lessons.performance : [];
  const rows = perf
    .map((r) => ({
      pool_name: r.pool_name || r.pool || "?",
      pool: r.pool || null,
      position: r.position || null,
      strategy: r.strategy || null,
      amount_sol: num(r.amount_sol),
      pnl_usd: num(r.pnl_usd),
      pnl_pct: num(r.pnl_pct),
      fees_earned_usd: num(r.fees_earned_usd),
      range_efficiency: num(r.range_efficiency),
      minutes_held: num(r.minutes_held),
      close_reason: r.close_reason ? maskSecrets(r.close_reason).slice(0, 200) : null,
      closed_at: r.recorded_at || null,
    }))
    .sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)));
  return { count: rows.length, positions: rows };
}

function buildDecisions(limit) {
  const data = readJson("decision-log.json", { decisions: [] });
  return { decisions: (data.decisions || []).slice(0, limit) };
}

function buildLessons() {
  const data = readJson("lessons.json", { lessons: [] });
  const lessons = (data.lessons || [])
    .map((l) => ({
      id: l.id, rule: l.rule, tags: l.tags || [], pinned: !!l.pinned,
      role: l.role || null, outcome: l.outcome || null, created_at: l.created_at || null,
    }))
    .sort((a, b) => (b.pinned - a.pinned) || String(b.created_at).localeCompare(String(a.created_at)));
  return { lessons };
}

function buildLogs() {
  const agentFile = latestLogFile("agent-", ".log");
  const actionsFile = latestLogFile("actions-", ".jsonl");
  const lines = agentFile ? tailFile(agentFile, 300).map(maskSecrets) : [];
  const actions = (actionsFile ? tailFile(actionsFile, 60) : [])
    .map((line) => {
      try {
        const a = JSON.parse(line);
        return {
          ts: a.timestamp, tool: a.tool, success: !!a.success,
          duration_ms: num(a.duration_ms),
          error: a.error ? maskSecrets(a.error).slice(0, 200) : null,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .reverse();
  return {
    file: agentFile ? path.basename(agentFile) : null,
    lines,
    actions,
  };
}

function safeCall(fn) {
  try { return fn(); } catch { return null; }
}

// ─── Auth ─────────────────────────────────────────────────────

const authFails = new Map(); // ip -> { count, since }

function isBlocked(ip) {
  const rec = authFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.since > AUTH_WINDOW_MS) { authFails.delete(ip); return false; }
  return rec.count >= MAX_AUTH_FAILS;
}

function noteFail(ip) {
  const rec = authFails.get(ip);
  if (!rec || Date.now() - rec.since > AUTH_WINDOW_MS) authFails.set(ip, { count: 1, since: Date.now() });
  else rec.count++;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkAuth(req, user, pass) {
  if (!pass) return true; // localhost-only without password
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return safeEqual(decoded.slice(0, idx), user) && safeEqual(decoded.slice(idx + 1), pass);
}

// ─── HTTP server ──────────────────────────────────────────────

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

let _server = null;

export function startDashboard({ getStatus = null, livePositions = true } = {}) {
  if (_server) return _server;

  const port = Number(process.env.DASHBOARD_PORT || 3030);
  const host = (process.env.DASHBOARD_HOST || "127.0.0.1").trim();
  const user = (process.env.DASHBOARD_USER || "admin").trim();
  const pass = (process.env.DASHBOARD_PASSWORD || "").trim();
  const isLocal = ["127.0.0.1", "localhost", "::1"].includes(host);

  if (!isLocal && pass.length < 10) {
    dlog(`NOT started: DASHBOARD_HOST=${host} is reachable from outside, so DASHBOARD_PASSWORD (min 10 chars) is required.`);
    return null;
  }

  _server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress || "?";
    try {
      if (req.method !== "GET") return send(res, 405, { error: "Read-only dashboard" });

      if (isBlocked(ip)) return send(res, 429, { error: "Too many failed logins. Try again in 15 minutes." });
      if (!checkAuth(req, user, pass)) {
        if (req.headers.authorization) noteFail(ip);
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Meridian Dashboard", charset="UTF-8"', ...SECURITY_HEADERS });
        return res.end("Login required");
      }

      const url = new URL(req.url, "http://localhost");
      const force = url.searchParams.get("refresh") === "1";

      if (STATIC_FILES[url.pathname]) {
        const { file, type } = STATIC_FILES[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), type);
      }

      switch (url.pathname) {
        case "/api/overview":  return send(res, 200, await buildOverview(getStatus, force, livePositions));
        case "/api/history":   return send(res, 200, buildHistory());
        case "/api/decisions": return send(res, 200, buildDecisions(Math.min(100, Number(url.searchParams.get("limit")) || 50)));
        case "/api/lessons":   return send(res, 200, buildLessons());
        case "/api/logs":      return send(res, 200, buildLogs());
        case "/healthz":       return send(res, 200, { ok: true });
        default:               return send(res, 404, { error: "Not found" });
      }
    } catch (err) {
      dlog(`Request error ${req.url}: ${err.message}`);
      return send(res, 500, { error: "Internal error" });
    }
  });

  _server.on("error", (err) => {
    dlog(`Server error: ${err.message}${err.code === "EADDRINUSE" ? ` — port ${port} already in use, set DASHBOARD_PORT to another port` : ""}`);
    _server = null;
  });

  _server.listen(port, host, () => {
    dlog(`Web dashboard running at http://${host === "0.0.0.0" ? "<server-ip>" : host}:${port} ${pass ? "(password protected)" : "(no password — local only)"}`);
  });

  return _server;
}

// ─── Standalone mode: `node dashboard/server.js` ─────────────

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await import("../envcrypt.js");
  startDashboard({ livePositions: false });
}
