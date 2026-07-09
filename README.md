# Divergence Engine

**Autonomous market intelligence for live sports odds — built for the TxODDS World Cup Hackathon 2026**

Divergence Engine monitors live World Cup 2026 odds from TxLINE in real time, computing a signal score for each fixture based on price drift magnitude, velocity, and direction consistency. Instead of just logging "odds changed," it produces an explainable, graded signal — score, confidence level, and a plain-language reason — for every meaningful market movement.

It also includes a Signal Explorer dashboard displaying real-time market insights across active fixtures, an Accumulator Risk Visualizer demonstrating why multi-leg bet structure erodes win probability, and a public API layer for integrating signals into external trading tools or alerts systems.

## Why this matters

Most odds-tracking tools simply display numbers. Divergence Engine treats odds movement as a market intelligence problem: detecting when price action accelerates beyond a fixture's own recent baseline, then explaining *why* it fired in language a trader or bettor can immediately act on.

## Architecture

- **Solana devnet** — wallet subscription to TxLINE's free World Cup tier via an on-chain `subscribe` instruction
- **TxLINE API** — live odds polling every 60 seconds across all active World Cup fixtures
- **Signal engine** (`server.js`) — computes drift magnitude, velocity relative to recent history, and direction consistency into a 0–100 composite score with HIGH/MEDIUM/LOW confidence
- **Live dashboard** — real-time web UI with Signal Explorer (latest signals, volatility snapshot, leaderboard), per-fixture probability charts, signal explanations, and a divergence log
- **Signal Explorer** — 3-panel dashboard component with loading skeletons, hover effects, and smooth animations showing real-time API data
- **Public API layer** — JSON endpoints for signals, volatility metrics, and fixture leaderboards
- **Accumulator Risk Visualizer** — interactive tool showing cumulative win probability collapse across multi-leg slips

## Key Features

### 🎯 Signal Scoring Engine
Composite 0-100 score from drift magnitude, velocity relative to fixture baseline, and directional consistency across polls.

### ⛓️ On-Chain Proof
Every subscription is verified on Solana devnet. Click through to Solscan to confirm the transaction is real and on-chain.

### 📊 Signal Explorer Dashboard
Real-time 3-panel view showing:
- **Latest Signals** — Most recent divergence signals detected
- **Volatility Snapshot** — Market uncertainty across active fixtures
- **Leaderboard (24h)** — Top signal-generating fixtures ranked by strength

### 🔌 Public API
Three REST endpoints for integrating signal data:
- `GET /api/signals/latest` — Latest detected signals with scores
- `GET /api/volatility` — Current volatility metrics per fixture
- `GET /api/leaderboard` — Top 5 fixtures by 24h signal strength

### 🎬 Demo Replay Mode
6-step animated walkthrough showing the engine catching a market shock — from stable odds to SIGNAL TRIGGERED in 50 seconds.

### 🧠 Risk Lab
Degen vs Smart Money mode — interactive model showing how stacking legs destroys combined probability even with high-confidence signals.

### ✨ UX Polish
- Loading skeletons for smooth perceived performance
- Hover effects and transitions for visual feedback
- Tooltips explaining each metric in plain language
- Fade-in animations with staggered timing

## Tech stack

Node.js · Solana web3.js + Anchor · TxLINE API · React 18 · Tailwind CSS · Babel (in-browser JSX transpilation) · Railway

## API Endpoints

### Dashboard Routes
- `GET /` — Marketing landing page
- `GET /app` — Live dashboard with Signal Explorer
- `GET /data` — Current state (fixtures, divergences, poll count)

### Signal API
- `GET /api/signals/latest` — `{value: [...], Count: number}`
- `GET /api/volatility` — `{fixture: volatility_metric, ...}`
- `GET /api/leaderboard` — `{value: [...], Count: number}`

## TxLINE endpoints used

- `POST /auth/guest/start` — guest JWT
- `POST /api/token/activate` — API token activation via signed on-chain tx
- `GET /api/fixtures/snapshot` — fixture list
- `GET /api/odds/snapshot/{fixtureId}` — live 1X2 odds per fixture

## Honest limitations (devnet)

- Devnet odds data is synthetic and can move sharply between polls; the signal formula is designed for production-scale drift (typically 0.5–3% per poll in real markets), and the dashboard discloses this directly to viewers.
- Fixture kickoff timestamps returned by devnet are unreliable, so kickoff-proximity weighting is not implemented — it's a planned addition once timestamp data is verified accurate.
- Match incident/event cross-referencing (e.g. red card vs. price reaction) is on the roadmap, pending reliable live scores data on devnet.

## Feedback for TxODDS

The free World Cup tier subscription flow worked well end-to-end once the correct devnet base URL was identified — would be helpful to have this called out more explicitly in the quickstart docs, since the production URL initially returned timeouts. Fixture timestamp formatting on devnet also appears inconsistent and could use a fix for builders relying on kickoff-relative logic.

## Running locally

```bash
npm install
# Create a .env file with TXLINE_JWT, TXLINE_API_TOKEN, TXLINE_BASE_URL
node server.js
# Open http://localhost:3000
```

## Demo

[Video link here]
[Live deployment link here]

---

Built for TxODDS Hackathon 2026 — Superteam Earn
