require("dotenv").config();

const axios = require("axios");
const fs = require("fs");
const http = require("http");
const path = require("path");

const tokenFilePath = path.join(__dirname, "api-token.json");
const fixturesFilePath = path.join(__dirname, "fixtures.json");

let jwt = process.env.TXLINE_JWT;
let apiToken = process.env.TXLINE_API_TOKEN;
let baseUrl = process.env.TXLINE_BASE_URL || "http://txline-dev.txodds.com";

if (!jwt || !apiToken) {
  try {
    const tokenData = JSON.parse(fs.readFileSync(tokenFilePath, "utf8"));
    jwt = jwt || tokenData.jwt;
    apiToken = apiToken || tokenData.apiToken;
    baseUrl = tokenData.baseUrl || baseUrl;
  } catch (error) {
    console.warn("?? No local api-token.json found. Using TXLINE_* environment variables if provided.");
  }
}

if (!jwt || !apiToken) {
  console.warn("?? Missing TXLINE_JWT or TXLINE_API_TOKEN. The dashboard will start in degraded mode.");
}

const headers = { Authorization: `Bearer ${jwt || ""}`, "X-Api-Token": apiToken || "" };
const POLL_INTERVAL_MS = 60000;
const SMOOTHING_WINDOW = 3;

let fixtures = [];
try {
  fixtures = JSON.parse(fs.readFileSync(fixturesFilePath, "utf8"));
} catch (error) {
  console.warn("?? No local fixtures.json found. Starting without fixture data.");
}

let oddsHistory = {};
let divergenceLog = [];
let eventTimeline = [];
let liveData = [];
let pollCount = 0;
let lastFlagged = {};
let marketIntel = {
  updated: new Date().toISOString(),
  headline: "Market intelligence preview initializing...",
  summary: "Live market flows will appear here as the engine polls.",
  edge: "N/A",
  focus: "N/A",
  recommendation: "—"
};

function parseOdds(oddsArray) {
  const market = oddsArray.find(o => o.SuperOddsType === "1X2_PARTICIPANT_RESULT");
  if (!market) return null;
  return {
    ts: market.Ts,
    homePct: parseFloat(market.Pct?.[0] || 0),
    drawPct: parseFloat(market.Pct?.[1] || 0),
    awayPct: parseFloat(market.Pct?.[2] || 0),
    inRunning: Boolean(market.InRunning),
    homePrice: (market.Prices?.[0] || 0) / 1000,
    drawPrice: (market.Prices?.[1] || 0) / 1000,
    awayPrice: (market.Prices?.[2] || 0) / 1000,
  };
}

function computeSignal(id, current) {
  const history = oddsHistory[id] || [];
  if (history.length < 1) {
    return {
      score: 0,
      confidence: 'LOW',
      status: 'STABLE',
      statusLabel: 'STABLE',
      emoji: '🟦',
      magnitude: 0,
      velocity: 1,
      consistency: 0,
      reason: 'Baseline captured, no signal yet.'
    };
  }

  const prev = history[history.length - 1];
  const homeShift = current.homePct - prev.homePct;
  const drawShift = current.drawPct - prev.drawPct;
  const awayShift = current.awayPct - prev.awayPct;
  const magnitude = Math.max(Math.abs(homeShift), Math.abs(drawShift), Math.abs(awayShift));
  const velocity = 1 + magnitude * 0.18;
  const consistency = Math.max(0, 100 - magnitude * 4);
  const rawScore = (magnitude * 6) + ((velocity - 1) * 18) + (consistency * 0.12);
  const score = Math.round(Math.max(0, Math.min(100, rawScore)));
  let confidence = 'LOW';
  let statusLabel = 'STABLE';
  let emoji = '🟦';

  if (score >= 70) {
    confidence = 'HIGH';
    statusLabel = 'SIGNAL TRIGGERED';
    emoji = '⚡';
  } else if (score >= 45) {
    confidence = 'MEDIUM';
    statusLabel = 'ACCELERATING';
    emoji = '↑';
  } else if (score >= 25) {
    confidence = 'LOW';
    statusLabel = 'WATCHING';
    emoji = '👀';
  }

  return {
    score,
    confidence,
    status: statusLabel,
    statusLabel,
    emoji,
    magnitude: parseFloat((magnitude * 100).toFixed(2)),
    velocity: parseFloat(velocity.toFixed(2)),
    consistency: parseFloat(consistency.toFixed(0)),
    reason: `${(magnitude * 100).toFixed(2)}% drift detected`,
    homeDrift: homeShift,
    drawDrift: drawShift,
    awayDrift: awayShift,
  };
}

function shouldLogDivergence(id, signal) {
  if (!signal) return false;
  if (signal.status === 'SIGNAL_TRIGGERED') return true;
  if (signal.status === 'ACCELERATING' && (!lastFlagged[id] || lastFlagged[id].status !== 'ACCELERATING')) return true;
  return false;
}

function addTimelineEvent(event) {
  eventTimeline.unshift(Object.assign({ timestamp: new Date().toISOString() }, event));
  if (eventTimeline.length > 50) eventTimeline.pop();
}

function buildMarketIntel() {
  return {
    updated: new Date().toISOString(),
    headline: `Live market scan — ${liveData.length} fixtures updated`,
    summary: `Latest market scan completed with ${divergenceLog.length} divergence events.`,
    edge: `${divergenceLog.length > 0 ? 'Momentum' : 'Stable'}`,
    focus: `${liveData.length} tracked fixtures`,
    recommendation: divergenceLog.length > 0 ? 'Monitor high-confidence signals.' : 'Continue watching.',
  };
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

      if (!oddsHistory[id]) oddsHistory[id] = [];
      const signal = computeSignal(id, current);
      oddsHistory[id].push({ ts: current.ts, homePct: current.homePct, drawPct: current.drawPct, awayPct: current.awayPct });
      if (oddsHistory[id].length > 30) oddsHistory[id].shift();

      if (signal && shouldLogDivergence(id, signal, pollCount)) {
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
        lastFlagged[id] = { score: signal.score, pollCount, status: signal.status };
        fs.writeFileSync("./divergence-log.json", JSON.stringify(divergenceLog, null, 2));
        addTimelineEvent({
          fixture: `${fixture.Participant1} vs ${fixture.Participant2}`,
          icon: signal.emoji,
          badge: signal.statusLabel,
          message: `${signal.emoji} ${signal.statusLabel} detected at ${signal.score} score.`,
          details: signal.reason,
        });
      } else if (signal && signal.status === "ACCELERATING" && (!lastFlagged[id] || lastFlagged[id].status !== "ACCELERATING")) {
        addTimelineEvent({
          fixture: `${fixture.Participant1} vs ${fixture.Participant2}`,
          icon: "?",
          badge: "ACCELERATING",
          message: `Momentum accelerating with ${signal.score} score.`,
          details: signal.reason,
        });
      }

          newData.push({
        id,
        name: `${fixture.Participant1} vs ${fixture.Participant2}`,
        home: fixture.Participant1,
        away: fixture.Participant2,
        competition: fixture.Competition,
        current,
        signal,
        history: oddsHistory[id].slice(-10),
      });
    } catch (e) {
      const message = e.response?.data || e.message;
      console.error(`Error fetching ${fixture.Participant1} vs ${fixture.Participant2}:`, message);
      addTimelineEvent({
        fixture: `${fixture.Participant1} vs ${fixture.Participant2}`,
        icon: "??",
        badge: "ERROR",
        message: "Data fetch failed.",
        details: `${message}`,
      });
    }
  }

  liveData = newData;
  marketIntel = buildMarketIntel();
  addTimelineEvent({
    fixture: "Market scan",
    icon: "??",
    badge: "HEARTBEAT",
    message: `Poll #${pollCount} completed with ${newData.length} fixtures.`,
    details: `Live engine refreshed at ${new Date().toLocaleTimeString()}.`,
  });

  console.log(`Poll #${pollCount} | fixtures=${newData.length} | divergences=${divergenceLog.length}`);
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Divergence Engine</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
:root {
  color-scheme: dark;
  color: #d7e0ff;
  background: #060914;
  font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
}
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
html, body {
  min-height: 100%;
}
body {
  background: radial-gradient(circle at top, rgba(61, 201, 176, 0.12), transparent 30%),
              linear-gradient(180deg, #090c15 0%, #05070f 100%);
  color: #d7e0ff;
  font-size: 13px;
  line-height: 1.5;
}
a {
  color: #75b7ff;
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
button, input {
  font: inherit;
}
button {
  cursor: pointer;
}
img {
  max-width: 100%;
}
header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  padding: 22px 28px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}
.brand-logo {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: rgba(61, 201, 176, 0.16);
  color: #3dc9b0;
  font-size: 18px;
}
.brand-copy {
  display: grid;
  gap: 6px;
}
.brand-copy h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.3px;
}
.brand-copy p {
  color: #8da4ce;
  font-size: 12px;
  letter-spacing: 0.8px;
  text-transform: uppercase;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.kpi-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.kpi {
  min-width: 88px;
  padding: 10px 14px;
  background: rgba(10, 16, 32, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 12px;
}
.kpi strong {
  display: block;
  font-size: 18px;
  font-weight: 700;
  color: #f5f8ff;
}
.kpi span {
  display: block;
  margin-top: 4px;
  font-size: 10px;
  color: #7f94c3;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #8ae7cb;
  padding: 10px 14px;
  border: 1px solid rgba(61, 201, 176, 0.28);
  border-radius: 999px;
  background: rgba(61, 201, 176, 0.08);
  font-size: 12px;
  font-weight: 600;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3dc9b0;
  box-shadow: 0 0 0 6px rgba(61, 201, 176, 0.12);
}
main {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(340px, 0.9fr);
  gap: 20px;
  padding: 22px 28px 28px;
}
@media (max-width: 1100px) {
  main {
    grid-template-columns: 1fr;
  }
}
.panel {
  background: rgba(8, 12, 24, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 22px;
  padding: 22px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
}
.panel + .panel {
  margin-top: 20px;
}
.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.panel-title h2 {
  font-size: 16px;
  font-weight: 700;
  color: #e5ebff;
}
.panel-title small {
  color: #7c8db9;
  font-size: 11px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}
.card {
  background: rgba(7, 11, 20, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 18px;
  padding: 18px;
  transition: transform 0.2s ease, border-color 0.2s ease;
}
.card:hover {
  transform: translateY(-1px);
  border-color: rgba(61, 201, 176, 0.35);
}
.card-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.card-header .title {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.2px;
}
.card-header .subtle {
  color: #7c8bb4;
  font-size: 11px;
  line-height: 1.4;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 700;
  padding: 6px 10px;
  border-radius: 999px;
}
.badge.LIVE { background: rgba(61, 201, 176, 0.14); color: #8ae7cb; border: 1px solid rgba(61, 201, 176, 0.24); }
.badge.WATCHING { background: rgba(79, 158, 255, 0.14); color: #9ac8ff; border: 1px solid rgba(79, 158, 255, 0.24); }
.badge.ACCELERATING { background: rgba(255, 181, 71, 0.12); color: #ffd78f; border: 1px solid rgba(255, 181, 71, 0.2); }
.badge.SIGNAL_TRIGGERED { background: rgba(255, 106, 80, 0.12); color: #ffac8e; border: 1px solid rgba(255, 106, 80, 0.22); }
.badge.STABLE { background: rgba(137, 150, 255, 0.10); color: #b6c5ff; border: 1px solid rgba(137, 150, 255, 0.18); }
.card-body {
  display: grid;
  gap: 10px;
}
.prob-row {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}
.prob-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.prob-name {
  font-size: 11px;
  color: #8c9cd6;
}
.prob-val {
  font-size: 12px;
  font-weight: 700;
  color: #f0f5ff;
}
.track {
  background: rgba(255, 255, 255, 0.04);
  border-radius: 999px;
  height: 6px;
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 999px;
}
.fill-h { background: #5b8cff; }
.fill-d { background: #9377ff; }
.fill-a { background: #42d5b3; }
.acc-wrap {
  display: grid;
  gap: 18px;
}
.acc-desc {
  color: #8b9aca;
  font-size: 12px;
}
.acc-row {
  display: grid;
  gap: 12px;
}
.acc-field {
  display: grid;
  gap: 6px;
}
.acc-field label {
  color: #7b8db4;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.acc-field div {
  color: #f2f7ff;
  font-weight: 700;
}
input[type='range'] {
  width: 100%;
  accent-color: #3dc9b0;
}
.acc-buttons {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.acc-btn {
  padding: 10px 14px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: #cdd7ff;
  transition: all 0.2s ease;
}
.acc-btn:hover {
  border-color: rgba(61, 201, 176, 0.3);
  color: #fff;
  background: rgba(61, 201, 176, 0.14);
}
.acc-prob-wrap {
  display: grid;
  gap: 4px;
  text-align: right;
}
.acc-prob-label {
  color: #7c8cb6;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.acc-prob-val {
  font-size: 28px;
  font-weight: 700;
  color: #62e6c3;
}
.log-wrap {
  overflow: hidden;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  padding: 12px 14px;
}
th {
  color: #6f86b6;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
td {
  color: #d3dcff;
  font-size: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
tr:hover td {
  background: rgba(255, 255, 255, 0.02);
}
.empty {
  text-align: center;
  padding: 24px;
  color: #5c718f;
}
.right-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}
.right-title {
  font-size: 16px;
  font-weight: 700;
}
.proof-bar,
.replay-bar,
.intel-wrap,
.tl-wrap {
  margin-bottom: 20px;
}
.proof-bar {
  display: grid;
  gap: 14px;
}
.proof-item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.proof-key {
  color: #7c8cb6;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.proof-val {
  color: #f4f7ff;
  font-weight: 700;
}
.proof-val.green { color: #3dc9b0; }
.proof-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(61, 201, 176, 0.12);
  color: #a0f3dc;
  border: 1px solid rgba(61, 201, 176, 0.18);
  text-align: center;
}
.replay-bar {
  display: grid;
  gap: 14px;
  padding: 18px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.02);
}
.replay-info {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.replay-label {
  color: #7c8db4;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.replay-status {
  color: #e7f4ff;
  font-weight: 700;
}
.replay-btn {
  width: 100%;
  padding: 14px 16px;
  border-radius: 14px;
  border: none;
  background: linear-gradient(135deg, #4c86ff, #3dc9b0);
  color: #fff;
  font-weight: 700;
}
.replay-btn:hover {
  opacity: 0.95;
}
.intel-wrap {
  display: grid;
  gap: 14px;
  padding: 18px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.intel-label {
  color: #7c8bb8;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
}
.intel-headline {
  font-size: 17px;
  font-weight: 700;
  color: #f7faff;
}
.intel-body {
  color: #b5c2e2;
  font-size: 12px;
  line-height: 1.7;
}
.intel-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.intel-stat {
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.intel-stat strong {
  display: block;
  color: #7c8cb6;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  margin-bottom: 6px;
}
.intel-stat span {
  color: #f5f8ff;
  font-size: 14px;
  font-weight: 700;
}
.intel-rec {
  color: #8b9aca;
  font-size: 12px;
}
.intel-rec strong {
  color: #d3e1ff;
}
.tl-wrap {
  padding: 18px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.timeline-entry {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 16px;
  padding: 14px;
  margin-bottom: 12px;
}
.timeline-entry:last-child {
  margin-bottom: 0;
}
.timeline-meta {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.timeline-icon {
  width: 32px;
  height: 32px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: rgba(61, 201, 176, 0.14);
  color: #3dc9b0;
  font-size: 14px;
}
.timeline-body {
  flex: 1;
}
.timeline-body strong {
  display: block;
  color: #eef2ff;
  font-size: 13px;
  margin-bottom: 6px;
}
.timeline-body p {
  color: #9eb2d8;
  font-size: 12px;
  line-height: 1.6;
}
.timeline-badge,
.timeline-time {
  display: block;
  margin-top: 10px;
  color: #7c8cb6;
  font-size: 11px;
}
footer {
  padding: 16px 28px 24px;
  color: #5f75a1;
  font-size: 11px;
  text-align: center;
}
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="brand-logo"><i class="fa-solid fa-signal"></i></div>
    <div class="brand-copy">
      <h1>DIVERGENCE ENGINE</h1>
      <p>Solscan-backed terminal dashboard</p>
    </div>
  </div>
  <div class="header-right">
    <div class="status-pill"><span class="status-dot"></span>Live Devnet</div>
    <div class="kpi-row">
      <div class="kpi"><strong id="sPoll">0</strong><span>Polls</span></div>
      <div class="kpi"><strong id="sFix">0</strong><span>Fixtures</span></div>
      <div class="kpi"><strong id="sDiv">0</strong><span>Divergences</span></div>
    </div>
    <div class="kpi"><strong id="sTime">--:--:--</strong><span>Last update</span></div>
  </div>
</header>
<main>
  <section class="panel">
    <div class="panel-title">
      <h2>Live Fixtures</h2>
      <small>Updated every 60 seconds</small>
    </div>
    <div class="grid" id="grid"></div>
  </section>
  <aside class="panel">
    <div class="panel-title">
      <h2>Proof & Replay</h2>
      <small>Solscan reference + demo mode</small>
    </div>
    <div class="proof-bar">
      <div class="proof-item"><div class="proof-key">Network</div><div class="proof-val">Solana Devnet</div></div>
      <div class="proof-item"><div class="proof-key">Tx</div><div class="proof-val" id="proofTx">—</div></div>
      <div class="proof-item"><div class="proof-key">Status</div><div class="proof-val green">Active</div></div>
      <a id="proofLink" class="proof-link" href="#" target="_blank"><i class="fa-solid fa-arrow-up-right-from-square"></i>View on Solscan</a>
    </div>
    <div class="replay-bar">
      <div class="replay-info">
        <div>
          <div class="replay-label">Replay state</div>
          <div class="replay-status" id="replayStatus">Idle</div>
        </div>
        <div>
          <div class="replay-label">Phase</div>
          <div class="replay-status"><span id="replayStep">0</span>/6</div>
        </div>
        <div>
          <div class="replay-label">Countdown</div>
          <div class="replay-status" id="replayRemaining">--s</div>
        </div>
      </div>
      <button id="demoReplayBtn" class="replay-btn">Launch Replay</button>
    </div>
    <div class="intel-wrap">
      <div class="intel-label">Market Intelligence</div>
      <div class="intel-headline" id="marketHeadline">Loading...</div>
      <div class="intel-body" id="marketSummary">Awaiting data from odds feed.</div>
      <div class="intel-stats">
        <div class="intel-stat"><strong>Edge</strong><span id="marketEdge">—</span></div>
        <div class="intel-stat"><strong>Focus</strong><span id="marketFocus">—</span></div>
      </div>
      <div class="intel-rec"><strong>Recommendation:</strong> <span id="marketRecommendation">—</span></div>
    </div>
    <div class="tl-wrap">
      <div class="panel-title" style="margin-bottom: 12px;">
        <h2>Event Timeline</h2>
        <small>Recent system actions</small>
      </div>
      <div id="timelineFeed"></div>
    </div>
  </aside>
</main>
<footer>Divergence Engine v1.0 · TxODDS Hackathon 2026 · Solana Devnet</footer>

<script>
const charts = {};
let accChart;
let replayTimer = null;
let replayPhase = 0;
let replayCountdown = 0;
let liveData = [];
let replayActive = false;
let savedLiveData = null;

function drift(val) {
  if (val === null || val === undefined) return '';
  if (val > 0.05) return '<span class="drift up">▲' + Math.abs(val).toFixed(2) + '%</span>';
  if (val < -0.05) return '<span class="drift down">▼' + Math.abs(val).toFixed(2) + '%</span>';
  return '<span class="drift flat">─</span>';
}

function probRow(label, pct, d, fillClass) {
  return '<div class="prob-row">' +
    '<div class="prob-meta">' +
      '<span class="prob-name">' + label + '</span>' +
      '<div class="prob-right"><span class="prob-val">' + pct.toFixed(2) + '%</span>' + drift(d) + '</div>' +
    '</div>' +
    '<div class="track"><div class="fill ' + fillClass + '" style="width:' + Math.min(pct,100) + '%"></div></div>' +
  '</div>';
}

function renderChart(canvasId, history) {
  const labels = history.map((_, i) => '-' + (history.length - 1 - i) + 'm');
  const data = {
    labels,
    datasets: [
      { label: 'Home', data: history.map(h => h.homePct), borderColor: '#4f9eff', backgroundColor: 'rgba(79,158,255,0.1)', tension: 0.35, pointRadius: 1, borderWidth: 2 },
      { label: 'Draw', data: history.map(h => h.drawPct), borderColor: '#8b77ff', backgroundColor: 'rgba(139,119,255,0.1)', tension: 0.35, pointRadius: 1, borderWidth: 2 },
      { label: 'Away', data: history.map(h => h.awayPct), borderColor: '#3dc9b0', backgroundColor: 'rgba(61,201,176,0.1)', tension: 0.35, pointRadius: 1, borderWidth: 2 },
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
          x: { ticks: { color: '#5c6f8f', font: { size: 9 } }, grid: { color: '#0f172d' } },
          y: { min: 0, max: 100, ticks: { color: '#5c6f8f', font: { size: 9 }, callback: v => v + '%' }, grid: { color: '#0f172d' } }
        }
      }
    });
  }
}

function renderTimeline(events) {
  const feed = document.getElementById('timelineFeed');
  if (!events.length) {
    feed.innerHTML = '<div class="empty">No timeline events yet.</div>';
    return;
  }
  feed.innerHTML = events.slice(0, 20).map(function(e) {
    return '<div class="timeline-entry">' +
      '<div class="timeline-meta">' +
        '<div class="timeline-icon">' + (e.badge === 'HEARTBEAT' ? '⟳' : e.badge === 'SIGNAL TRIGGERED' ? '⚡' : e.badge === 'ACCELERATING' ? '↑' : e.badge === 'WATCHING' ? '◎' : e.badge === 'ERROR' ? '✕' : '●') + '</div>' +
        '<div class="timeline-body">' +
          '<div style="font-size:13px;color:#e8e6de;font-weight:700;">' + e.fixture + '</div>' +
          '<div style="font-size:12px;color:#8fa2c7;margin-top:4px;">' + e.message + '</div>' +
          '<div style="font-size:11px;color:#5f739d;margin-top:4px;">' + e.details + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="text-align:right;min-width:80px;">' +
        '<div class="timeline-badge">' + e.badge + '</div>' +
        '<div class="timeline-time">' + new Date(e.timestamp).toLocaleTimeString() + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function updateMarketPanel(info) {
  document.getElementById('marketHeadline').textContent = info.headline;
  document.getElementById('marketSummary').textContent = info.summary;
  document.getElementById('marketEdge').textContent = info.edge;
  document.getElementById('marketFocus').textContent = info.focus;
  document.getElementById('marketRecommendation').textContent = info.recommendation;
}

function updateAcc() {
  const legsSlider = document.getElementById('legsSlider');
  const confSlider = document.getElementById('confSlider');
  if (!legsSlider || !confSlider) return;

  const legs = +legsSlider.value;
  const conf = +confSlider.value / 100;
  const legsVal = document.getElementById('legsVal');
  const confVal = document.getElementById('confVal');
  const slipProb = document.getElementById('slipProb');

  if (legsVal) legsVal.textContent = legs;
  if (confVal) confVal.textContent = (conf * 100).toFixed(0);

  const probs = [];
  for (let n = 1; n <= legs; n++) probs.push(Math.pow(conf, n) * 100);
  const final = probs[probs.length - 1];

  if (slipProb) {
    slipProb.textContent = final.toFixed(2) + '%';
    slipProb.style.color = final >= 30 ? '#3dc9b0' : final >= 10 ? '#e8a33d' : '#e85d4a';
  }

  const data = { labels: probs.map((_, i) => 'Leg ' + (i + 1)), datasets: [{ label: 'Win probability', data: probs, borderColor: '#4f9eff', backgroundColor: 'rgba(79,158,255,0.08)', tension: 0.3, pointRadius: 2, borderWidth: 2, fill: true }] };
  if (accChart) { accChart.data = data; accChart.update(); }
  else {
    const ctx = document.getElementById('accChart')?.getContext('2d');
    if (!ctx) return;
    accChart = new Chart(ctx, { type:'line', data, options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} }, scales:{ x:{ticks:{color:'#5c6f8f',font:{size:9}},grid:{color:'#0f172d'}}, y:{min:0,max:100,ticks:{color:'#5c6f8f',font:{size:9},callback:v=>v+'%'},grid:{color:'#0f172d'}} } } });
  }
}

const legsSlider = document.getElementById('legsSlider');
const confSlider = document.getElementById('confSlider');
if (legsSlider) legsSlider.addEventListener('input', updateAcc);
if (confSlider) confSlider.addEventListener('input', updateAcc);
if (legsSlider && confSlider) updateAcc();

function updateProofPanel(proof) {
  const txEl = document.getElementById('proofTx');
  const link = document.getElementById('proofLink');
  if (!proof || !proof.transaction) {
    if (txEl) txEl.textContent = '—';
    if (link) { link.href = '#'; link.textContent = 'View on Solscan'; }
    return;
  }
  if (txEl) txEl.textContent = proof.transaction;
  if (link) { link.href = proof.url || '#'; link.textContent = 'Open on Solscan'; }
}

function getFlag(teamName) {
  const codes = {
    'Brazil': 'br', 'Japan': 'jp', 'France': 'fr', 'Sweden': 'se',
    'Netherlands': 'nl', 'Morocco': 'ma', 'Germany': 'de', 'Paraguay': 'py',
    'Argentina': 'ar', 'Cape Verde': 'cv', 'Ivory Coast': 'ci', 'Norway': 'no',
    'Colombia': 'co', 'Ghana': 'gh', 'Switzerland': 'ch', 'Algeria': 'dz',
    'USA': 'us', 'Bosnia & Herzegovina': 'ba', 'England': 'gb-eng', 'Congo DR': 'cd',
    'Australia': 'au', 'Egypt': 'eg', 'Mexico': 'mx', 'Ecuador': 'ec',
    'Belgium': 'be', 'Senegal': 'sn', 'Vietnam': 'vn', 'Myanmar': 'mm',
    'Spain': 'es', 'Portugal': 'pt', 'Uruguay': 'uy', 'South Korea': 'kr',
    'Canada': 'ca', 'Croatia': 'hr', 'Serbia': 'rs', 'Ukraine': 'ua',
    'Poland': 'pl', 'Denmark': 'dk', 'Iran': 'ir', 'Cameroon': 'cm',
    'Tunisia': 'tn', 'Saudi Arabia': 'sa', 'Qatar': 'qa',
  };
  const code = codes[teamName];
  if (!code) return '<span style="width:20px;display:inline-block;"></span>';
  return '<img src="https://flagcdn.com/20x15/' + code + '.png" width="20" height="15" style="border-radius:2px;vertical-align:middle;margin-right:5px;" alt="' + teamName + '">';
}

function renderFixtures(data) {
  document.getElementById('grid').innerHTML = data.map(function(f) {
    const s = f.signal;
    const statusLabel = s ? s.statusLabel.replace(' ', '_') : 'STABLE';
    const badge = f.current.inRunning
      ? '<span class="badge LIVE">🟢 LIVE</span>'
      : s
        ? '<span class="badge ' + statusLabel + '">' + s.emoji + ' ' + s.statusLabel + '</span>'
        : '<span class="badge STABLE">🟦 STABLE</span>';
    const detailBlocks = s
      ? '<div class="signal-grid">' +
          '<div class="signal-pill"><strong>Magnitude</strong><span>' + s.magnitude + '%</span></div>' +
          '<div class="signal-pill"><strong>Velocity</strong><span>' + s.velocity + 'x</span></div>' +
          '<div class="signal-pill"><strong>Consistency</strong><span>' + s.consistency + '%</span></div>' +
        '</div>'
      : '';
    const chartId = 'chart_' + f.id;
    let card = '<div class="card">' +
      '<div class="card-header"><div><div class="match-name">' + getFlag(f.home) + ' ' + f.home + ' vs ' + getFlag(f.away) + ' ' + f.away + '</div><div class="comp">' + f.competition + '</div></div>' + badge + '</div>' +
      probRow(getFlag(f.home) + ' ' + f.home, f.current.homePct, s?.homeDrift, 'fill-h') +
      probRow('Draw', f.current.drawPct, s?.drawDrift, 'fill-d') +
      probRow(getFlag(f.away) + ' ' + f.away, f.current.awayPct, s?.awayDrift, 'fill-a') +
      detailBlocks +
      (s ? '<div class="signal-box ' + s.confidence + '"><div class="signal-top"><span class="signal-label">' + s.confidence + ' CONFIDENCE</span><span class="signal-score">' + s.score + '</span></div><div class="signal-reason">' + s.reason + '</div></div>' : '') +
      (f.history.length > 1 ? '<div class="chart-wrap" style="height:88px;margin-top:14px;"><canvas id="' + chartId + '"></canvas></div>' : '') +
    '</div>';
    return card;
  }).join('');

  data.forEach(f => {
    if (f.history.length > 1) renderChart('chart_' + f.id, f.history);
  });
}

async function refresh() {
  const d = await fetch('/data').then(r => r.json());
  console.log('refresh()', { pollCount: d.pollCount, fixtures: d.fixtures.length, divergences: d.divergences.length });
  document.getElementById('sPoll').textContent = d.pollCount;
  document.getElementById('sFix').textContent = d.fixtures.length;
  document.getElementById('sDiv').textContent = d.divergences.length;
  document.getElementById('sTime').textContent = new Date().toLocaleTimeString();
  if (!replayActive) liveData = d.fixtures;
  renderFixtures(d.fixtures);
  renderTimeline(d.timeline);
  updateMarketPanel(d.marketIntel);

  const logBody = document.getElementById('logBody');
  if (logBody) {
    if (!d.divergences.length) {
      logBody.innerHTML = '<tr><td colspan="6" class="empty">Watching for divergences...</td></tr>';
    } else {
      logBody.innerHTML = d.divergences.slice(0, 15).map(function(e) {
      return '<tr>' +
        '<td>' + new Date(e.timestamp).toLocaleTimeString() + '</td>' +
        '<td>' + e.fixture + '</td>' +
        '<td><span class="score-pill">' + e.signal.score + '</span></td>' +
        '<td class="conf-' + e.signal.confidence + '">' + e.signal.confidence + '</td>' +
        '<td>' + e.signal.magnitude + '%</td>' +
        '<td style="color:#8a96b5;max-width:260px">' + e.signal.reason + '</td>' +
      '</tr>';
    }).join('');
    }
  }
}

// ---- DEMO REPLAY MODE ----
const REPLAY_SCRIPT = [
  {
    step: 1,
    label: "Scanning",
    duration: 8000,
    narrative: "Engine scanning all fixtures — market stable, no signals detected.",
    fixture: "Brazil vs Japan",
    odds: { homePct: 41.2, drawPct: 38.5, awayPct: 20.3 },
    signal: { score: 8, confidence: "LOW", status: "STABLE", magnitude: 0.12, velocity: 1.0, consistency: 33, reason: "0.12% movement within normal noise range." }
  },
  {
    step: 2,
    label: "Watching",
    duration: 8000,
    narrative: "Brazil vs Japan odds beginning to shift — engine registers first movement.",
    fixture: "Brazil vs Japan",
    odds: { homePct: 38.9, drawPct: 40.1, awayPct: 21.0 },
    signal: { score: 32, confidence: "LOW", status: "WATCHING", magnitude: 2.3, velocity: 1.1, consistency: 66, reason: "2.3% drift detected — monitoring for continuation." }
  },
  {
    step: 3,
    label: "Accelerating",
    duration: 8000,
    narrative: "Movement accelerating above fixture baseline — velocity rising.",
    fixture: "Brazil vs Japan",
    odds: { homePct: 34.1, drawPct: 43.7, awayPct: 22.2 },
    signal: { score: 54, confidence: "MEDIUM", status: "ACCELERATING", magnitude: 6.8, velocity: 1.4, consistency: 66, reason: "6.80% smoothed drift, velocity 1.40x recent average." }
  },
  {
    step: 4,
    label: "Signal Triggered",
    duration: 10000,
    narrative: "⚡ SIGNAL TRIGGERED — market moving sharply beyond baseline. Divergence logged.",
    fixture: "Brazil vs Japan",
    odds: { homePct: 28.4, drawPct: 48.2, awayPct: 23.4 },
    signal: { score: 78, confidence: "HIGH", status: "SIGNAL_TRIGGERED", magnitude: 12.8, velocity: 1.5, consistency: 100, reason: "12.80% drift with sustained direction and velocity 1.50x." }
  },
  {
    step: 5,
    label: "Explaining",
    duration: 8000,
    narrative: "Engine explains the signal — breakdown visible across Magnitude, Velocity, Consistency.",
    fixture: "Brazil vs Japan",
    odds: { homePct: 27.1, drawPct: 49.5, awayPct: 23.4 },
    signal: { score: 81, confidence: "HIGH", status: "SIGNAL_TRIGGERED", magnitude: 14.1, velocity: 1.5, consistency: 100, reason: "14.10% drift with sustained direction and velocity 1.50x — sharp money detected." }
  },
  {
    step: 6,
    label: "Complete",
    duration: 8000,
    narrative: "✅ Replay complete. Engine returns to live monitoring. Divergence logged to history.",
    fixture: "Brazil vs Japan",
    odds: { homePct: 27.1, drawPct: 49.5, awayPct: 23.4 },
    signal: { score: 81, confidence: "HIGH", status: "SIGNAL_TRIGGERED", magnitude: 14.1, velocity: 1.5, consistency: 100, reason: "14.10% drift confirmed across 5 consecutive polls." }
  }
];

function runReplayStep(stepIndex) {
  if (stepIndex >= REPLAY_SCRIPT.length) {
    // Replay complete — restore live data
    endReplay();
    return;
  }

  const step = REPLAY_SCRIPT[stepIndex];
  replayPhase = stepIndex + 1;

  // Update status bar
  document.getElementById('replayStatus').textContent = step.label;
  document.getElementById('replayStep').textContent = step.step + '/6';

  // Add countdown
  let remaining = Math.floor(step.duration / 1000);
  document.getElementById('replayRemaining').textContent = remaining + 's';
  const countdownInterval = setInterval(() => {
    remaining--;
    document.getElementById('replayRemaining').textContent = remaining + 's';
    if (remaining <= 0) clearInterval(countdownInterval);
  }, 1000);

  // Build fake fixture data for this step
  const fakeFixture = {
    id: 99999,
    name: '🇧🇷 Brazil vs 🇯🇵 Japan',
    home: 'Brazil',
    away: 'Japan',
    competition: 'World Cup — DEMO REPLAY',
    current: {
      homePct: step.odds.homePct,
      drawPct: step.odds.drawPct,
      awayPct: step.odds.awayPct,
      inRunning: false,
    },
    signal: step.signal,
    history: [],
    proof: { transaction: 'N/A', url: '#' }
  };

  // Build history for chart (simulated movement)
  const historyPoints = [];
  for (let i = 6; i >= 0; i--) {
    historyPoints.push({
      homePct: step.odds.homePct + (i * 2.1),
      drawPct: step.odds.drawPct - (i * 1.8),
      awayPct: step.odds.awayPct - (i * 0.3),
    });
  }
  fakeFixture.history = historyPoints;

  // Inject fake data into grid (keep real fixtures, add replay fixture first)
  const replayData = [fakeFixture, ...(savedLiveData || [])];
  renderFixtures(replayData);

  // Add timeline event
  const timelineEntry = {
    timestamp: new Date().toISOString(),
    fixture: 'Brazil vs Japan',
    icon: step.signal.status === 'SIGNAL_TRIGGERED' ? '⚡' : step.signal.status === 'ACCELERATING' ? '↑' : step.signal.status === 'WATCHING' ? '◎' : '●',
    badge: step.label.toUpperCase(),
    message: step.narrative,
    details: step.signal.reason,
  };

  // Prepend to timeline
  const feed = document.getElementById('timelineFeed');
  const entry = document.createElement('div');
  entry.className = 'timeline-entry';
  entry.style.background = step.signal.status === 'SIGNAL_TRIGGERED' ? 'rgba(255,100,50,0.05)' : 'transparent';
  entry.innerHTML =
    '<div class="timeline-meta" style="display:flex;gap:10px;align-items:flex-start;">' +
      '<div class="timeline-icon">' + timelineEntry.icon + '</div>' +
      '<div class="timeline-body">' +
        '<div class="timeline-fixture">' + timelineEntry.fixture + '</div>' +
        '<div class="timeline-msg">' + timelineEntry.message + '</div>' +
        '<div class="timeline-detail">' + timelineEntry.details + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="timeline-right">' +
      '<div class="timeline-badge">' + timelineEntry.badge + '</div>' +
      '<div class="timeline-time">' + new Date().toLocaleTimeString() + '</div>' +
    '</div>';
  if (feed.firstChild) {
    feed.insertBefore(entry, feed.firstChild);
  } else {
    feed.appendChild(entry);
  }

  // If signal triggered — add to divergence log
  if (step.signal.status === 'SIGNAL_TRIGGERED') {
    const logBody = document.getElementById('logBody');
    const row = document.createElement('tr');
    row.style.background = 'rgba(255,100,50,0.05)';
    row.innerHTML =
      '<td>' + new Date().toLocaleTimeString() + '</td>' +
      '<td>🇧🇷 Brazil vs 🇯🇵 Japan (REPLAY)</td>' +
      '<td><span class="score-pill">' + step.signal.score + '</span></td>' +
      '<td class="conf-HIGH">HIGH</td>' +
      '<td>' + step.signal.magnitude + '%</td>' +
      '<td style="color:#8a96b5;max-width:260px">' + step.signal.reason + '</td>';
    if (logBody.querySelector('.empty')) logBody.innerHTML = '';
    logBody.insertBefore(row, logBody.firstChild);
  }

  // Scroll replay fixture into view
  const cards = document.querySelectorAll('.card');
  if (cards[0]) cards[0].scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Schedule next step
  replayTimer = setTimeout(() => runReplayStep(stepIndex + 1), step.duration);
}

function endReplay() {
  replayActive = false;
  replayTimer = null;
  document.getElementById('replayStatus').textContent = 'Complete';
  document.getElementById('replayStep').textContent = '6/6';
  document.getElementById('replayRemaining').textContent = '--s';
  document.getElementById('demoReplayBtn').textContent = 'Launch replay';
  document.getElementById('demoReplayBtn').disabled = false;

  // Restore live fixtures after 3 seconds
  setTimeout(() => {
    if (savedLiveData) renderFixtures(savedLiveData);
    document.getElementById('replayStatus').textContent = 'Idle';
    document.getElementById('replayStep').textContent = '0/6';
  }, 3000);
}

function startReplay() {
  if (replayActive) return;
  replayActive = true;

  // Save current live data so we can restore it after
  savedLiveData = [...liveData];

  document.getElementById('demoReplayBtn').textContent = 'Replaying...';
  document.getElementById('demoReplayBtn').disabled = true;
  document.getElementById('replayStatus').textContent = 'Starting';
  document.getElementById('replayStep').textContent = '0/6';

  // Small delay before first step so judges can see it starting
  setTimeout(() => runReplayStep(0), 800);
}

document.getElementById('demoReplayBtn').addEventListener('click', startReplay);

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pollCount, fixtures: liveData, divergences: divergenceLog, timeline: eventTimeline, marketIntel }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
});

server.listen(3000, () => {
  console.log("\n+------------------------------------------+");
  console.log("�   DIVERGENCE ENGINE � Web Dashboard      �");
  console.log("�------------------------------------------�");
  console.log("�   Open: http://localhost:3000            �");
  console.log("+------------------------------------------+\n");
});

poll();
setInterval(poll, POLL_INTERVAL_MS);
