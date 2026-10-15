/* Meridian Monitor — front-end (read-only). No external dependencies. */
(() => {
  "use strict";

  const REFRESH_MS = 30_000;
  const $ = (sel) => document.querySelector(sel);
  const state = { tab: "overview", overview: null, history: null, decisions: null, lessons: null, logs: null, dfilter: "all", loading: false };

  // ─── Formatting helpers ─────────────────────────────────
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const cur = () => (state.overview?.mode?.sol_mode ? "◎" : "$");

  function money(v, { sign = false, unit = cur(), dp } = {}) {
    if (!isNum(v)) return "—";
    const abs = Math.abs(v);
    const d = dp ?? (unit === "◎" ? (abs < 1 ? 4 : 3) : abs < 10 ? 2 : abs < 1000 ? 2 : 0);
    const s = abs.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    const pre = v < 0 ? "-" : sign && v > 0 ? "+" : "";
    return unit === "◎" ? `${pre}${s} ◎` : `${pre}$${s}`;
  }
  const usd = (v, o = {}) => money(v, { ...o, unit: "$" });
  const pct = (v, sign = true) => (isNum(v) ? `${sign && v > 0 ? "+" : ""}${v.toFixed(2)}%` : "—");
  const cls = (v) => (isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");
  const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "—");

  function dur(mins) {
    if (!isNum(mins)) return "—";
    if (mins < 60) return `${Math.round(mins)}m`;
    const h = Math.floor(mins / 60);
    if (h < 48) return `${h}j ${Math.round(mins % 60)}m`;
    return `${Math.floor(h / 24)}h ${h % 24}j`;
  }
  function ago(iso) {
    if (!iso) return "—";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "baru saja";
    if (s < 3600) return `${Math.floor(s / 60)}m lalu`;
    if (s < 86400) return `${Math.floor(s / 3600)}j lalu`;
    return `${Math.floor(s / 86400)}h lalu`;
  }
  function time(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function countdown(iso) {
    if (!iso) return "—";
    const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    if (s <= 0) return "sebentar lagi";
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  }

  // ─── Data loading ───────────────────────────────────────
  async function api(path) {
    const res = await fetch(path, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  }

  async function load(force = false) {
    if (state.loading) return;
    state.loading = true;
    const btn = $("#refresh-btn");
    btn.disabled = true;
    try {
      const q = force ? "?refresh=1" : "";
      const [overview, history, decisions, lessons, logs] = await Promise.all([
        api(`/api/overview${q}`),
        api("/api/history"),
        api("/api/decisions?limit=100"),
        api("/api/lessons"),
        api("/api/logs"),
      ]);
      Object.assign(state, { overview, history, decisions, lessons, logs });
      hideError();
      renderAll();
    } catch (err) {
      showError(`Gagal ambil data: ${err.message}. Cek apakah bot masih jalan.`);
    } finally {
      state.loading = false;
      btn.disabled = false;
    }
  }

  function showError(msg) { const b = $("#error-banner"); b.textContent = msg; b.className = "banner"; b.hidden = false; }
  function hideError() { $("#error-banner").hidden = true; }

  // ─── Rendering ──────────────────────────────────────────
  function renderAll() {
    renderHeader();
    renderOverview();
    renderPositions();
    renderHistory();
    renderDecisions();
    renderLessons();
    renderLogs();
  }

  function renderHeader() {
    const o = state.overview;
    $("#wallet-addr").textContent = o.wallet.address ? `Wallet ${short(o.wallet.address)}` : "Wallet belum terbaca";
    const badge = $("#mode-badge");
    badge.textContent = o.mode.dry_run ? "DRY RUN" : "LIVE";
    badge.className = `badge ${o.mode.dry_run ? "dry" : "live"}`;
    $("#updated").textContent = `Update ${new Date(o.generated_at).toLocaleTimeString("id-ID")} · auto 30 dtk`;
    tickCycles();
  }

  function tickCycles() {
    const a = state.overview?.agent;
    const set = (id, busy, next, last) => {
      const el = $(id);
      const dot = el.querySelector(".dot");
      const val = el.querySelector(".val");
      if (!a) { dot.className = "dot"; val.textContent = "status hanya tersedia di mode embedded"; return; }
      dot.className = `dot ${busy ? "busy" : "idle"}`;
      val.textContent = busy ? "sedang jalan…" : next ? `berikutnya ${countdown(next)}` : last ? `terakhir ${ago(last)}` : "menunggu";
    };
    set("#cycle-manage", a?.management_busy, a?.management_next_run, a?.management_last_run);
    set("#cycle-screen", a?.screening_busy, a?.screening_next_run, a?.screening_last_run);
    if (!a) $("#cycle-screen").hidden = true;
  }

  function kpi(k, v, s = "", vClass = "") {
    return `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${vClass}">${v}</div><div class="s">${s}</div></div>`;
  }

  function renderOverview() {
    const o = state.overview;
    const st = o.stats;
    const w = o.wallet;
    $("#kpis").innerHTML = [
      kpi("Saldo wallet", isNum(w.sol) ? `${w.sol.toFixed(3)} SOL` : "—", w.error ? esc(w.error) : `${usd(w.sol_usd)} · total ${usd(w.total_usd)}`),
      kpi("Posisi terbuka", `${st.open_positions}`, `nilai ${money(st.open_value)}`),
      kpi("PnL berjalan", money(st.open_pnl, { sign: true }), `fee belum klaim ${money(st.unclaimed_fees)}`, cls(st.open_pnl)),
      kpi("PnL 24 jam", usd(st.closed_pnl_24h_usd, { sign: true }), `${st.closed_24h} posisi ditutup`, cls(st.closed_pnl_24h_usd)),
      kpi("PnL realized total", usd(st.closed_pnl_usd, { sign: true }), `${st.closed_count} posisi ditutup`, cls(st.closed_pnl_usd)),
      kpi("Win rate", isNum(st.win_rate_pct) ? `${st.win_rate_pct}%` : "—", st.closed_count ? `dari ${st.closed_count} posisi` : "belum ada data"),
      kpi("Harga SOL", usd(w.sol_price), "via Helius"),
      kpi("Lessons", `${st.lessons}`, "pelajaran tersimpan"),
    ].join("");

    // mini positions
    const mp = $("#overview-positions");
    if (!o.positions.length) {
      mp.innerHTML = `<div class="empty">${o.positions_error ? `Data posisi gagal dimuat: ${esc(o.positions_error)}` : "Tidak ada posisi terbuka."}</div>`;
    } else {
      mp.innerHTML = o.positions.map((p) => `
        <div class="mini-pos">
          <div class="l"><span>${esc(p.pair)}</span>${rangePill(p)}</div>
          <div class="r"><div class="${cls(p.pnl)}">${money(p.pnl, { sign: true })} <span class="small">${pct(p.pnl_pct)}</span></div>
          <div class="small muted">${money(p.value)} · ${dur(p.age_minutes)}</div></div>
        </div>`).join("");
    }

    // events
    const ev = $("#events");
    ev.innerHTML = o.recent_events.length ? o.recent_events.map((e) => `
      <li><span class="t">${esc(time(e.ts))}</span>
      <span><span class="tag ${esc(e.action)}">${esc(e.action)}</span>${esc(e.pool_name || short(e.position))}</span>
      ${e.reason ? `<span class="reason">${esc(e.reason)}</span>` : ""}</li>`).join("")
      : `<li class="empty">Belum ada aktivitas.</li>`;

    // settings
    const s = o.settings || {};
    const rows = [
      ["Strategi", s.strategy], ["Maks posisi", s.max_positions], ["Deploy / posisi", isNum(s.deploy_amount_sol) ? `${s.deploy_amount_sol} SOL` : "—"],
      ["Stop loss", isNum(s.stop_loss_pct) ? `${s.stop_loss_pct}%` : "—"], ["Take profit", isNum(s.take_profit_pct) ? `${s.take_profit_pct}%` : "—"],
      ["Trailing TP", s.trailing_tp ? "aktif" : "mati"], ["Tunggu OOR", isNum(s.oor_wait_min) ? `${s.oor_wait_min} mnt` : "—"],
      ["Interval mgmt / screen", `${s.management_interval_min ?? "—"} / ${s.screening_interval_min ?? "—"} mnt`],
      ["Model management", s.management_model], ["Model screening", s.screening_model],
    ];
    $("#settings").innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v ?? "—")}</dd></div>`).join("");
  }

  function rangePill(p) {
    if (p.in_range === true) return `<span class="pill in">in range</span>`;
    if (p.in_range === false) return `<span class="pill out">out of range${isNum(p.minutes_out_of_range) && p.minutes_out_of_range > 0 ? ` ${dur(p.minutes_out_of_range)}` : ""}</span>`;
    return `<span class="pill">?</span>`;
  }

  function rangeBar(p) {
    const { lower_bin: lo, upper_bin: hi, active_bin: ab } = p;
    if (![lo, hi, ab].every(isNum) || hi <= lo) return "";
    const min = Math.min(lo, ab), max = Math.max(hi, ab);
    const span = Math.max(1, max - min);
    const pad = span * 0.08;
    const toPct = (v) => ((v - (min - pad)) / (span + 2 * pad)) * 100;
    return `<div><div class="range" title="Bin ${lo} – ${hi}, aktif ${ab}">
        <div class="fill" style="left:${toPct(lo)}%;width:${toPct(hi) - toPct(lo)}%"></div>
        <div class="mark" style="left:${toPct(ab)}%"></div></div>
      <div class="range-lbl"><span>${lo}</span><span>aktif ${ab}</span><span>${hi}</span></div></div>`;
  }

  function renderPositions() {
    const o = state.overview;
    const note = $("#positions-note");
    note.innerHTML = o.positions_fallback
      ? `<div class="banner info">Data live gagal (${esc(o.positions_error)}). Menampilkan posisi dari state.json tanpa PnL.</div>` : "";
    const list = $("#positions-list");
    if (!o.positions.length) { list.innerHTML = `<div class="empty">Tidak ada posisi terbuka.</div>`; return; }
    list.innerHTML = o.positions.map((p) => `
      <article class="pos ${p.in_range === false ? "oor" : ""}">
        <div class="pos-h">
          <div><div class="pair">${esc(p.pair)}</div><div class="small muted">${esc(p.strategy || "—")} · ${isNum(p.amount_sol) ? `${p.amount_sol} SOL` : "—"}</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${rangePill(p)}${p.trailing_active ? `<span class="pill trail">trailing TP</span>` : ""}</div>
        </div>
        <div class="pos-pnl"><span class="big ${cls(p.pnl)}">${money(p.pnl, { sign: true })}</span><span class="${cls(p.pnl_pct)}">${pct(p.pnl_pct)}</span></div>
        <div class="metrics">
          <div><div class="k">Nilai</div><div class="v">${money(p.value)}</div></div>
          <div><div class="k">Fee belum klaim</div><div class="v">${money(p.unclaimed_fees)}</div></div>
          <div><div class="k">Fee diklaim</div><div class="v">${money(p.collected_fees)}</div></div>
          <div><div class="k">Umur</div><div class="v">${dur(p.age_minutes)}</div></div>
          <div><div class="k">Peak PnL</div><div class="v">${pct(p.peak_pnl_pct)}</div></div>
          <div><div class="k">Deploy</div><div class="v">${esc(time(p.deployed_at))}</div></div>
        </div>
        ${rangeBar(p)}
        ${p.instruction ? `<div class="note">Instruksi: ${esc(p.instruction)}</div>` : ""}
        ${p.pnl_suspicious ? `<div class="note">PnL dari API terlihat tidak wajar — cek manual.</div>` : ""}
        <div class="pos-foot">
          <span class="num">${esc(short(p.position))}</span>
          <span>${p.pool ? `<a href="https://app.meteora.ag/dlmm/${encodeURIComponent(p.pool)}" target="_blank" rel="noopener noreferrer">Meteora ↗</a> · ` : ""}<a href="https://solscan.io/account/${encodeURIComponent(p.position)}" target="_blank" rel="noopener noreferrer">Solscan ↗</a></span>
        </div>
      </article>`).join("");
  }

  function filteredHistory() {
    const hrs = Number($("#history-range").value);
    const rows = state.history?.positions || [];
    if (!hrs) return rows;
    const cutoff = Date.now() - hrs * 3600_000;
    return rows.filter((r) => r.closed_at && new Date(r.closed_at).getTime() >= cutoff);
  }

  function renderHistory() {
    const rows = filteredHistory();
    const total = rows.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
    const wins = rows.filter((r) => r.pnl_usd > 0).length;
    $("#history-summary").innerHTML = rows.length
      ? `<span class="${cls(total)}">${usd(total, { sign: true })}</span> · win ${Math.round((wins / rows.length) * 100)}% · ${rows.length} posisi` : "";
    renderChart(rows);

    const tbl = $("#history-table");
    if (!rows.length) { tbl.innerHTML = `<tr><td class="empty">Belum ada posisi ditutup di rentang ini.</td></tr>`; return; }
    tbl.innerHTML = `<thead><tr><th>Ditutup</th><th>Pool</th><th class="n">PnL</th><th class="n">PnL %</th><th class="n">Fee</th><th class="n">Lama</th><th class="n">In-range</th><th>Alasan close</th></tr></thead>
      <tbody>${rows.slice().reverse().map((r) => `<tr>
        <td class="num small">${esc(time(r.closed_at))}</td>
        <td>${esc(r.pool_name)}<div class="small muted">${esc(r.strategy || "")}</div></td>
        <td class="n ${cls(r.pnl_usd)}">${usd(r.pnl_usd, { sign: true })}</td>
        <td class="n ${cls(r.pnl_pct)}">${pct(r.pnl_pct)}</td>
        <td class="n">${usd(r.fees_earned_usd)}</td>
        <td class="n">${dur(r.minutes_held)}</td>
        <td class="n">${isNum(r.range_efficiency) ? `${r.range_efficiency}%` : "—"}</td>
        <td class="reason">${esc(r.close_reason || "—")}</td></tr>`).join("")}</tbody>`;
  }

  function renderChart(rows) {
    const el = $("#pnl-chart");
    const pts = [];
    let acc = 0;
    for (const r of rows) { if (!r.closed_at) continue; acc += r.pnl_usd ?? 0; pts.push({ t: new Date(r.closed_at).getTime(), v: acc }); }
    if (pts.length < 2) { el.innerHTML = `<div class="empty">Grafik muncul setelah minimal 2 posisi ditutup.</div>`; return; }

    const W = 800, H = 220, L = 56, R = 12, T = 12, B = 24;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    const vals = pts.map((p) => p.v).concat(0);
    let vMin = Math.min(...vals), vMax = Math.max(...vals);
    if (vMax === vMin) { vMax += 1; vMin -= 1; }
    const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (v - vMin) / (vMax - vMin)) * (H - T - B);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1].v;
    const tone = last >= 0 ? "pos" : "neg";
    const area = `${d} L${x(t1).toFixed(1)},${y(0).toFixed(1)} L${x(t0).toFixed(1)},${y(0).toFixed(1)} Z`;
    const ticks = [vMax, (vMax + vMin) / 2, vMin];
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Grafik PnL kumulatif">
      ${ticks.map((v) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(usd(v, { dp: Math.abs(v) < 100 ? 2 : 0 }))}</text>`).join("")}
      <line class="zero" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"></line>
      <path class="area ${tone}" d="${area}"></path>
      <path class="line ${tone}" d="${d}"></path>
      <text x="${L}" y="${H - 6}">${esc(time(new Date(t0).toISOString()))}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(time(new Date(t1).toISOString()))}</text>
    </svg>`;
  }

  function renderDecisions() {
    const all = state.decisions?.decisions || [];
    const f = state.dfilter;
    const rows = all.filter((d) => f === "all" || (f === "skip" ? ["skip", "no_deploy"].includes(d.type) : d.type === f));
    const list = $("#decisions-list");
    if (!rows.length) { list.innerHTML = `<div class="empty">Belum ada keputusan tercatat.</div>`; return; }
    list.innerHTML = rows.map((d) => `
      <article class="dec">
        <div class="dec-h"><span><span class="tag ${esc(d.type)}">${esc(d.type)}</span><span class="who">${esc(d.pool_name || "—")}</span></span>
        <span class="small muted">${esc(d.actor)} · ${esc(time(d.ts))}</span></div>
        ${d.summary ? `<p>${esc(d.summary)}</p>` : ""}
        ${d.reason ? `<p class="reason">${esc(d.reason)}</p>` : ""}
        ${d.risks?.length ? `<div class="list"><b>Risiko:</b> ${d.risks.map(esc).join(" · ")}</div>` : ""}
        ${d.rejected?.length ? `<div class="list"><b>Ditolak:</b> ${d.rejected.map(esc).join(" · ")}</div>` : ""}
      </article>`).join("");
  }

  function renderLessons() {
    const rows = state.lessons?.lessons || [];
    const list = $("#lessons-list");
    if (!rows.length) { list.innerHTML = `<div class="empty">Belum ada lesson. Agent akan menyimpan pelajaran setelah posisi ditutup.</div>`; return; }
    list.innerHTML = rows.map((l) => `
      <article class="lesson ${l.pinned ? "pinned" : ""}">
        <div>${l.pinned ? "📌 " : ""}${esc(l.rule)}</div>
        <div class="meta">${l.outcome ? `<span class="tag">${esc(l.outcome)}</span>` : ""}${l.role ? `<span class="tag">${esc(l.role)}</span>` : ""}
        ${(l.tags || []).slice(0, 5).map((t) => `<span>#${esc(t)}</span>`).join("")}<span>${esc(time(l.created_at))}</span></div>
      </article>`).join("");
  }

  function renderLogs() {
    const lg = state.logs || {};
    const at = $("#actions-table");
    at.innerHTML = lg.actions?.length
      ? `<thead><tr><th>Waktu</th><th>Tool</th><th class="n">Status</th><th class="n">Durasi</th><th>Error</th></tr></thead><tbody>${lg.actions.map((a) => `<tr>
          <td class="num small">${esc(time(a.ts))}</td><td class="num">${esc(a.tool)}</td>
          <td class="n ${a.success ? "up" : "down"}">${a.success ? "✓" : "✗"}</td>
          <td class="n">${isNum(a.duration_ms) ? `${(a.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
          <td class="reason">${esc(a.error || "")}</td></tr>`).join("")}</tbody>`
      : `<tr><td class="empty">Belum ada aksi tercatat hari ini.</td></tr>`;
    renderLogLines();
  }

  function renderLogLines() {
    const q = $("#log-filter").value.trim().toLowerCase();
    const lines = (state.logs?.lines || []).filter((l) => !q || l.toLowerCase().includes(q)).slice(-300).reverse();
    const pre = $("#log-lines");
    pre.innerHTML = lines.length ? lines.map((l) => {
      const c = /ERROR/.test(l) ? "e" : /WARN/.test(l) ? "w" : "";
      return `<span class="${c}">${esc(l)}</span>`;
    }).join("\n") : "Belum ada log.";
  }

  // ─── Events ─────────────────────────────────────────────
  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  }

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
  document.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); selectTab(a.dataset.goto); }));
  document.querySelectorAll("[data-dfilter]").forEach((b) => b.addEventListener("click", () => {
    state.dfilter = b.dataset.dfilter;
    document.querySelectorAll("[data-dfilter]").forEach((x) => x.classList.toggle("active", x === b));
    renderDecisions();
  }));
  $("#history-range").addEventListener("change", () => state.history && renderHistory());
  $("#log-filter").addEventListener("input", renderLogLines);
  $("#refresh-btn").addEventListener("click", () => load(true));

  const initial = location.hash.slice(1);
  if (document.querySelector(`.tabs button[data-tab="${CSS.escape(initial)}"]`)) selectTab(initial);

  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  setInterval(() => { if (state.overview) tickCycles(); }, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
})();
