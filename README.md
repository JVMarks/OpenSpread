<p align="center"><img src="docs/assets/img/mascot-trader.webp" alt="Bullroom mascot: a golden bull robot trading at a monitor" width="160"></p>

# OpenSpread

**Open-source, local-first hub for stablecoin arbitrage and crypto trading.** It runs on your own computer, reads
the exchanges you choose, shows the real net spread after fees, and (in later stages) lets your own Claude or Codex
design and test bots. No server of ours, no tracking. *A bitcoin100treta project.*

**Website and live demo:** https://bullroom.vercel.app
**Visual companion:** [Bullroom](https://github.com/JVMarks/bullroom), your bots as an animated pixel-art office.

> **Current stage: read-only market data.** The core reads public market data only. No API keys, no orders, no
> custody. The only thing it writes is its own settings file (which exchanges and pairs to read).
> Educational project, **not financial advice**.

## What works today

- `core/`: reads public tickers from Binance, OKX, Bybit, Kraken and Coinbase (via [CCXT](https://github.com/ccxt/ccxt))
  for stablecoin pairs (exchanges and pairs are configurable, see below), computes the best cross-exchange **net spread** (after both taker fees; transfer costs not
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

## Choose exchanges and pairs

On first run the core creates `~/.openspread/config.json` (or the path in `OPENSPREAD_CONFIG`):

```json
{
  "exchanges": ["binance", "okx", "bybit", "kraken", "coinbaseexchange"],
  "pairs": ["USDC/USDT", "USDE/USDT", "DAI/USDT", "FDUSD/USDT"],
  "pollMs": 10000
}
```

- `exchanges`: [CCXT ids](https://github.com/ccxt/ccxt#supported-cryptocurrency-exchanges), 2 to 20.
- `pairs`: up to 20, like `BTC/USDT`. An exchange that does not list a pair just stays out of that room.
- `pollMs`: 5000 to 300000 (5 s to 5 min).

Edit it and restart the core. A broken file is reported in the terminal and the defaults are used until it is fixed.
To see what each exchange lists before saving: `npm run check:exchanges -- BTC/USDT ETH/USDT`.

> Stablecoin pairs are where the number is honest. For volatile coins (BTC, ETH) the net spread only subtracts the
> two taker fees: moving coins between exchanges takes minutes and has withdrawal fees, and the price moves meanwhile.

The core also accepts the same settings over its local API, for tools on your own machine (Bullroom will use it):

| Route | What it does |
|---|---|
| `GET /v1/config` | Current settings, limits and every exchange id CCXT knows |
| `POST /v1/check` | Checks a settings body without saving: listed or not, inverted, active, taker fee |
| `PUT /v1/config` | Validates, saves the file and applies it at once, without a restart |

Only `127.0.0.1`/`localhost` as Host, only Bullroom's origins from a browser, JSON bodies up to 16 KB. There is no
field for API keys: unknown fields are rejected.

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

Free and open source, funded only by donations (voluntary gifts: they buy no product, service or advice).

- **Lightning:** `sickfog79@walletofsatoshi.com`
- **Bitcoin on-chain:** `bc1qwk9qmeqm3fwc5q29yu945z0tuvn2yqwvf3wt9cayt5s886lcuhssejj98j`

## Follow

Updates, videos and lives on **bitcoin100treta**: [YouTube](https://www.youtube.com/channel/UCHQam-riGkJR4N5nGc8UZYQ) ·
[Instagram](https://www.instagram.com/bitcoin100treta) · [TikTok](https://www.tiktok.com/@bitcoin100treta2.0) ·
[X](https://x.com/bitcoin100treta) · [Twitch](https://www.twitch.tv/bitcoin100treta) · [all links](https://linktr.ee/bitcoin100treta)

## License

MIT, see [`LICENSE`](LICENSE). Market data via CCXT (MIT).
