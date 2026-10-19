# OpenSpread

**Open-source, local-first hub for stablecoin arbitrage and crypto trading.** It runs on your own computer, reads
the exchanges you choose, shows the real net spread after fees, and (in later stages) lets your own Claude or Codex
design and test bots. No server of ours, no tracking. *A bitcoin100treta project.*

**Website and live demo:** https://bullroom.vercel.app
**Visual companion:** [Bullroom](https://github.com/JVMarks/bullroom), your bots as an animated pixel-art office.

> **Current stage: read-only.** The core reads public market data only. No API keys, no orders, no custody.
> Educational project, **not financial advice**.

## What works today

- `core/`: reads public tickers from Binance, OKX, Bybit, Kraken and Coinbase (via [CCXT](https://github.com/ccxt/ccxt))
  for stablecoin pairs, computes the best cross-exchange **net spread** (after both taker fees; transfer costs not
  included) and serves it on `127.0.0.1:4848` (`/v1/state`, `/v1/stream` as SSE).
- [Bullroom](https://github.com/JVMarks/bullroom) shows it live: one room per pair, one character per exchange.

## Run it

Requires Node 22.12+.

```bash
git clone https://github.com/JVMarks/OpenSpread.git
cd OpenSpread/core
npm install
npm start
```

Then, in another terminal, run Bullroom and open it with `?source=core`:

```bash
git clone https://github.com/JVMarks/bullroom.git
cd bullroom
npm install
npm run dev:client
```

Open `http://localhost:5173/?source=core`. Tests: `npm test` in `core/`.

The website lives in `docs/` (deployed on Vercel from this folder). To refresh its Bullroom demo, clone Bullroom next to this repository and
run `node scripts/sync-demo.mjs`.

## Principles

- **Local-first.** Your keys (in later stages) never leave your machine, and never with withdrawal permission.
- **The AI proposes, the engine executes,** inside a risk policy you set.
- **Honest numbers.** Negative net spread is shown as negative. Simulated data is always labeled.

## Roadmap

Paper trading and backtests with Hummingbot → MCP so your own Claude/Codex can design strategies → real orders behind
a risk policy → Nostr for identity, signed analyses and donations.

## Support

Donations: coming soon.

## License

MIT, see [`LICENSE`](LICENSE). Market data via CCXT (MIT).
