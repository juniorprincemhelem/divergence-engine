const axios = require("axios");
const fs = require("fs");
const http = require("http");

const { jwt, apiToken, baseUrl } = JSON.parse(fs.readFileSync("./api-token.json", "utf8"));
const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const POLL_INTERVAL_MS = 60000;
const DIVERGENCE_THRESHOLD = 2.0;
const SMOOTHING_WINDOW = 3;
const fixtures = JSON.parse(fs.readFileSync("./fixtures.json", "utf8"));

let previousOdds = {};
let oddsHistory = {};   // { fixtureId: [{ts, homePct, drawPct, awayPct}] }
let divergenceLog = [];
let pollCount = 0;
let liveData = [];
let lastFlagged = {}; // { fixtureId: { score, magnitude, pollCount } }

function parseOdds(oddsArray) {
  const market = oddsArray.find(o => o.SuperOddsType === "1X2_PARTICIPANT_RESULT");
  if (!market) return null;
  return {
    ts: Date.now(),
    home: market.Prices[0] / 1000,
    draw: market.Prices[1] / 1000,
    away: market.Prices[2] / 1000,
    homePct: parseFloat(market.Pct[0]),
    drawPct: parseFloat(market.Pct[1]),
    awayPct: parseFloat(market.Pct[2]),
    inRunning: market.InRunning,
  };
}

function averageOdds(samples) {
  const totals = samples.reduce(
    (acc, item) => ({
      homePct: acc.homePct + item.homePct,
      drawPct: acc.drawPct + item.drawPct,
      awayPct: acc.awayPct + item.awayPct,
    }),
    { homePct: 0, drawPct: 0, awayPct: 0 }
  );
  const count = Math.max(1, samples.length);
  return {
    homePct: totals.homePct / count,
    drawPct: totals.drawPct / count,
    awayPct: totals.awayPct / count,
  };
}

function getSmoothedOdds(history, current) {
  const prevWindow = history.slice(-SMOOTHING_WINDOW);
  const currentWindow = history.slice(-SMOOTHING_WINDOW + 1).concat(current);
  return {
    prev: averageOdds(prevWindow),
    current: averageOdds(currentWindow),
  };
}

function computeSignal(id, current) {
  const history = oddsHistory[id] || [];
  if (history.length === 0) return null;

  const prev = history[history.length - 1];
  const { prev: baseline, current: smoothed } = getSmoothedOdds(history, current);

  // 1. Drift magnitude (smoothed over the last polls to damp synthetic devnet jitter)
  const homeDrift = Math.abs(smoothed.homePct - baseline.homePct);
  const drawDrift = Math.abs(smoothed.drawPct - baseline.drawPct);
  const awayDrift = Math.abs(smoothed.awayPct - baseline.awayPct);
  const magnitude = Math.max(homeDrift, drawDrift, awayDrift);

  // 2. Velocity — capped so it can't multiply the score out of control
  let velocity = 1;
  if (history.length >= 3) {
    const recentMagnitudes = [];
    for (let i = history.length - 1; i > Math.max(0, history.length - 4); i--) {
      const a = history[i], b = history[i - 1];
      if (b) recentMagnitudes.push(Math.max(
        Math.abs(a.homePct - b.homePct),
        Math.abs(a.drawPct - b.drawPct),
        Math.abs(a.awayPct - b.awayPct)
      ));
    }
    const avgMagnitude = recentMagnitudes.reduce((s, v) => s + v, 0) / recentMagnitudes.length || magnitude;
    velocity = avgMagnitude > 0 ? Math.min(1.5, magnitude / avgMagnitude) : 1;
  }

  // 3. Consistency — small bonus/penalty, not a multiplier that compounds
  let consistencyBonus = 0;
  if (history.length >= 2) {
    const prev2 = history[history.length - 2];
    const sameHomeDir = Math.sign(current.homePct - prev.homePct) === Math.sign(prev.homePct - prev2.homePct);
    const sameAwayDir = Math.sign(current.awayPct - prev.awayPct) === Math.sign(prev.awayPct - prev2.awayPct);
    consistencyBonus = (sameHomeDir || sameAwayDir) ? 8 : -5;
  }

  // 4. Composite score — rescaled so 100 is genuinely rare
  // magnitude of 12%+ in one poll is already a huge move; scale around that
  const rawScore = (magnitude * 5) + (velocity - 1) * 15 + consistencyBonus;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // 5. Confidence level
  let confidence, reason;
  if (history.length < 2) {
    confidence = "LOW";
    reason = "Insufficient polling history";
  } else if (score >= 60) {
    confidence = "HIGH";
    reason = `${magnitude.toFixed(2)}% smoothed shift, velocity ${velocity.toFixed(2)}x recent average`;
  } else if (score >= 30) {
    confidence = "MEDIUM";
    reason = `${magnitude.toFixed(2)}% smoothed drift, ${consistencyBonus > 0 ? "consistent direction" : "mixed direction — possible noise"}`;
  } else {
    confidence = "LOW";
    reason = `${magnitude.toFixed(2)}% smoothed movement — within normal noise range`;
  }

  return {
    magnitude: +magnitude.toFixed(3),
    velocity: +velocity.toFixed(2),
    score,
    confidence,
    reason,
    homeDrift: +(current.homePct - prev.homePct).toFixed(3),
    drawDrift: +(current.drawPct - prev.drawPct).toFixed(3),
    awayDrift: +(current.awayPct - prev.awayPct).toFixed(3),
  };
}

function shouldLogDivergence(id, signal, pollCount) {
  if (!signal || signal.score < 40) return false;

  const last = lastFlagged[id];
  if (!last) return true;

  const pollsSinceLastFlag = pollCount - last.pollCount;
  const scoreJump = signal.score - last.score;

  return pollsSinceLastFlag >= 5 || scoreJump >= 20;
}

async function poll() {
  pollCount++;
  const newData = [];

  for (const fixture of fixtures) {
    const id = fixture.FixtureId;
    try {
      const res = await axios.get(`${baseUrl}/api/odds/snapshot/${id}`, { headers });
      if (!res.data || res.data.length === 0) continue;
      const current = parseOdds(res.data);
      if (!current) continue;

      // Store history
      if (!oddsHistory[id]) oddsHistory[id] = [];
      const signal = computeSignal(id, current);
      oddsHistory[id].push({ ts: current.ts, homePct: current.homePct, drawPct: current.drawPct, awayPct: current.awayPct });
      if (oddsHistory[id].length > 30) oddsHistory[id].shift(); // keep last 30 polls

      // Flag divergence
      if (shouldLogDivergence(id, signal, pollCount)) {
        divergenceLog.unshift({
          timestamp: new Date().toISOString(),
          pollCount,
          fixtureId: id,
          fixture: `${fixture.Participant1} vs ${fixture.Participant2}`,
          competition: fixture.Competition,
          signal,
          current,
          inRunning: current.inRunning,
        });
        if (divergenceLog.length > 50) divergenceLog.pop();
        lastFlagged[id] = { score: signal.score, pollCount };
        fs.writeFileSync("./divergence-log.json", JSON.stringify(divergenceLog, null, 2));
      }

      newData.push({
        id,
        name: `${fixture.Participant1} vs ${fixture.Participant2}`,
        home: fixture.Participant1,
        away: fixture.Participant2,
        competition: fixture.Competition,
        current,
        signal,
        history: oddsHistory[id].slice(-10), // last 10 for chart
      });

      previousOdds[id] = current;
    } catch (e) {
      console.error(`Error fetching ${fixture.Participant1} vs ${fixture.Participant2}:`, e.response?.status, e.response?.data || e.message);
    }
  }

  liveData = newData;
  console.log(`Poll #${pollCount} | ${newData.length} fixtures | ${divergenceLog.length} divergences`);
}

// ---- HTML ----
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Divergence Engine</title>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:wght@400;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#11141C;color:#E8E6DE;font-family:'JetBrains Mono', monospace;min-height:100vh}

  header{background:#11141C;border-bottom:1px solid #262C3D;padding:24px 32px;display:flex;align-items:center;justify-content:space-between}
  .brand{display:flex;align-items:center;gap:16px}
  .brand h1{font-family:'Newsreader', serif;font-size:24px;font-weight:700;color:#E8E6DE;letter-spacing:-0.3px}
  .brand p{font-size:11px;color:#767C94;margin-top:3px;font-family:'JetBrains Mono',monospace;letter-spacing:0.5px;text-transform:uppercase}
  .stats{display:flex;gap:16px}
  .stat{text-align:center;padding:10px 18px;background:#181C28;border:1px solid #262C3D;border-radius:4px}
  .stat-val{font-size:22px;font-weight:700;color:#E8A33D;font-family:'JetBrains Mono',monospace}
  .stat-val.alert{color:#E85D4A}
  .stat-label{font-size:9px;color:#767C94;margin-top:2px;text-transform:uppercase;letter-spacing:1px}
  .demo-note{font-size:11px;color:#767C94;margin-top:8px;max-width:420px;line-height:1.4;font-family:'JetBrains Mono',monospace;letter-spacing:0.3px}
  .live-pill{display:flex;align-items:center;gap:7px;padding:7px 14px;background:rgba(61,201,176,0.08);border:1px solid rgba(61,201,176,0.3);border-radius:4px;font-size:11px;color:#3DC9B0;font-weight:600;font-family:'JetBrains Mono',monospace}
  .dot{width:7px;height:7px;background:#3DC9B0;border-radius:50%;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.25}}

  main{padding:28px 32px}
  h2{font-family:'Newsreader',serif;font-size:18px;font-weight:600;color:#E8E6DE;margin-bottom:16px;border-bottom:1px solid #262C3D;padding-bottom:10px}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px;margin-bottom:28px}

  .card{background:#181C28;border:1px solid #262C3D;border-radius:6px;padding:20px;transition:border-color 0.3s}
  .card:hover{border-color:#3a4258}
  .card.flagged{border-color:#E85D4A;box-shadow:0 0 0 1px rgba(232,93,74,0.2)}
  .card.live-match{border-color:#3DC9B0}

  .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
  .match-name{font-family:'Newsreader',serif;font-size:16px;font-weight:600;color:#E8E6DE}
  .comp{font-size:10px;color:#767C94;margin-top:3px;text-transform:uppercase;letter-spacing:0.5px}
  .badge{font-size:9px;font-weight:700;padding:4px 10px;border-radius:3px;letter-spacing:0.5px}
  .badge-live{background:rgba(61,201,176,0.1);color:#3DC9B0;border:1px solid rgba(61,201,176,0.4)}
  .badge-pre{background:rgba(118,124,148,0.1);color:#767C94;border:1px solid #262C3D}
  .badge-alert{background:rgba(232,93,74,0.1);color:#E85D4A;border:1px solid rgba(232,93,74,0.4)}

  .prob-row{margin-bottom:8px}
  .prob-meta{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
  .prob-name{font-size:11px;color:#8a9ac0}
  .prob-right{display:flex;align-items:center;gap:6px}
  .prob-val{font-size:12px;font-weight:600;color:#fff}
  .drift{font-size:10px;font-weight:600}
  .drift.up{color:#00ff88}
  .drift.down{color:#ff4757}
  .drift.flat{color:#4a5a9a}
  .track{background:#0f1a30;border-radius:3px;height:5px}
  .fill{height:5px;border-radius:3px;transition:width 0.6s ease}
  .fill-h{background:#E8A33D}
  .fill-d{background:#767C94}
  .fill-a{background:#3DC9B0}

  .signal-box{margin-top:12px;padding:10px 12px;border-radius:8px;font-size:11px}
  .signal-box.HIGH{background:rgba(255,107,53,0.1);border:1px solid rgba(255,107,53,0.3);color:#ff6b35}
  .signal-box.MEDIUM{background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);color:#fbbf24}
  .signal-box.LOW{background:rgba(74,90,154,0.15);border:1px solid #1e2d5a;color:#6a7fbd}
  .signal-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
  .signal-label{font-weight:700;font-size:12px}
  .signal-score{font-size:18px;font-weight:700}
  .signal-reason{line-height:1.4;opacity:0.85}

  .chart-wrap{height:80px;margin-top:10px}

  .log-card{background:#0c1220;border:1px solid #1a2545;border-radius:12px;overflow:hidden}
  table{width:100%;border-collapse:collapse}
  th{font-size:10px;color:#4a5a9a;text-transform:uppercase;letter-spacing:0.5px;padding:10px 14px;border-bottom:1px solid #1a2545;text-align:left}
  td{font-size:12px;padding:10px 14px;border-bottom:1px solid #0f1628;vertical-align:middle}
  tr:last-child td{border:none}
  tr:hover td{background:#0f1628}
  .conf-HIGH{color:#ff6b35;font-weight:700}
  .conf-MEDIUM{color:#fbbf24;font-weight:700}
  .conf-LOW{color:#6a7fbd}
  .score-pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;background:#1a2545}
  .empty{text-align:center;padding:32px;color:#2a3a7a;font-size:13px}

  footer{text-align:center;padding:16px;color:#1e2d5a;font-size:10px;border-top:1px solid #0f1628;margin-top:8px}
</style>
</head>
<body>
<header>
  <div class="brand">
    <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
      <path d="M4 17 L14 17 L20 8" stroke="#E8A33D" stroke-width="2" stroke-linecap="round" fill="none"/>
      <path d="M4 17 L14 17 L20 26" stroke="#3DC9B0" stroke-width="2" stroke-linecap="round" fill="none"/>
      <circle cx="4" cy="17" r="2.5" fill="#E8E6DE"/>
    </svg>
    <div>
      <h1>Divergence Engine</h1>
      <p>Autonomous Market Intelligence · TxODDS × Solana</p>
      <p class="demo-note">Devnet odds are synthetic and jittery; the engine applies noise reduction so this demo tracks cleaner, more realistic drift behavior.</p>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-val" id="sPoll">0</div><div class="stat-label">Polls</div></div>
    <div class="stat"><div class="stat-val" id="sFix">0</div><div class="stat-label">Fixtures</div></div>
    <div class="stat"><div class="stat-val alert" id="sDiv">0</div><div class="stat-label">Divergences</div></div>
    <div class="live-pill"><div class="dot"></div><span id="sTime">--</span></div>
  </div>
</header>

<main>
  <h2>Live Fixtures</h2>
  <div class="grid" id="grid"></div>
  <h2>Accumulator Risk Visualizer</h2>
  <div class="log-card" style="padding:20px; margin-bottom:28px;">
    <p style="font-size:12px; color:#8a9ac0; margin-bottom:16px; line-height:1.5;">
      Why structure matters separately from signal quality: even high per-leg confidence collapses fast across multi-leg slips. Adjust the sliders to see it live.
    </p>
    <div style="display:flex; gap:24px; align-items:center; margin-bottom:16px; flex-wrap:wrap;">
      <div>
        <label style="font-size:11px; color:#6a7fbd;">Legs: <span id="legsVal">5</span></label><br>
        <input type="range" id="legsSlider" min="1" max="30" value="5" style="width:160px;">
      </div>
      <div>
        <label style="font-size:11px; color:#6a7fbd;">Confidence per leg: <span id="confVal">80</span>%</label><br>
        <input type="range" id="confSlider" min="50" max="99" value="80" style="width:160px;">
      </div>
      <div style="display:flex; gap:8px;">
        <button id="btnOptimistic" class="toggle-btn" style="padding:6px 12px; font-size:11px; border-radius:6px; border:1px solid #1e2d5a; background:#0f1628; color:#8a9ac0; cursor:pointer;">Optimistic (95%)</button>
        <button id="btnConservative" class="toggle-btn" style="padding:6px 12px; font-size:11px; border-radius:6px; border:1px solid #1e2d5a; background:#0f1628; color:#8a9ac0; cursor:pointer;">Conservative (75%)</button>
      </div>
      <div style="margin-left:auto; text-align:right;">
        <div style="font-size:11px; color:#6a7fbd;">SLIP WIN PROBABILITY</div>
        <div id="slipProb" style="font-size:32px; font-weight:700; color:#00ff88;">--%</div>
      </div>
    </div>
    <div class="chart-wrap" style="height:140px;">
      <canvas id="accChart"></canvas>
    </div>
  </div>
  <h2>Divergence Log</h2>
  <div class="log-card">
    <table><thead><tr>
      <th>Time</th><th>Fixture</th><th>Signal Score</th><th>Confidence</th><th>Magnitude</th><th>Reason</th>
    </tr></thead>
    <tbody id="logBody"><tr><td colspan="6" class="empty">Watching for divergences...</td></tr></tbody>
    </table>
  </div>
</main>
<footer>Divergence Engine v1.0 · Built on TxLINE × Solana Devnet · TxODDS Hackathon 2026</footer>

<script>
const charts = {};
let accChart;

function drift(val) {
  if (val === null || val === undefined) return '';
  if (val > 0.05) return \`<span class="drift up">▲\${Math.abs(val).toFixed(2)}%</span>\`;
  if (val < -0.05) return \`<span class="drift down">▼\${Math.abs(val).toFixed(2)}%</span>\`;
  return \`<span class="drift flat">─</span>\`;
}

function probRow(label, pct, d, fillClass) {
  return \`<div class="prob-row">
    <div class="prob-meta">
      <span class="prob-name">\${label}</span>
      <div class="prob-right"><span class="prob-val">\${pct.toFixed(2)}%</span>\${drift(d)}</div>
    </div>
    <div class="track"><div class="fill \${fillClass}" style="width:\${Math.min(pct,100)}%"></div></div>
  </div>\`;
}

function renderChart(canvasId, history) {
  const labels = history.map((_, i) => \`-\${history.length - 1 - i}m\`);
  const data = {
    labels,
    datasets: [
      { label: 'Home', data: history.map(h => h.homePct), borderColor: '#4f9eff', backgroundColor: 'rgba(79,158,255,0.08)', tension: 0.4, pointRadius: 2, borderWidth: 2 },
      { label: 'Draw', data: history.map(h => h.drawPct), borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.08)', tension: 0.4, pointRadius: 2, borderWidth: 2 },
      { label: 'Away', data: history.map(h => h.awayPct), borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,0.08)', tension: 0.4, pointRadius: 2, borderWidth: 2 },
    ]
  };
  if (charts[canvasId]) {
    charts[canvasId].data = data;
    charts[canvasId].update('none');
  } else {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;
    charts[canvasId] = new Chart(ctx, {
      type: 'line', data,
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#4a5a9a', font: { size: 9 } }, grid: { color: '#0f1628' } },
          y: { ticks: { color: '#4a5a9a', font: { size: 9 }, callback: v => v.toFixed(0) + '%' }, grid: { color: '#0f1628' } }
        }
      }
    });
  }
}

async function refresh() {
  const d = await fetch('/data').then(r => r.json());
  document.getElementById('sPoll').textContent = d.pollCount;
  document.getElementById('sFix').textContent = d.fixtures.length;
  document.getElementById('sDiv').textContent = d.divergences.length;
  document.getElementById('sTime').textContent = new Date().toLocaleTimeString();

  document.getElementById('grid').innerHTML = d.fixtures.map(f => {
    const s = f.signal;
    const flagged = s && (s.confidence === "MEDIUM" || s.confidence === "HIGH");
    const cardCls = f.current.inRunning ? 'live-match' : flagged ? 'flagged' : '';
    const badge = f.current.inRunning
      ? '<span class="badge badge-live">🟢 LIVE</span>'
      : flagged
        ? '<span class="badge badge-alert">🚨 SIGNAL</span>'
        : '<span class="badge badge-pre">Pre-match</span>';
    const signalHtml = s ? \`
      <div class="signal-box \${s.confidence}">
        <div class="signal-top">
          <span class="signal-label">\${s.confidence} CONFIDENCE</span>
          <span class="signal-score">\${s.score}</span>
        </div>
        <div class="signal-reason">\${s.reason}</div>
      </div>\` : '';
    const chartId = 'chart_' + f.id;
    return \`<div class="card \${cardCls}">
      <div class="card-header"><div><div class="match-name">\${f.name}</div><div class="comp">\${f.competition}</div></div>\${badge}</div>
      \${probRow(f.home, f.current.homePct, s?.homeDrift, 'fill-h')}
      \${probRow('Draw', f.current.drawPct, s?.drawDrift, 'fill-d')}
      \${probRow(f.away, f.current.awayPct, s?.awayDrift, 'fill-a')}
      \${signalHtml}
      \${f.history.length > 1 ? \`<div class="chart-wrap"><canvas id="\${chartId}"></canvas></div>\` : ''}
    </div>\`;
  }).join('');

  // Render charts after DOM update
  d.fixtures.forEach(f => {
    if (f.history.length > 1) renderChart('chart_' + f.id, f.history);
  });

  // Log
  const logBody = document.getElementById('logBody');
  if (!d.divergences.length) {
    logBody.innerHTML = '<tr><td colspan="6" class="empty">Watching for divergences...</td></tr>';
  } else {
    logBody.innerHTML = d.divergences.slice(0, 15).map(e => \`<tr>
      <td>\${new Date(e.timestamp).toLocaleTimeString()}</td>
      <td>\${e.fixture}</td>
      <td><span class="score-pill">\${e.signal.score}</span></td>
      <td class="conf-\${e.signal.confidence}">\${e.signal.confidence}</td>
      <td>\${e.signal.magnitude}%</td>
      <td style="color:#8a9ac0;max-width:240px">\${e.signal.reason}</td>
    </tr>\`).join('');
  }
}

// ---- Accumulator Risk Visualizer ----
function updateAccumulator() {
  const legs = +document.getElementById('legsSlider').value;
  const conf = +document.getElementById('confSlider').value / 100;

  document.getElementById('legsVal').textContent = legs;
  document.getElementById('confVal').textContent = (conf * 100).toFixed(0);

  const probs = [];
  for (let n = 1; n <= legs; n++) probs.push(Math.pow(conf, n) * 100);

  const finalProb = probs[probs.length - 1];
  document.getElementById('slipProb').textContent = finalProb.toFixed(2) + '%';
  document.getElementById('slipProb').style.color = finalProb >= 30 ? '#00ff88' : finalProb >= 10 ? '#fbbf24' : '#ff6b35';

  const ctx = document.getElementById('accChart').getContext('2d');
  const data = {
    labels: probs.map((_, i) => 'Leg ' + (i + 1)),
    datasets: [{
      label: 'Cumulative win probability',
      data: probs,
      borderColor: '#4f9eff',
      backgroundColor: 'rgba(79,158,255,0.1)',
      tension: 0.3,
      pointRadius: 3,
      borderWidth: 2,
      fill: true
    }]
  };

  if (accChart) {
    accChart.data = data;
    accChart.update();
  } else {
    accChart = new Chart(ctx, {
      type: 'line', data,
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#4a5a9a', font: { size: 9 } }, grid: { color: '#0f1628' } },
          y: { min: 0, max: 100, ticks: { color: '#4a5a9a', font: { size: 9 }, callback: v => v + '%' }, grid: { color: '#0f1628' } }
        }
      }
    });
  }
}

document.getElementById('legsSlider').addEventListener('input', updateAccumulator);
document.getElementById('confSlider').addEventListener('input', updateAccumulator);
document.getElementById('btnOptimistic').addEventListener('click', () => {
  document.getElementById('confSlider').value = 95;
  updateAccumulator();
});
document.getElementById('btnConservative').addEventListener('click', () => {
  document.getElementById('confSlider').value = 75;
  updateAccumulator();
});
updateAccumulator();

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pollCount, fixtures: liveData, divergences: divergenceLog }));
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }
});

server.listen(3000, () => {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   DIVERGENCE ENGINE — Web Dashboard      ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log("║   Open: http://localhost:3000            ║");
  console.log("╚══════════════════════════════════════════╝\n");
});

poll();
setInterval(poll, POLL_INTERVAL_MS);