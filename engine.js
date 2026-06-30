const axios = require("axios");
const fs = require("fs");

const { jwt, apiToken, baseUrl } = JSON.parse(fs.readFileSync("./api-token.json", "utf8"));
const headers = {
  Authorization: `Bearer ${jwt}`,
  "X-Api-Token": apiToken
};

const POLL_INTERVAL_MS = 60000;
const DIVERGENCE_THRESHOLD = 5.0;

let previousOdds = {};   // keyed by fixtureId
let divergenceLog = [];
let pollCount = 0;
let activeFixtures = []; // ones that actually have odds

const fixtures = JSON.parse(fs.readFileSync("./fixtures.json", "utf8"));

function parseOdds(oddsArray) {
  const market = oddsArray.find(o =>
    o.SuperOddsType === "1X2_PARTICIPANT_RESULT"
  );
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
    period: market.MarketPeriod,
  };
}

function calcShift(prev, curr) {
  return {
    homePctShift: curr.homePct - prev.homePct,
    drawPctShift: curr.drawPct - prev.drawPct,
    awayPctShift: curr.awayPct - prev.awayPct,
    maxShift: Math.max(
      Math.abs(curr.homePct - prev.homePct),
      Math.abs(curr.drawPct - prev.drawPct),
      Math.abs(curr.awayPct - prev.awayPct)
    )
  };
}

async function pollFixture(fixture) {
  const id = fixture.FixtureId;
  const name = `${fixture.Participant1} vs ${fixture.Participant2}`;

  try {
    const oddsRes = await axios.get(
      `${baseUrl}/api/odds/snapshot/${id}`,
      { headers }
    );
    const oddsArray = oddsRes.data;
    if (!oddsArray || oddsArray.length === 0) return;

    const current = parseOdds(oddsArray);
    if (!current) return;

    // Mark as active if not already
    if (!activeFixtures.includes(id)) {
      activeFixtures.push(id);
      console.log(`\n  ✅ ACTIVE: ${name} [${id}]`);
    }

    const timestamp = new Date().toISOString();
    console.log(`\n  [${name}]`);
    console.log(`    Status : ${current.inRunning ? "🟢 IN PLAY" : "⚪ Pre-match"}`);
    console.log(`    Home   : ${current.home.toFixed(3)} (${current.homePct.toFixed(3)}%)`);
    console.log(`    Draw   : ${current.draw.toFixed(3)} (${current.drawPct.toFixed(3)}%)`);
    console.log(`    Away   : ${current.away.toFixed(3)} (${current.awayPct.toFixed(3)}%)`);

    if (previousOdds[id]) {
      const shift = calcShift(previousOdds[id], current);
      console.log(`    Shift  : max ${shift.maxShift.toFixed(3)}%`);

      if (shift.maxShift >= DIVERGENCE_THRESHOLD) {
        const event = {
          timestamp,
          pollCount,
          fixtureId: id,
          fixture: name,
          trigger: shift.maxShift.toFixed(3) + "% shift",
          before: previousOdds[id],
          after: current,
          shift,
          inRunning: current.inRunning,
          resolved: false,
        };
        divergenceLog.push(event);
        fs.writeFileSync("./divergence-log.json", JSON.stringify(divergenceLog, null, 2));
        console.log(`\n  🚨 DIVERGENCE #${divergenceLog.length}: ${name}`);
        console.log(`     ${shift.maxShift.toFixed(3)}% shift — market moving!`);
      }
    } else {
      console.log(`    → Baseline captured`);
    }

    previousOdds[id] = current;

  } catch (err) {
    // Silently skip fixtures with no data
  }
}

async function poll() {
  pollCount++;
  const timestamp = new Date().toISOString();
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Poll #${pollCount} | ${timestamp}`);
  console.log(`Scanning ${fixtures.length} fixtures...`);

  for (const fixture of fixtures) {
    await pollFixture(fixture);
  }

  if (activeFixtures.length === 0) {
    console.log("\n  ⏳ No fixtures with live odds yet — will keep checking...");
  } else {
    console.log(`\n  📊 ${activeFixtures.length} fixture(s) active | ${divergenceLog.length} divergence(s) flagged total`);
  }
}

console.log("╔════════════════════════════════════════╗");
console.log("║      DIVERGENCE ENGINE v1.0            ║");
console.log("║  Scanning ALL fixtures automatically   ║");
console.log("╚════════════════════════════════════════╗");
console.log(`\nWatching ${fixtures.length} fixtures | Threshold: ${DIVERGENCE_THRESHOLD}%`);
console.log("Press Ctrl+C to stop.\n");

poll();
setInterval(poll, POLL_INTERVAL_MS);
