from pathlib import Path
import re

path = Path('server.js')
text = path.read_text(encoding='utf-8')
start_marker = 'const html = `<!DOCTYPE html>'
end_marker = '</html>`;'
start = text.find(start_marker)
end = text.rfind(end_marker)
if start == -1 or end == -1:
    raise SystemExit('Could not find HTML block markers')
end += len(end_marker)
html_block = text[start:end]

render_head = '''function renderHead() {
  return `
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
`;
}
'''

render_template = '''function renderPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>${renderHead()}</head>
<body>
${renderHeader()}
<main>
  ${renderFixturesSection()}
  <aside class="panel">
    ${renderProofReplaySection()}
    ${renderMarketIntelligenceSection()}
    ${renderTimelineSection()}
  </aside>
</main>
${renderFooter()}
<script>
${scriptContent}
</script>
</body>
</html>`;
}
'''

header_sections = '''function renderFixturesSection() {
  return `
<section class="panel">
  <div class="panel-title">
    <h2>Live Fixtures</h2>
    <small>Updated every 60 seconds</small>
  </div>
  <div class="grid" id="grid"></div>
</section>
`;
}

function renderProofReplaySection() {
  return `
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
`;
}

function renderMarketIntelligenceSection() {
  return `
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
`;
}

function renderTimelineSection() {
  return `
<div class="tl-wrap">
  <div class="panel-title" style="margin-bottom: 12px;">
    <h2>Event Timeline</h2>
    <small>Recent system actions</small>
  </div>
  <div id="timelineFeed"></div>
</div>
`;
}

function renderAccumulatorRiskSection() {
  return ``;
}

function renderDivergenceLogSection() {
  return ``;
}

function renderFooter() {
  return `<footer>Divergence Engine v1.0 · TxODDS Hackathon 2026 · Solana Devnet</footer>`;
}
'''

new_html = render_head + '\n' + header_sections + '\n' + render_template
text = text[:start] + new_html + text[end:]
path.write_text(text, encoding='utf-8')
print('Refactor complete')
