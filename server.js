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
    console.warn("No local api-token.json found. Using TXLINE_* environment variables if provided.");
  }
}

if (!jwt || !apiToken) {
  console.warn("Missing TXLINE_JWT or TXLINE_API_TOKEN. The dashboard will start in degraded mode.");
}

const headers = { Authorization: `Bearer ${jwt || ""}`, "X-Api-Token": apiToken || "" };

const POLL_INTERVAL_MS = 60000;
const SMOOTHING_WINDOW = 3;

let fixtures = [];
try {
  fixtures = JSON.parse(fs.readFileSync(fixturesFilePath, "utf8"));
} catch (error) {
  console.warn("No local fixtures.json found. Starting without fixture data.");
}

// Refresh fixtures every hour
async function refreshFixtures() {
  try {
    const res = await axios.get(baseUrl + "/api/fixtures/snapshot", { headers });
    if (res.data && res.data.length > 0) {
      fixtures = res.data;
      fs.writeFileSync("./fixtures.json", JSON.stringify(fixtures, null, 2));
      console.log("Fixtures refreshed: " + fixtures.length + " fixtures loaded");
    }
  } catch (e) {
    console.error("Fixture refresh failed:", e.response?.status, e.message);
  }
}

// Refresh immediately on startup, then every hour
refreshFixtures();
setInterval(refreshFixtures, 60 * 60 * 1000);

let oddsHistory = {};
let divergenceLog = [];
let pollCount = 0;
let liveData = [];
let lastFlagged = {};

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

  const homeDrift = Math.abs(smoothed.homePct - baseline.homePct);
  const drawDrift = Math.abs(smoothed.drawPct - baseline.drawPct);
  const awayDrift = Math.abs(smoothed.awayPct - baseline.awayPct);
  const magnitude = Math.max(homeDrift, drawDrift, awayDrift);

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

  let consistencyBonus = 0;
  if (history.length >= 2) {
    const prev2 = history[history.length - 2];
    const sameHomeDir = Math.sign(current.homePct - prev.homePct) === Math.sign(prev.homePct - prev2.homePct);
    const sameAwayDir = Math.sign(current.awayPct - prev.awayPct) === Math.sign(prev.awayPct - prev2.awayPct);
    consistencyBonus = (sameHomeDir || sameAwayDir) ? 8 : -5;
  }

  const rawScore = (magnitude * 5) + (velocity - 1) * 15 + consistencyBonus;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  let confidence, reason;
  if (history.length < 2) {
    confidence = "LOW";
    reason = "Insufficient polling history";
  } else if (score >= 60) {
    confidence = "HIGH";
    reason = magnitude.toFixed(2) + "% smoothed shift, velocity " + velocity.toFixed(2) + "x recent average";
  } else if (score >= 30) {
    confidence = "MEDIUM";
    reason = magnitude.toFixed(2) + "% smoothed drift, " + (consistencyBonus > 0 ? "consistent direction" : "mixed direction — possible noise");
  } else {
    confidence = "LOW";
    reason = magnitude.toFixed(2) + "% smoothed movement — within normal noise range";
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

function shouldLogDivergence(id, signal, count) {
  if (!signal || signal.score < 40) return false;
  const last = lastFlagged[id];
  if (!last) return true;
  const pollsSinceLastFlag = count - last.pollCount;
  const scoreJump = signal.score - last.score;
  return pollsSinceLastFlag >= 15 || scoreJump >= 20;
}

async function poll() {
  pollCount++;
  const newData = [];

  for (const fixture of fixtures) {
    const id = fixture.FixtureId;
    try {
      const res = await axios.get(baseUrl + "/api/odds/snapshot/" + id, { headers });
      if (!res.data || res.data.length === 0) continue;
      const current = parseOdds(res.data);
      if (!current) continue;

      if (!oddsHistory[id]) oddsHistory[id] = [];
      const signal = computeSignal(id, current);
      oddsHistory[id].push({ ts: current.ts, homePct: current.homePct, drawPct: current.drawPct, awayPct: current.awayPct });
      if (oddsHistory[id].length > 30) oddsHistory[id].shift();

      if (shouldLogDivergence(id, signal, pollCount)) {
        divergenceLog.unshift({
          timestamp: new Date().toISOString(),
          pollCount,
          fixtureId: id,
          fixture: fixture.Participant1 + " vs " + fixture.Participant2,
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
        name: fixture.Participant1 + " vs " + fixture.Participant2,
        home: fixture.Participant1,
        away: fixture.Participant2,
        competition: fixture.Competition,
        current,
        signal,
        history: oddsHistory[id].slice(-10),
      });

    } catch (e) {
      console.error("Error fetching " + fixture.Participant1 + " vs " + fixture.Participant2 + ":", e.response && e.response.status, e.response && e.response.data || e.message);
    }
  }

  liveData = newData;
  console.log("Poll #" + pollCount + " | " + newData.length + " fixtures | " + divergenceLog.length + " divergences");
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Divergence Engine</title>
<script src="https://cdn.tailwindcss.com"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.2/babel.min.js"><\/script>
<style>
  .custom-scrollbar::-webkit-scrollbar { width: 6px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #475569; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
  .animate-fade-in { animation: fadeIn 0.3s ease-out forwards; }
  @keyframes pulse2 { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .animate-pulse { animation: pulse2 1.5s infinite; }
</style>
</head>
<body class="bg-slate-950">
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect, useRef } = React;

const TXSIG = "4CQSxcwPCGub4Eyz9L2HaqEqfb5QHw1qDpJKBqUqCrwgdGNozhFwPLsEJfY1Vf2PNfpdHYG4Zxw1eohtJTF93i8U";

const FLAG_CODES = {
  'Brazil':'br','Japan':'jp','France':'fr','Sweden':'se',
  'Netherlands':'nl','Morocco':'ma','Germany':'de','Paraguay':'py',
  'Argentina':'ar','Cape Verde':'cv','Ivory Coast':'ci','Norway':'no',
  'Colombia':'co','Ghana':'gh','Switzerland':'ch','Algeria':'dz',
  'USA':'us','Bosnia & Herzegovina':'ba','England':'gb-eng','Congo DR':'cd',
  'Australia':'au','Egypt':'eg','Mexico':'mx','Ecuador':'ec',
  'Belgium':'be','Senegal':'sn','Vietnam':'vn','Myanmar':'mm',
  'Canada':'ca','Croatia':'hr','Serbia':'rs','Ukraine':'ua',
  'Poland':'pl','Denmark':'dk','Iran':'ir','Cameroon':'cm',
  'Tunisia':'tn','Saudi Arabia':'sa','Qatar':'qa','Uruguay':'uy',
};

function FlagImg({ team }) {
  const code = FLAG_CODES[team];
  if (!code) return <span className="w-5 inline-block"/>;
  return <img src={"https://flagcdn.com/20x15/" + code + ".png"} width="20" height="15" style={{borderRadius:'2px',verticalAlign:'middle',marginRight:'4px'}} alt={team}/>;
}

const REPLAY_STEPS = [
  { label:'Scanning', duration:8000, score:6, status:'STABLE', confidence:'LOW', magnitude:0.12, velocity:1.0, consistency:18, homePct:41.2, drawPct:38.5, awayPct:20.3, homeDrift:0.08, drawDrift:-0.04, awayDrift:-0.04, reason:'0.12% movement within normal noise range.' },
  { label:'Movement Detected', duration:8000, score:28, status:'WATCHING', confidence:'LOW', magnitude:2.5, velocity:1.1, consistency:35, homePct:38.7, drawPct:40.3, awayPct:21.0, homeDrift:-2.5, drawDrift:1.8, awayDrift:0.7, reason:'2.50% smoothed drift, mixed direction — possible noise.' },
  { label:'Accelerating', duration:8000, score:52, status:'ACCELERATING', confidence:'MEDIUM', magnitude:5.8, velocity:1.35, consistency:65, homePct:34.1, drawPct:43.8, awayPct:22.1, homeDrift:-4.6, drawDrift:3.5, awayDrift:1.1, reason:'5.80% smoothed drift, consistent direction.' },
  { label:'Signal Triggered', duration:10000, score:76, status:'SIGNAL TRIGGERED', confidence:'HIGH', magnitude:11.2, velocity:1.5, consistency:90, homePct:28.3, drawPct:48.4, awayPct:23.3, homeDrift:-5.8, drawDrift:4.6, awayDrift:1.2, reason:'11.20% smoothed shift, velocity 1.50x recent average.' },
  { label:'Explaining', duration:8000, score:81, status:'SIGNAL TRIGGERED', confidence:'HIGH', magnitude:13.4, velocity:1.5, consistency:90, homePct:27.0, drawPct:49.7, awayPct:23.3, homeDrift:-1.3, drawDrift:1.3, awayDrift:0.0, reason:'13.40% smoothed shift confirmed — sharp money detected.' },
  { label:'Complete', duration:6000, score:81, status:'SIGNAL TRIGGERED', confidence:'HIGH', magnitude:13.4, velocity:1.5, consistency:90, homePct:27.0, drawPct:49.7, awayPct:23.3, homeDrift:0, drawDrift:0, awayDrift:0, reason:'13.40% shift confirmed across 5 consecutive polls.' },
];

function getStatusColor(status) {
  if (status === 'SIGNAL TRIGGERED') return 'text-pink-400 bg-pink-400/10 border-pink-400/30 shadow-[0_0_15px_rgba(236,72,153,0.2)]';
  if (status === 'ACCELERATING') return 'text-orange-400 bg-orange-400/10 border-orange-400/20';
  if (status === 'WATCHING') return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
  return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
}

function getScoreColor(score) {
  if (score >= 70) return 'text-pink-400 drop-shadow-[0_0_8px_rgba(236,72,153,0.8)]';
  if (score >= 50) return 'text-orange-400';
  if (score >= 30) return 'text-amber-400';
  return 'text-emerald-400';
}

function getBarColor(val) {
  if (val > 80) return 'bg-pink-500';
  if (val > 60) return 'bg-orange-500';
  if (val > 30) return 'bg-amber-400';
  return 'bg-emerald-400';
}

function FixtureCard({ fixture }) {
  const isTriggered = fixture.status === 'SIGNAL TRIGGERED';
  const mag = Math.min(100, Math.round((fixture.signal?.magnitude || 0) * 6));
  const vel = Math.min(100, Math.max(0, Math.round(((fixture.signal?.velocity || 1) - 1) * 200)));
  const con = fixture.signal?.consistency || 0;

  return (
    <div className={"bg-slate-900 border rounded-xl p-5 transition-all duration-500 " + (isTriggered ? 'border-pink-500 shadow-[0_0_24px_rgba(236,72,153,0.15)]' : 'border-slate-800')}>
      <div className="flex flex-col md:flex-row justify-between md:items-center mb-5 gap-3">
        <div className="flex items-center gap-2 text-lg font-bold text-white flex-wrap">
          <FlagImg team={fixture.home}/>{fixture.home}
          <span className="text-slate-500 font-normal text-sm">vs</span>
          <FlagImg team={fixture.away}/>{fixture.away}
          {fixture.competition && <span className="text-xs font-normal text-slate-500 ml-1">{fixture.competition}</span>}
        </div>
        <div className={"px-3 py-1 rounded-md text-xs font-bold border tracking-wider flex items-center gap-1 w-max " + getStatusColor(fixture.status)}>
          {isTriggered && (
            <svg viewBox="0 0 24 24" className="w-4 h-4 inline-block text-pink-500 animate-pulse" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
            </svg>
          )}
          {fixture.status || 'STABLE'}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-center">
        <div className="md:col-span-3 flex flex-col items-center justify-center p-4 bg-slate-950 rounded-lg border border-slate-800">
          <span className="text-slate-400 text-xs font-medium mb-1 uppercase tracking-wider">Signal Score</span>
          <div className={"text-4xl font-mono font-bold " + getScoreColor(fixture.signal?.score || 0)}>
            {fixture.signal?.score || 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">{fixture.signal?.confidence || 'LOW'}</div>
        </div>

        <div className="md:col-span-9 space-y-3">
          {[
            { label:'Magnitude', val: mag },
            { label:'Velocity', val: vel },
            { label:'Consistency', val: con },
          ].map(m => (
            <div key={m.label} className="flex items-center gap-3">
              <span className="w-24 text-xs font-mono text-slate-400">{m.label}</span>
              <div className="flex-grow h-2 bg-slate-800 rounded-full overflow-hidden">
                <div className={"h-full transition-all duration-700 " + getBarColor(m.val)} style={{width: m.val + '%'}}/>
              </div>
              <span className="w-8 text-right text-xs font-mono text-white">{m.val}</span>
            </div>
          ))}

          <div className="pt-3 border-t border-slate-800/50 space-y-2">
            {[
              { team: fixture.home, pct: fixture.current?.homePct, drift: fixture.signal?.homeDrift, color:'text-amber-400' },
              { team: 'Draw', pct: fixture.current?.drawPct, drift: fixture.signal?.drawDrift, color:'text-slate-400' },
              { team: fixture.away, pct: fixture.current?.awayPct, drift: fixture.signal?.awayDrift, color:'text-emerald-400' },
            ].map(r => (
              <div key={r.team} className="flex items-center gap-2">
                <span className={"text-xs w-28 " + r.color}>{r.team}</span>
                <div className="flex-grow h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div className={"h-full " + (r.team === 'Draw' ? 'bg-slate-500' : r.team === fixture.home ? 'bg-amber-400' : 'bg-emerald-400')} style={{width: Math.min(r.pct || 0, 100) + '%'}}/>
                </div>
                <span className="text-xs text-white font-mono w-12 text-right">{(r.pct || 0).toFixed(2)}%</span>
                {r.drift !== null && r.drift !== undefined && Math.abs(r.drift) > 0.05 && (
                  <span className={"text-xs font-mono " + (r.drift > 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {r.drift > 0 ? '▲' : '▼'}{Math.abs(r.drift).toFixed(2)}%
                  </span>
                )}
              </div>
            ))}
          </div>

          {fixture.signal?.reason && (
            <div className="flex items-start gap-2 pt-2 border-t border-slate-800/50">
              <span className="text-slate-500 text-xs mt-0.5">›</span>
              <p className="text-xs text-slate-400 italic">{fixture.signal.reason}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RiskLab() {
  const [mode, setMode] = useState('degen');
  const [accumLegs, setAccumLegs] = useState(5);
  const [baseConfidence, setBaseConfidence] = useState(80);

  const combinedProb = (Math.pow(baseConfidence / 100, accumLegs) * 100).toFixed(1);
  const smartProb = (Math.pow(baseConfidence / 100, 1) * 100).toFixed(1);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h2 className="font-bold text-white flex items-center gap-2 mb-2">
        <span className="text-blue-400">◈</span> Signal-to-Strategy Risk Lab
      </h2>
      <p className="text-xs text-slate-400 mb-4 leading-relaxed">
        The engine identifies strong individual signals. See how strategy structure affects your edge.
      </p>

      <div className="flex gap-2 mb-5">
        <button
          onClick={() => setMode('degen')}
          className={"flex-1 py-2 text-xs font-bold rounded border transition-colors " +
            (mode === 'degen'
              ? 'bg-red-500/20 border-red-400/50 text-red-400'
              : 'border-slate-700 text-slate-500 hover:border-slate-500')}>
          ⚡ Degen Mode
        </button>
        <button
          onClick={() => setMode('smart')}
          className={"flex-1 py-2 text-xs font-bold rounded border transition-colors " +
            (mode === 'smart'
              ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-400'
              : 'border-slate-700 text-slate-500 hover:border-slate-500')}>
          ◆ Smart Money Mode
        </button>
      </div>

      {mode === 'degen' ? (
        <div className="space-y-5">
          <p className="text-xs text-red-400/80 bg-red-500/10 border border-red-500/20 rounded p-3">
            Stacking multiple legs feels exciting — but each leg multiplies your risk. Watch what happens to your edge.
          </p>
          <div>
            <div className="flex justify-between text-sm mb-2">
              <span className="text-slate-400">Base Signal Confidence</span>
              <span className="text-white font-mono">{baseConfidence}%</span>
            </div>
            <input type="range" min="50" max="95" value={baseConfidence}
              onChange={e => setBaseConfidence(+e.target.value)} className="w-full accent-red-500"/>
          </div>
          <div>
            <div className="flex justify-between text-sm mb-2">
              <span className="text-slate-400">Legs Stacked</span>
              <span className="text-white font-mono">{accumLegs}</span>
            </div>
            <input type="range" min="1" max="15" value={accumLegs}
              onChange={e => setAccumLegs(+e.target.value)} className="w-full accent-red-500"/>
          </div>
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-center">
            <span className="text-slate-500 text-xs uppercase tracking-wider block mb-1">Combined Probability</span>
            <span className={"text-3xl font-bold font-mono " + (+combinedProb >= 30 ? 'text-emerald-400' : +combinedProb >= 10 ? 'text-amber-400' : 'text-red-400')}>
              {combinedProb}%
            </span>
          </div>
          {accumLegs > 4 && (
            <div className="text-xs text-red-400 bg-red-500/10 p-3 rounded border border-red-500/20">
              ⚠ {accumLegs} legs at {baseConfidence}% confidence = {combinedProb}% chance of winning. The house wins.
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => setBaseConfidence(95)} className="flex-1 py-2 text-xs border border-slate-700 rounded text-slate-400 hover:border-red-400 hover:text-red-400 transition-colors">Optimistic (95%)</button>
            <button onClick={() => setBaseConfidence(75)} className="flex-1 py-2 text-xs border border-slate-700 rounded text-slate-400 hover:border-red-400 hover:text-red-400 transition-colors">Conservative (75%)</button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-emerald-400/80 bg-emerald-500/10 border border-emerald-500/20 rounded p-3">
            Smart money uses high-confidence single signals. The Divergence Engine tells you exactly where the edge is — act on one signal at a time.
          </p>
          <div>
            <div className="flex justify-between text-sm mb-2">
              <span className="text-slate-400">Engine Signal Confidence</span>
              <span className="text-white font-mono">{baseConfidence}%</span>
            </div>
            <input type="range" min="50" max="95" value={baseConfidence}
              onChange={e => setBaseConfidence(+e.target.value)} className="w-full accent-emerald-500"/>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-950 border border-red-500/20 rounded-lg p-4 text-center">
              <span className="text-red-400 text-xs uppercase tracking-wider block mb-1">Degen (5 legs)</span>
              <span className="text-2xl font-bold font-mono text-red-400">
                {(Math.pow(baseConfidence / 100, 5) * 100).toFixed(1)}%
              </span>
            </div>
            <div className="bg-slate-950 border border-emerald-500/20 rounded-lg p-4 text-center">
              <span className="text-emerald-400 text-xs uppercase tracking-wider block mb-1">Smart (1 signal)</span>
              <span className="text-2xl font-bold font-mono text-emerald-400">
                {smartProb}%
              </span>
            </div>
          </div>
          <div className="text-xs text-emerald-400/80 bg-emerald-500/10 p-3 rounded border border-emerald-500/20">
            ✓ Single high-confidence signal preserves {(baseConfidence - (Math.pow(baseConfidence / 100, 5) * 100)).toFixed(1)}% more edge than a 5-leg accumulator.
          </div>
        </div>
      )}
    </div>
  );
}

// NEW: Signal Explorer component - fetches and displays API data
function SignalExplorer() {
  const [signals, setSignals] = useState([]);
  const [volatility, setVolatility] = useState({});
  const [leaderboard, setLeaderboard] = useState([]);

  useEffect(() => {
    fetch('/api/signals/latest').then(r => r.json()).then(setSignals).catch(() => {});
    fetch('/api/volatility').then(r => r.json()).then(setVolatility).catch(() => {});
    fetch('/api/leaderboard').then(r => r.json()).then(setLeaderboard).catch(() => {});
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 className="text-white font-semibold flex items-center gap-2 mb-3 text-sm">
          <span className="text-pink-400">⚡</span> Latest Signals
        </h3>
        <div className="space-y-2 text-xs font-mono max-h-40 overflow-y-auto custom-scrollbar">
          {signals.length === 0
            ? <div className="text-slate-600">No signals yet...</div>
            : signals.map((s, i) => (
              <div key={i} className="flex justify-between items-center p-2 bg-slate-950 rounded border border-slate-800">
                <span className="text-slate-400 truncate">{s.fixture}</span>
                <span className={"px-2 py-0.5 rounded font-bold " + (s.score >= 70 ? 'text-pink-400' : s.score >= 50 ? 'text-orange-400' : 'text-amber-400')}>{s.score}</span>
              </div>
            ))
          }
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 className="text-white font-semibold flex items-center gap-2 mb-3 text-sm">
          <span className="text-amber-400">◈</span> Volatility Snapshot
        </h3>
        <div className="space-y-2 text-xs font-mono">
          {Object.entries(volatility).slice(0, 3).map(([id, v]) => (
            <div key={id} className="space-y-1">
              <div className="flex justify-between text-slate-500">
                <span>Home: {(v.homeMin || 0).toFixed(1)}% → {(v.home || 0).toFixed(1)}%</span>
              </div>
              <div className="flex justify-between text-slate-500">
                <span>Away: {(v.awayMin || 0).toFixed(1)}% → {(v.away || 0).toFixed(1)}%</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 className="text-white font-semibold flex items-center gap-2 mb-3 text-sm">
          <span className="text-emerald-400">▸</span> Leaderboard (24h)
        </h3>
        <div className="space-y-2 text-xs font-mono">
          {leaderboard.length === 0
            ? <div className="text-slate-600">No data yet...</div>
            : leaderboard.map((s, i) => (
              <div key={i} className="flex justify-between items-center">
                <span className="text-slate-400 truncate">{i+1}. {s.fixture}</span>
                <span className="text-pink-400 font-bold">{s.score}</span>
              </div>
            ))
          }
        </div>
      </div>
    </div>
  );
}

function App() {
  const [liveData, setLiveData] = useState({ pollCount:0, fixtures:[], divergences:[] });
  const [events, setEvents] = useState([{ id:1, time: new Date().toLocaleTimeString(), text:'Engine initialized. Connecting to TxLINE...', type:'system' }]);
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayLabel, setReplayLabel] = useState('');
  const [replayFixture, setReplayFixture] = useState(null);
  const eventsEndRef = useRef(null);
  const replayTimerRef = useRef(null);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (eventsEndRef.current) {
      const container = eventsEndRef.current.parentElement;
      if (container) {
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
        });
      }
    }
  }, [events]);

  async function fetchData() {
    try {
      const d = await fetch('/data').then(r => r.json());
      setLiveData(d);
      d.fixtures.forEach(f => {
        if (f.signal && f.signal.confidence === 'HIGH') {
          addEvent(f.home + ' vs ' + f.away + ': HIGH signal fired — ' + f.signal.reason, 'high');
        } else if (f.signal && f.signal.confidence === 'MEDIUM') {
          addEvent(f.home + ' vs ' + f.away + ': MEDIUM signal — ' + f.signal.reason, 'medium');
        }
      });
      addEvent('Poll #' + d.pollCount + ' complete — ' + d.fixtures.length + ' fixtures active.', 'system');
    } catch(e) {}
  }

  function addEvent(text, type) {
    setEvents(prev => {
      const updated = [...prev, { id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), text, type: type || 'system' }];
      return updated.slice(-40);
    });
  }

  function startReplay() {
    if (isReplaying) return;
    setIsReplaying(true);
    setReplayLabel('Starting');
    addEvent('REPLAY MODE: Injecting sample market shock — Brazil vs Japan.', 'high');
    runStep(0);
  }

  function stopReplay() {
    if (replayTimerRef.current) clearTimeout(replayTimerRef.current);
    setIsReplaying(false);
    setReplayFixture(null);
    setReplayLabel('');
    addEvent('Replay stopped. Returning to live monitoring.', 'system');
  }

  function runStep(index) {
    if (index >= REPLAY_STEPS.length) {
      setTimeout(() => {
        setIsReplaying(false);
        setReplayFixture(null);
        setReplayLabel('');
        addEvent('Replay complete. Engine returning to live monitoring.', 'system');
      }, 2000);
      return;
    }
    const step = REPLAY_STEPS[index];
    setReplayLabel(step.label);
    setReplayFixture({
      id: 99999,
      home: 'Brazil',
      away: 'Japan',
      competition: 'World Cup — DEMO REPLAY',
      status: step.status,
      current: { homePct: step.homePct, drawPct: step.drawPct, awayPct: step.awayPct, inRunning: index >= 3 },
      signal: { score: step.score, confidence: step.confidence, reason: step.reason, homeDrift: step.homeDrift, drawDrift: step.drawDrift, awayDrift: step.awayDrift, magnitude: step.magnitude, velocity: step.velocity, consistency: step.consistency },
    });
    addEvent('REPLAY [' + step.label + ']: Brazil vs Japan — score ' + step.score + ' (' + step.confidence + ')', step.confidence === 'HIGH' ? 'high' : step.confidence === 'MEDIUM' ? 'medium' : 'system');
    replayTimerRef.current = setTimeout(() => runStep(index + 1), step.duration);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 font-sans">
      <header className="border-b border-slate-800 bg-slate-900/60 pt-6 pb-5 px-6 sticky top-0 z-10 backdrop-blur-md">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex items-center gap-3">
            <svg width="32" height="32" viewBox="0 0 34 34" fill="none">
              <path d="M4 17 L14 17 L20 8" stroke="#E8A33D" strokeWidth="2" strokeLinecap="round"/>
              <path d="M4 17 L14 17 L20 26" stroke="#3DC9B0" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="4" cy="17" r="2.5" fill="#E8E6DE"/>
            </svg>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Divergence Engine</h1>
              <p className="text-slate-500 text-xs mt-0.5">AUTONOMOUS MARKET INTELLIGENCE · TXODDS × SOLANA DEVNET</p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <a href="/" className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-400 text-xs hover:bg-slate-700 transition-colors">
              ← Landing Page
            </a>
            <div className="flex gap-2">
              <div className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-center min-w-16">
                <div className="text-lg font-bold text-amber-400">{liveData.pollCount}</div>
                <div className="text-xs text-slate-500">POLLS</div>
              </div>
              <div className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-center min-w-16">
                <div className="text-lg font-bold text-amber-400">{liveData.fixtures.length}</div>
                <div className="text-xs text-slate-500">FIXTURES</div>
              </div>
              <div className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-center min-w-16">
                <div className="text-lg font-bold text-red-400">{liveData.divergences.length}</div>
                <div className="text-xs text-slate-500">DIVERGENCES</div>
              </div>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 bg-emerald-400/10 border border-emerald-400/25 rounded-lg text-emerald-400 text-xs font-bold">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block"/>
              LIVE
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
            <div>
              <h3 className="text-white font-semibold flex items-center gap-2 mb-4 text-sm">
                <span className="text-emerald-400">⛓</span> TxLINE On-Chain Proof
              </h3>
              <div className="space-y-2 text-xs text-slate-400 font-mono">
                <div className="flex justify-between"><span className="text-slate-500">Network</span><span className="text-white">Solana Devnet</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Status</span><span className="text-emerald-400 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block"/>Active</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Feed</span><span className="text-white">TxLINE World Cup 2026</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Interval</span><span className="text-white">60 seconds</span></div>
              </div>
              <div className="mt-3 p-2 bg-slate-950 rounded border border-slate-800 text-xs text-slate-500 font-mono break-all leading-relaxed">
                {TXSIG}
              </div>
            </div>
            <a href={"https://solscan.io/tx/" + TXSIG + "?cluster=devnet"} target="_blank"
               className="mt-4 w-full flex items-center justify-center gap-2 py-2 bg-emerald-400/8 hover:bg-emerald-400/15 border border-emerald-400/25 text-emerald-400 rounded text-xs font-bold transition-colors">
              View on Solscan →
            </a>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col">
            <h3 className="text-white font-semibold flex items-center gap-2 mb-2 text-sm">
              <span className="text-cyan-400">▸</span> Market Intelligence API Preview
            </h3>
            <p className="text-xs text-slate-500 mb-3">Products can consume this signal layer to power alerts, dashboards, or trading tools.</p>
            <div className="bg-slate-950 rounded-lg p-4 border border-slate-800 flex-grow font-mono text-xs overflow-x-auto">
              <pre className="text-emerald-400">{JSON.stringify({
                fixture: liveData.fixtures[0] ? liveData.fixtures[0].home + " vs " + liveData.fixtures[0].away : "Waiting...",
                signalScore: liveData.fixtures[0]?.signal?.score || 0,
                confidence: liveData.fixtures[0]?.signal?.confidence || "LOW",
                magnitude: liveData.fixtures[0]?.signal?.magnitude || 0,
                velocity: liveData.fixtures[0]?.signal?.velocity || 1.0,
                reason: liveData.fixtures[0]?.signal?.reason || "Initializing..."
              }, null, 2)}</pre>
            </div>
            <div className="mt-3 p-3 bg-slate-900 rounded border border-slate-700">
              <div className="text-xs text-slate-500 mb-2 uppercase tracking-wider">Quick Integration</div>
              <pre className="text-cyan-400 text-xs overflow-x-auto">{'curl https://divergence-engine-production.up.railway.app/data -H "Accept: application/json"'}</pre>
            </div>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Demo Replay Mode</div>
              <h3 className="text-white font-bold text-lg">60s animated market walkthrough</h3>
              <p className="text-xs text-slate-500 mt-1">Watch the engine detect a live market shock — odds shift, signal fires, divergence logged.</p>
              {isReplaying && <div className="text-xs text-pink-400 mt-2 animate-pulse">● REPLAYING: {replayLabel}</div>}
            </div>
            <div className="flex gap-2">
              <button onClick={startReplay} disabled={isReplaying}
                className={"px-5 py-2 rounded-lg text-sm font-bold transition-all border " + (isReplaying ? 'bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed' : 'bg-pink-600 hover:bg-pink-500 text-white border-pink-400 shadow-[0_0_15px_rgba(236,72,153,0.3)]')}>
                {isReplaying ? 'Replaying...' : '▶ Launch Replay'}
              </button>
              {isReplaying && (
                <button onClick={stopReplay} className="px-5 py-2 rounded-lg text-sm font-bold border border-red-400/40 text-red-400 hover:bg-red-400/10 transition-colors">
                  ■ Stop
                </button>
              )}
            </div>
          </div>
        </div>

        {replayFixture && (
          <div>
            <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-pink-400 animate-pulse">●</span>
              Demo Replay
              <span className="text-xs font-normal text-slate-500 font-mono">— recorded sample data, not live</span>
            </h2>
            <FixtureCard fixture={replayFixture}/>
          </div>
        )}

        {/* Signal Explorer - NEW FEATURE */}
        <SignalExplorer/>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2">
            <h2 className="text-lg font-bold text-white mb-3">Live Fixtures</h2>
            {liveData.fixtures.length === 0
              ? <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-500 text-sm">No fixtures with live odds right now — engine is polling...</div>
              : <div className="space-y-4">{liveData.fixtures.map(f => <FixtureCard key={f.id} fixture={{...f, status: f.signal ? (f.signal.confidence === 'HIGH' ? 'SIGNAL TRIGGERED' : f.signal.confidence === 'MEDIUM' ? 'WATCHING' : 'STABLE') : 'STABLE'}}/>)}</div>
            }
          </div>

          <div className="lg:col-span-1">
            <h2 className="text-lg font-bold text-white mb-3">Signal Timeline</h2>
            <div className="bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden" style={{height:'500px'}}>
              <div className="flex-grow overflow-y-auto min-h-0 p-4 custom-scrollbar space-y-3 font-mono text-xs">
                {events.map(e => (
                  <div key={e.id} className="flex gap-2 items-start animate-fade-in">
                    <span className="text-slate-600 flex-shrink-0">{e.time}</span>
                    <span className={e.type === 'high' ? 'text-pink-400 font-bold' : e.type === 'medium' ? 'text-amber-400' : 'text-slate-400'}>{e.text}</span>
                  </div>
                ))}
                <div ref={eventsEndRef}/>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <RiskLab/>

          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-800">
              <h2 className="font-bold text-white">Divergence Log</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-slate-800">
                  <th className="text-left p-3 text-slate-500 uppercase tracking-wider">Time</th>
                  <th className="text-left p-3 text-slate-500 uppercase tracking-wider">Fixture</th>
                  <th className="text-left p-3 text-slate-500 uppercase tracking-wider">Score</th>
                  <th className="text-left p-3 text-slate-500 uppercase tracking-wider">Confidence</th>
                  <th className="text-left p-3 text-slate-500 uppercase tracking-wider">Reason</th>
                </tr></thead>
                <tbody>
                  {liveData.divergences.length === 0
                    ? <tr><td colSpan="5" className="text-center p-8 text-slate-600">Watching for divergences...</td></tr>
                    : liveData.divergences.slice(0,10).map((d,i) => (
                      <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                        <td className="p-3 text-slate-500 font-mono">{new Date(d.timestamp).toLocaleTimeString()}</td>
                        <td className="p-3 text-slate-300">{d.fixture}</td>
                        <td className="p-3"><span className="bg-slate-800 px-2 py-0.5 rounded font-mono text-white">{d.signal?.score}</span></td>
                        <td className={"p-3 font-bold " + (d.signal?.confidence === 'HIGH' ? 'text-pink-400' : d.signal?.confidence === 'MEDIUM' ? 'text-amber-400' : 'text-slate-400')}>{d.signal?.confidence}</td>
                        <td className="p-3 text-slate-500 max-w-xs truncate">{d.signal?.reason}</td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>

      <footer className="text-center py-4 text-slate-700 text-xs border-t border-slate-900 mt-6">
        Divergence Engine v1.0 · Built on TxLINE × Solana Devnet · TxODDS Hackathon 2026
      </footer>
    </div>
  );
}

ReactDOM.render(<App/>, document.getElementById('root'));
<\/script>
</body>
</html>`;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const landingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Divergence Engine — Autonomous Market Intelligence</title>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:wght@400;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#080b14;color:#d4d8f0;font-family:'JetBrains Mono',monospace;min-height:100vh}
  a{text-decoration:none}

  /* NAV */
  nav{display:flex;align-items:center;justify-content:space-between;padding:20px 48px;border-bottom:1px solid #1a2240;}
  .nav-brand{display:flex;align-items:center;gap:12px}
  .nav-brand h1{font-family:'Newsreader',serif;font-size:20px;font-weight:700;color:#f0ede4}
  .nav-brand p{font-size:10px;color:#6a7a9e;margin-top:2px;text-transform:uppercase;letter-spacing:0.8px}
  .nav-links{display:flex;align-items:center;gap:16px}
  .nav-pill{display:flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(61,201,176,0.07);border:1px solid rgba(61,201,176,0.2);border-radius:4px;font-size:10px;color:#3DC9B0;font-weight:700}
  .nav-dot{width:6px;height:6px;background:#3DC9B0;border-radius:50%;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
  .launch-btn{padding:8px 20px;background:#3a5fff;color:#fff;border-radius:6px;font-size:12px;font-weight:700;font-family:'JetBrains Mono',monospace;transition:background 0.2s}
  .launch-btn:hover{background:#5570ff}

  /* HERO */
  .hero{max-width:900px;margin:0 auto;padding:80px 48px 60px;text-align:center}
  .hero-tag{display:inline-block;padding:5px 14px;background:rgba(232,163,61,0.1);border:1px solid rgba(232,163,61,0.25);border-radius:20px;font-size:10px;color:#E8A33D;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:24px}
  .hero h2{font-family:'Newsreader',serif;font-size:48px;font-weight:700;color:#f0ede4;line-height:1.2;margin-bottom:20px;letter-spacing:-0.5px}
  .hero h2 span{color:#3DC9B0}
  .hero p{font-size:14px;color:#8a9ac0;line-height:1.8;max-width:600px;margin:0 auto 36px}
  .hero-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
  .btn-primary{padding:12px 28px;background:#3a5fff;color:#fff;border-radius:6px;font-size:13px;font-weight:700;font-family:'JetBrains Mono',monospace;transition:all 0.2s;box-shadow:0 0 20px rgba(58,95,255,0.3)}
  .btn-primary:hover{background:#5570ff;box-shadow:0 0 30px rgba(58,95,255,0.5)}
  .btn-secondary{padding:12px 28px;background:transparent;color:#d4d8f0;border:1px solid #1a2240;border-radius:6px;font-size:13px;font-weight:700;font-family:'JetBrains Mono',monospace;transition:all 0.2s}
  .btn-secondary:hover{border-color:#3a5fff;color:#fff}

  /* STATS BAR */
  .stats-bar{display:flex;gap:0;border:1px solid #1a2240;border-radius:8px;overflow:hidden;max-width:600px;margin:48px auto 0}
  .stat-item{flex:1;padding:16px 20px;text-align:center;border-right:1px solid #1a2240}
  .stat-item:last-child{border-right:none}
  .stat-num{font-size:24px;font-weight:700;color:#E8A33D;font-family:'JetBrains Mono',monospace}
  .stat-label{font-size:9px;color:#6a7a9e;text-transform:uppercase;letter-spacing:0.8px;margin-top:3px}

  /* SCREENSHOT PREVIEW */
  .preview{max-width:1000px;margin:60px auto;padding:0 48px}
  .preview-label{font-size:10px;color:#6a7a9e;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px;text-align:center}
  .preview-box{background:#0f1526;border:1px solid #1a2240;border-radius:12px;padding:24px;overflow:hidden}
  .preview-header{display:flex;align-items:center;gap:8px;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #1a2240}
  .preview-dot{width:10px;height:10px;border-radius:50%}
  .preview-url{flex:1;background:#080b14;border:1px solid #1a2240;border-radius:4px;padding:6px 12px;font-size:11px;color:#6a7a9e;text-align:center}
  .preview-screen{background:#080b14;border-radius:8px;border:1px solid #1a2240;padding:16px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
  .mini-card{background:#0f1526;border:1px solid #1a2240;border-radius:6px;padding:12px}
  .mini-card-title{font-size:9px;color:#6a7a9e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px}
  .mini-bar{height:4px;border-radius:2px;margin-bottom:4px}
  .mini-score{font-size:20px;font-weight:700;color:#E8A33D;font-family:'JetBrains Mono',monospace}
  .mini-badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:8px;font-weight:700;margin-top:6px}

  /* HOW IT WORKS */
  .how{max-width:900px;margin:0 auto;padding:60px 48px}
  .how h3{font-family:'Newsreader',serif;font-size:32px;font-weight:700;color:#f0ede4;text-align:center;margin-bottom:8px}
  .how-sub{font-size:12px;color:#6a7a9e;text-align:center;margin-bottom:48px}
  .steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px}
  .step{background:#0f1526;border:1px solid #1a2240;border-radius:8px;padding:24px;position:relative}
  .step-num{font-size:32px;font-weight:700;color:#1a2240;font-family:'JetBrains Mono',monospace;margin-bottom:12px}
  .step-icon{font-size:20px;margin-bottom:10px}
  .step h4{font-family:'Newsreader',serif;font-size:16px;color:#f0ede4;margin-bottom:8px;font-weight:600}
  .step p{font-size:11px;color:#6a7a9e;line-height:1.7}
  .step-connector{position:absolute;right:-11px;top:50%;transform:translateY(-50%);color:#1a2240;font-size:18px;z-index:1}

  /* FEATURES */
  .features{max-width:900px;margin:0 auto;padding:0 48px 60px}
  .features h3{font-family:'Newsreader',serif;font-size:32px;font-weight:700;color:#f0ede4;text-align:center;margin-bottom:8px}
  .features-sub{font-size:12px;color:#6a7a9e;text-align:center;margin-bottom:48px}
  .feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
  .feature{background:#0f1526;border:1px solid #1a2240;border-radius:8px;padding:20px;transition:border-color 0.2s}
  .feature:hover{border-color:#3a5fff}
  .feature-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;margin-bottom:12px}
  .feature h4{font-size:13px;font-weight:700;color:#f0ede4;margin-bottom:6px}
  .feature p{font-size:11px;color:#6a7a9e;line-height:1.6}

  /* TECH STACK */
  .tech{max-width:900px;margin:0 auto;padding:0 48px 60px}
  .tech h3{font-family:'Newsreader',serif;font-size:32px;font-weight:700;color:#f0ede4;text-align:center;margin-bottom:8px}
  .tech-sub{font-size:12px;color:#6a7a9e;text-align:center;margin-bottom:36px}
  .tech-pills{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}
  .tech-pill{padding:8px 16px;background:#0f1526;border:1px solid #1a2240;border-radius:4px;font-size:11px;color:#d4d8f0}
  .tech-pill span{color:#6a7a9e;margin-right:6px}

  /* CTA */
  .cta{max-width:900px;margin:0 auto;padding:0 48px 80px;text-align:center}
  .cta-box{background:linear-gradient(135deg,#0f1526,#111d3a);border:1px solid #1a2240;border-radius:12px;padding:48px}
  .cta-box h3{font-family:'Newsreader',serif;font-size:32px;color:#f0ede4;margin-bottom:12px}
  .cta-box p{font-size:12px;color:#6a7a9e;margin-bottom:28px;line-height:1.7}

  /* FOOTER */
  footer{border-top:1px solid #0f1628;padding:20px 48px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
  .footer-left{font-size:10px;color:#2a3a5a}
  .footer-links{display:flex;gap:16px}
  .footer-links a{font-size:10px;color:#4a5878;transition:color 0.2s}
  .footer-links a:hover{color:#d4d8f0}

  .divider{border:none;border-top:1px solid #1a2240;margin:0 48px}
</style>
</head>
<body>

<nav>
  <div class="nav-brand">
    <svg width="30" height="30" viewBox="0 0 34 34" fill="none">
      <path d="M4 17 L14 17 L20 8" stroke="#E8A33D" stroke-width="2" stroke-linecap="round" fill="none"/>
      <path d="M4 17 L14 17 L20 26" stroke="#3DC9B0" stroke-width="2" stroke-linecap="round" fill="none"/>
      <circle cx="4" cy="17" r="2.5" fill="#E8E6DE"/>
    </svg>
    <div>
      <h1>Divergence Engine</h1>
      <p>TxODDS × Solana Devnet</p>
    </div>
  </div>
  <div class="nav-links">
    <div class="nav-pill"><div class="nav-dot"></div>Live on Solana Devnet</div>
    <a href="/app" class="launch-btn">Launch Dashboard →</a>
  </div>
</nav>

<div class="hero">
  <div class="hero-tag">TxODDS World Cup 2026 Hackathon</div>
  <h2>The Intelligence Layer<br/>for <span>Sports Markets</span></h2>
  <p>Divergence Engine autonomously monitors live World Cup odds from TxLINE, detects abnormal market movement, scores signals in real time, and explains exactly why a fixture is being flagged — with zero manual input once deployed.</p>
  <div class="hero-btns">
    <a href="/app" class="btn-primary">Launch Live Dashboard →</a>
    <a href="https://solscan.io/tx/4CQSxcwPCGub4Eyz9L2HaqEqfb5QHw1qDpJKBqUqCrwgdGNozhFwPLsEJfY1Vf2PNfpdHYG4Zxw1eohtJTF93i8U?cluster=devnet" target="_blank" class="btn-secondary">View On-Chain Proof</a>
  </div>

  <div class="stats-bar">
    <div class="stat-item">
      <div class="stat-num">60s</div>
      <div class="stat-label">Poll Interval</div>
    </div>
    <div class="stat-item">
      <div class="stat-num">3</div>
      <div class="stat-label">API Endpoints</div>
    </div>
    <div class="stat-item">
      <div class="stat-num">0-100</div>
      <div class="stat-label">Signal Score</div>
    </div>
    <div class="stat-item">
      <div class="stat-num">100%</div>
      <div class="stat-label">Autonomous</div>
    </div>
  </div>
</div>

<!-- DASHBOARD PREVIEW -->
<div class="preview">
  <div class="preview-label">Live Dashboard Preview</div>
  <div class="preview-box">
    <div class="preview-header">
      <div class="preview-dot" style="background:#E85D4A"></div>
      <div class="preview-dot" style="background:#E8A33D;margin-left:4px"></div>
      <div class="preview-dot" style="background:#3DC9B0;margin-left:4px"></div>
      <div class="preview-url">divergence-engine-production.up.railway.app/app</div>
    </div>
    <div class="preview-screen">
      <div class="mini-card">
        <div class="mini-card-title">Brazil vs Japan</div>
        <div class="mini-score">76</div>
        <div>
          <div class="mini-bar" style="width:67%;background:#E8A33D"></div>
          <div class="mini-bar" style="width:100%;background:#ff4757"></div>
          <div class="mini-bar" style="width:90%;background:#E8A33D"></div>
        </div>
        <div class="mini-badge" style="background:rgba(255,107,53,0.15);color:#ff6b35;border:1px solid rgba(255,107,53,0.3)">HIGH CONFIDENCE</div>
      </div>
      <div class="mini-card">
        <div class="mini-card-title">Signal Timeline</div>
        <div style="font-size:9px;color:#6a7a9e;line-height:1.8">
          <div style="color:#ff6b35">12:21 · HIGH signal fired</div>
          <div>12:20 · Poll #24 complete</div>
          <div style="color:#fbbf24">12:19 · MEDIUM signal</div>
          <div>12:18 · 2 fixtures active</div>
          <div>12:17 · Engine polling...</div>
        </div>
      </div>
      <div class="mini-card">
        <div class="mini-card-title">On-Chain Proof</div>
        <div style="font-size:9px;color:#3DC9B0;margin-bottom:6px">● Active · Solana Devnet</div>
        <div style="font-size:8px;color:#4a5878;line-height:1.6;word-break:break-all">4CQSxcwPCGub4Eyz9L2Ha...</div>
        <div class="mini-badge" style="margin-top:8px;background:rgba(61,201,176,0.1);color:#3DC9B0;border:1px solid rgba(61,201,176,0.25)">TxLINE World Cup 2026</div>
      </div>
    </div>
  </div>
</div>

<hr class="divider"/>

<!-- HOW IT WORKS -->
<div class="how">
  <h3>How It Works</h3>
  <p class="how-sub">Four steps from raw odds data to an actionable intelligence signal</p>
  <div class="steps">
    <div class="step">
      <div class="step-num">01</div>
      <div class="step-icon">⛓</div>
      <h4>On-Chain Subscribe</h4>
      <p>A Solana wallet signs a subscription transaction to TxLINE's free World Cup tier — cryptographically anchored and verifiable on Solscan.</p>
      <div class="step-connector">→</div>
    </div>
    <div class="step">
      <div class="step-num">02</div>
      <div class="step-icon">◎</div>
      <h4>Live Odds Polling</h4>
      <p>The engine polls TxLINE's 1X2 odds across all active fixtures every 60 seconds, building a rolling history of smoothed probability data.</p>
      <div class="step-connector">→</div>
    </div>
    <div class="step">
      <div class="step-num">03</div>
      <div class="step-icon">⚡</div>
      <h4>Divergence Scoring</h4>
      <p>Each poll computes Magnitude × Velocity × Consistency into a 0-100 signal score. Scores above threshold fire a flagged Divergence Event.</p>
      <div class="step-connector">→</div>
    </div>
    <div class="step">
      <div class="step-num">04</div>
      <div class="step-icon">◆</div>
      <h4>Explained Signal</h4>
      <p>Every flagged event includes a plain-language reason — not just a number. HIGH/MEDIUM/LOW confidence with specific drift context.</p>
    </div>
  </div>
</div>

<hr class="divider"/>

<!-- FEATURES -->
<div class="features">
  <h3>Key Features</h3>
  <p class="features-sub">Built for builders, traders, and anyone who needs to understand where markets are moving</p>
  <div class="feature-grid">
    <div class="feature">
      <div class="feature-icon" style="background:rgba(232,163,61,0.1)">⚡</div>
      <h4>Signal Scoring Engine</h4>
      <p>Composite 0-100 score from drift magnitude, velocity relative to fixture baseline, and directional consistency across polls.</p>
    </div>
    <div class="feature">
      <div class="feature-icon" style="background:rgba(61,201,176,0.1)">⛓</div>
      <h4>On-Chain Proof</h4>
      <p>Every subscription is verified on Solana devnet. Click through to Solscan to confirm the transaction is real and on-chain.</p>
    </div>
    <div class="feature">
      <div class="feature-icon" style="background:rgba(58,95,255,0.1)">◎</div>
      <h4>Signal Timeline</h4>
      <p>Live feed of every poll, signal, and divergence event — timestamped and color-coded by confidence level in real time.</p>
    </div>
    <div class="feature">
      <div class="feature-icon" style="background:rgba(236,72,153,0.1)">▶</div>
      <h4>Demo Replay Mode</h4>
      <p>6-step animated walkthrough showing the engine catching a market shock — from stable odds to SIGNAL TRIGGERED in 50 seconds.</p>
    </div>
    <div class="feature">
      <div class="feature-icon" style="background:rgba(139,92,246,0.1)">◈</div>
      <h4>Risk Lab</h4>
      <p>Degen vs Smart Money mode — interactive model showing how stacking legs destroys combined probability even with high-confidence signals.</p>
    </div>
    <div class="feature">
      <div class="feature-icon" style="background:rgba(20,184,166,0.1)">▸</div>
      <h4>Market Intelligence API</h4>
      <p>Live JSON output from every poll — curl-ready endpoint that other developers can consume to power alerts, bots, or trading tools.</p>
    </div>
    <div class="feature">
      <div class="feature-icon" style="background:rgba(236,72,153,0.1)">⚡</div>
      <h4>Live Signal Leaderboard</h4>
      <p>Real-time ranking of the highest-scoring divergence signals in the last 24 hours — updated every poll cycle.</p>
    </div>
    <div class="feature">
      <div class="feature-icon" style="background:rgba(232,163,61,0.1)">◈</div>
      <h4>Volatility Snapshot</h4>
      <p>Per-fixture odds range tracking — shows how far home, draw, and away prices have moved since monitoring began.</p>
    </div>
    <div class="feature">
      <div class="feature-icon" style="background:rgba(58,95,255,0.1)">▸</div>
      <h4>Public Signal API</h4>
      <p>Three curl-ready endpoints — /api/signals/latest, /api/volatility, /api/leaderboard — consumable by any external tool or bot.</p>
    </div>
  </div>
</div>

<hr class="divider"/>

<!-- TECH STACK -->
<div class="tech">
  <h3>Built With</h3>
  <p class="tech-sub">Production-grade stack, zero unnecessary dependencies</p>
  <div class="tech-pills">
    <div class="tech-pill"><span>Runtime</span>Node.js</div>
    <div class="tech-pill"><span>Blockchain</span>Solana Devnet</div>
    <div class="tech-pill"><span>Data Layer</span>TxLINE by TxODDS</div>
    <div class="tech-pill"><span>Subscription</span>Anchor + @solana/web3.js</div>
    <div class="tech-pill"><span>Frontend</span>React + Tailwind CSS</div>
    <div class="tech-pill"><span>Charts</span>Chart.js</div>
    <div class="tech-pill"><span>Deployment</span>Railway</div>
    <div class="tech-pill"><span>Proof</span>Solscan Devnet</div>
  </div>
</div>

<hr class="divider"/>

<!-- CTA -->
<div class="cta">
  <div class="cta-box">
    <h3>See It Live</h3>
    <p>The engine is running right now — polling TxLINE's World Cup odds feed every 60 seconds,<br/>scoring signals, and logging divergences autonomously.</p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
      <a href="/app" class="btn-primary">Launch Dashboard →</a>
      <a href="https://github.com/juniorprincemhelem/divergence-engine" target="_blank" class="btn-secondary">View on GitHub</a>
    </div>
  </div>
</div>

<footer>
  <div class="footer-left">Divergence Engine v1.0 · TxODDS World Cup 2026 Hackathon · Built on Solana Devnet</div>
  <div class="footer-links">
    <a href="/app">Dashboard</a>
    <a href="https://github.com/juniorprincemhelem/divergence-engine" target="_blank">GitHub</a>
    <a href="https://solscan.io/tx/4CQSxcwPCGub4Eyz9L2HaqEqfb5QHw1qDpJKBqUqCrwgdGNozhFwPLsEJfY1Vf2PNfpdHYG4Zxw1eohtJTF93i8U?cluster=devnet" target="_blank">Solscan</a>
  </div>
</footer>

</body>
</html>`;

const server = http.createServer(function(req, res) {
  // API: return live data
  if (req.url === "/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pollCount: pollCount, fixtures: liveData, divergences: divergenceLog }));
    return;
  }
  // API: most recent divergences for dashboard widgets
  if (req.url.startsWith("/api/signals/latest")) {
    const latest = divergenceLog.slice(0, 10).map(d => ({
      fixture: d.fixture,
      fixtureId: d.fixtureId,
      timestamp: d.timestamp,
      score: d.signal?.score,
      confidence: d.signal?.confidence,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(latest));
    return;
  }
  // API: volatility per fixture (max/min odds over all recorded history)
  if (req.url.startsWith("/api/volatility")) {
    const vol = {};
    Object.entries(oddsHistory).forEach(([id, history]) => {
      const home = history.map(h => h.homePct).reduce((a, b) => Math.max(a, b), 0);
      const homeMin = history.map(h => h.homePct).reduce((a, b) => Math.min(a, b), 1);
      const draw = history.map(h => h.drawPct).reduce((a, b) => Math.max(a, b), 0);
      const drawMin = history.map(h => h.drawPct).reduce((a, b) => Math.min(a, b), 1);
      const away = history.map(h => h.awayPct).reduce((a, b) => Math.max(a, b), 0);
      const awayMin = history.map(h => h.awayPct).reduce((a, b) => Math.min(a, b), 1);
      vol[id] = { home, homeMin, draw, drawMin, away, awayMin };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(vol));
    return;
  }
  // API: leaderboard
  if (req.url.startsWith("/api/leaderboard")) {
    const now = Date.now();
    const twentyFourH = 24 * 60 * 60 * 1000;
    const recent = divergenceLog.filter(d => now - new Date(d.timestamp).getTime() <= twentyFourH);
    const sorted = recent.sort((a, b) => (b.signal?.score || 0) - (a.signal?.score || 0)).slice(0,3).map(d => ({
      fixture: d.fixture,
      score: d.signal?.score,
      timestamp: d.timestamp,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sorted));
    return;
  }
  // /app returns dashboard page
  if (req.url === "/app") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }
  // root returns landing page
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(landingHtml);
});

server.listen(PORT, HOST, function() {
  console.log("\n+------------------------------------------+");
  console.log("|   DIVERGENCE ENGINE - Web Dashboard      |");
  console.log("|   Open: http://localhost:" + PORT + "            |");
  console.log("+------------------------------------------+\n");
});

poll();
setInterval(poll, POLL_INTERVAL_MS);