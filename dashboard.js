const axios = require("axios");
const fs = require("fs");

const { jwt, apiToken, baseUrl } = JSON.parse(fs.readFileSync("./api-token.json", "utf8"));
const headers = {
  Authorization: `Bearer ${jwt}`,
  "X-Api-Token": apiToken
};

const POLL_INTERVAL_MS = 60000;
const DIVERGENCE_THRESHOLD = 2.0; // Lowered for demo
const fixtures = JSON.parse(fs.readFileSync("./fixtures.json", "utf8"));

let previousOdds = {};
let divergenceLog = [];
let pollCount = 0;

function parseOdds(oddsArray) {
  const market = oddsArray.find(o => o.SuperOddsType === "1X2_PARTICIPANT_RESULT");
  if (!market) return null;
  return {
    ts: market.Ts,
    home: market.Prices[0] / 1000,
    draw: market.Prices[1] / 1000,
    away: market.Prices[2] / 1000,
    homePct: parseFloat(market.Pct[0]),
    drawPct: parseFloat(market.Pct[1]),
    awayPct: parseFloat(market.Pct[2]),
    inRunning: market.InRunning,
    gameState: market.GameState,
  };
}

function calcShift(prev, curr) {
  const h = Math.abs(curr.homePct - prev.homePct);
  const d = Math.abs(curr.drawPct - prev.drawPct);
  const a = Math.abs(curr.awayPct - prev.awayPct);
  return {
    homePctShift: curr.homePct - prev.homePct,
    drawPctShift: curr.drawPct - prev.drawPct,
    awayPctShift: curr.awayPct - prev.awayPct,
    maxShift: Math.max(h, d, a)
  };
}

function clearScreen() {
  process.stdout.write("\x1Bc");
}

function bar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function shiftArrow(val) {
  if (val > 0.1) return "▲";
  if (val < -0.1) return "▼";
  return "─";
}

function renderDashboard(activeData) {
  clearScreen();
  const now = new Date().toISOString();

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          🔍 DIVERGENCE ENGINE  —  LIVE MONITOR              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Poll #${pollCount} | ${now}`);
  console.log(`  Threshold: ${DIVERGENCE_THRESHOLD}% | Divergences flagged: ${divergenceLog.length}`);
  console.log("─".repeat(64));

  for (const { fixture, current, shift } of activeData) {
    const name = `${fixture.Participant1} vs ${fixture.Participant2}`;
    const status = current.inRunning ? "🟢 LIVE" : "⚪ Pre";

    console.log(`\n  ${status} ${name}`);
    console.log(`  ${fixture.Competition}`);
    console.log();
    console.log(`  Home  ${bar(current.homePct)} ${current.homePct.toFixed(2)}% ${shiftArrow(shift?.homePctShift ?? 0)}`);
    console.log(`  Draw  ${bar(current.drawPct)} ${current.drawPct.toFixed(2)}% ${shiftArrow(shift?.drawPctShift ?? 0)}`);
    console.log(`  Away  ${bar(current.awayPct)} ${current.awayPct.toFixed(2)}% ${shiftArrow(shift?.awayPctShift ?? 0)}`);

    if (shift) {
      const flag = shift.maxShift >= DIVERGENCE_THRESHOLD ? "  🚨 DIVERGENCE DETECTED!" : `  ✅ Shift: ${shift.maxShift.toFixed(3)}%`;
      console.log(flag);
    } else {
      console.log("  📍 Baseline captured");
    }
    console.log("─".repeat(64));
  }

  if (divergenceLog.length > 0) {
    console.log("\n  📋 DIVERGENCE LOG (last 3):");
    divergenceLog.slice(-3).forEach((e, i) => {
      console.log(`  [${i + 1}] ${e.fixture} | ${e.trigger} | ${e.timestamp}`);
    });
  }

  console.log("\n  Press Ctrl+C to stop");
}

async function poll() {
  pollCount++;
  const activeData = [];

  for (const fixture of fixtures) {
    const id = fixture.FixtureId;
    try {
      const res = await axios.get(`${baseUrl}/api/odds/snapshot/${id}`, { headers });
      if (!res.data || res.data.length === 0) continue;

      const current = parseOdds(res.data);
      if (!current) continue;

      const shift = previousOdds[id] ? calcShift(previousOdds[id], current) : null;

      if (shift && shift.maxShift >= DIVERGENCE_THRESHOLD) {
        divergenceLog.push({
          timestamp: new Date().toISOString(),
          pollCount,
          fixtureId: id,
          fixture: `${fixture.Participant1} vs ${fixture.Participant2}`,
          trigger: shift.maxShift.toFixed(3) + "% shift",
          before: previousOdds[id],
          after: current,
          shift,
          inRunning: current.inRunning,
        });
        fs.writeFileSync("./divergence-log.json", JSON.stringify(divergenceLog, null, 2));
      }

      activeData.push({ fixture, current, shift });
      previousOdds[id] = current;

    } catch (e) { /* skip */ }
  }

  renderDashboard(activeData);
}

poll();
setInterval(poll, POLL_INTERVAL_MS);