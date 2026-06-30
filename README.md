# Divergence Engine

**Autonomous market intelligence for live sports odds — built for the TxODDS World Cup Hackathon 2026**

Divergence Engine monitors live World Cup 2026 odds from TxLINE in real time, computing a signal score for each fixture based on price drift magnitude, velocity, and direction consistency. Instead of just logging "odds changed," it produces an explainable, graded signal — score, confidence level, and a plain-language reason — for every meaningful market movement.

It also includes an Accumulator Risk Visualizer, a complementary tool demonstrating why multi-leg bet structure erodes win probability independently of signal quality.

## Why this matters

Most odds-tracking tools simply display numbers. Divergence Engine treats odds movement as a market intelligence problem: detecting when price action accelerates beyond a fixture's own recent baseline, then explaining *why* it fired in language a trader or bettor can immediately act on.

## Architecture

- **Solana devnet** — wallet subscription to TxLINE's free World Cup tier via an on-chain `subscribe` instruction
- **TxLINE API** — live odds polling every 60 seconds across all active World Cup fixtures
- **Signal engine** (`server.js`) — computes drift magnitude, velocity relative to recent history, and direction consistency into a 0–100 composite score with HIGH/MEDIUM/LOW confidence
- **Live dashboard** — real-time web UI with per-fixture probability charts, signal explanations, and a divergence log
- **Accumulator Risk Visualizer** — interactive tool showing cumulative win probability collapse across multi-leg slips

## Tech stack

Node.js · Solana web3.js + Anchor · TxLINE API · Chart.js · vanilla HTML/CSS/JS (no frontend framework)

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
