from pathlib import Path

path = Path('server.js')
text = path.read_text(encoding='utf-8')
start_marker = 'const html = `<!DOCTYPE html>'
end_marker = '</html>`;'
start = text.find(start_marker)
end = text.find(end_marker, start)
if start == -1 or end == -1:
    raise SystemExit('Could not find HTML template markers in server.js')
end += len(end_marker)
block = text[start:end]

style_start = block.find('<style>')
style_end = block.find('</style>', style_start)
if style_start == -1 or style_end == -1:
    raise SystemExit('Could not find <style> block in HTML template')
style_content = block[style_start + len('<style>'):style_end]

script_start = block.rfind('<script>')
script_end = block.rfind('</script>')
if script_start == -1 or script_end == -1:
    raise SystemExit('Could not find <script> block in HTML template')
script_body = block[script_start + len('<script>'):script_end]

# Escape template literal sensitive chars.
def escape_template(s):
    return s.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')

style_content = escape_template(style_content)
script_content = escape_template(script_body)

replacement = f"""const styleContent = `{style_content}`;
const scriptContent = `{script_content}`;
const html = renderPage();

function renderHead() {{
  return `
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Divergence Engine</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>${{styleContent}}</style>
`;
}}

function renderHeader() {{
  return `
<header>
  <div class="brand">
    <div class="brand-logo"><i class="fa-solid fa-signal"></i></div>
    <div class="brand-copy">
      <h1>DIVERGENCE ENGINE</h1>
      <p>Solscan-backed terminal dashboard</p>
    </div>
  </div>
  ${{renderStats()}}
</header>
`;
}}

function renderStats() {{
  return `
<div class="header-right">
  <div class="status-pill"><span class="status-dot"></span>Live Devnet</div>
  <div class="kpi-row">
    <div class="kpi"><strong id="sPoll">0</strong><span>Polls</span></div>
    <div class="kpi"><strong id="sFix">0</strong><span>Fixtures</span></div>
    <div class="kpi"><strong id="sDiv">0</strong><span>Divergences</span></div>
  </div>
  <div class="kpi"><strong id="sTime">--:--:--</strong><span>Last update</span></div>
</div>
`;
}}

function renderFixtures() {{
  return `
<section class="panel">
  <div class="panel-title">
    <h2>Live Fixtures</h2>
    <small>Updated every 60 seconds</small>
  </div>
  <div class="grid" id="grid"></div>
</section>
`;
}}

function renderProofReplay() {{
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
}}

function renderMarketIntelligence() {{
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
}}

function renderTimeline() {{
  return `
<div class="tl-wrap">
  <div class="panel-title" style="margin-bottom: 12px;">
    <h2>Event Timeline</h2>
    <small>Recent system actions</small>
  </div>
  <div id="timelineFeed"></div>
</div>
`;
}}

function renderAccumulatorRisk() {{
  return `
<section class="panel">
  <div class="panel-title">
    <h2>Accumulator Risk</h2>
    <small>Probability and slip risk</small>
  </div>
  <div class="acc-wrap">
    <div class="acc-desc">Adjust the legs and confidence sliders to preview cumulative slip probability.</div>
    <div class="acc-row">
      <div class="acc-field"><label for="legsSlider">Legs</label><div id="legsVal">3</div></div>
      <input id="legsSlider" type="range" min="2" max="12" value="3" />
    </div>
    <div class="acc-row">
      <div class="acc-field"><label for="confSlider">Confidence</label><div id="confVal">85%</div></div>
      <input id="confSlider" type="range" min="50" max="99" value="85" />
    </div>
    <div class="acc-row acc-prob-wrap">
      <div class="acc-prob-label">Slip probability</div>
      <div id="slipProb" class="acc-prob-val">—</div>
    </div>
    <div class="acc-buttons">
      <button class="acc-btn" id="accResetBtn">Reset</button>
      <button class="acc-btn" id="accAnalyzeBtn">Analyze</button>
    </div>
    <div class="chart-wrap" style="height:200px;"><canvas id="accChart"></canvas></div>
  </div>
</section>
`;
}}

function renderDivergenceLog() {{
  return `
<section class="panel">
  <div class="panel-title">
    <h2>Divergence Log</h2>
    <small>Recent drift and signal events</small>
  </div>
  <div class="log-wrap">
    <table>
      <thead>
        <tr><th>Time</th><th>Fixture</th><th>Status</th><th>Score</th></tr>
      </thead>
      <tbody id="divergenceLogBody">
        <tr><td colspan="4" class="empty">No divergences logged yet.</td></tr>
      </tbody>
    </table>
  </div>
</section>
`;
}}

function renderFooter() {{
  return `<footer>Divergence Engine v1.0 · TxODDS Hackathon 2026 · Solana Devnet</footer>`;
}}

function renderPage() {{
  return `<!DOCTYPE html>
<html lang="en">
<head>${{renderHead()}}</head>
<body>
${{renderHeader()}}
<main>
  ${{renderFixtures()}}
  <aside class="panel">
    ${{renderProofReplay()}}
    ${{renderMarketIntelligence()}}
    ${{renderTimeline()}}
    ${{renderAccumulatorRisk()}}
    ${{renderDivergenceLog()}}
  </aside>
</main>
${{renderFooter()}}
<script>
${{scriptContent}}
</script>
</body>
</html>`;
}}
"""

new_text = text[:start] + replacement + text[end:]
path.write_text(new_text, encoding='utf-8')
print('Refactor applied to server.js')
