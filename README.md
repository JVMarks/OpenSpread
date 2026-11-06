<p align="center"><img src="docs/assets/img/mascot-trader.webp" alt="Bullroom mascot: a golden bull robot trading at a monitor" width="160"></p>

# OpenSpread

**Open-source, local-first hub for stablecoin arbitrage and crypto trading.** It runs on your own computer, reads
the exchanges you choose, shows the real net spread after fees, and lets your own Claude or Codex read the data, record
scored analyses and test simulated bots. No server of ours, no tracking. *A bitcoin100treta project.*

**Website and live demo:** https://bullroom.vercel.app
**Visual companion:** [Bullroom](https://github.com/JVMarks/bullroom), your bots as an animated pixel-art office.

> **Current stage: public data, simulation and scored analyses.** The core reads public market data only. No exchange API
> keys, no real orders, no custody. It only writes files next to its own settings.
> Educational project, **not financial advice**.

## What works today

- `core/`: reads public tickers from Binance, OKX, Bybit, Kraken and Coinbase (via [CCXT](https://github.com/ccxt/ccxt))
  for stablecoin pairs (exchanges and pairs are configurable, see below), computes the best cross-exchange **net spread** (after both taker fees; transfer costs not
  included) and serves it on `127.0.0.1:4848` (`/v1/state`, `/v1/stream` as SSE).
- [Bullroom](https://github.com/JVMarks/bullroom) shows it live: one room per pair, one character per exchange.
- **Built-in paper trading** (off by default, nothing extra to install): arbitrage robots simulated on real public order
  books, with no keys and no real orders. See below.
- **MCP server** for your own Claude or Codex: read data, record analyses, start and stop simulated robots. No tool can place
  a real order. See below.

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
  "pollMs": 10000,
  "alerts": [{ "pair": "USDC/USDT", "abovePct": 0.05 }],
  "transfer": { "sizeUsd": 1000, "withdrawFees": { "binance": { "USDC": 1 } } }
}
```

- `exchanges`: [CCXT ids](https://github.com/ccxt/ccxt#supported-cryptocurrency-exchanges), 2 to 20.
- `pairs`: up to 20, like `BTC/USDT`. An exchange that does not list a pair just stays out of that room.
- `pollMs`: 5000 to 300000 (5 s to 5 min).
- `alerts` (optional): one per pair, "tell me when the best net spread reaches `abovePct` %" (between -1 and 10).
  Each alert rings once and re-arms only after the spread falls 0.02 points below the level, so it does not flicker.
  Bullroom shows it as a notice on that pair's room. Idea from
  [trader-skill](https://github.com/Jakeschincariol/trader-skill)'s alerts (MIT), rewritten here.
- `transfer` (optional): the arbitrage buys the base coin on one exchange and has to withdraw it to the other. Give the
  trade size in US$ (10 to 10,000,000) and each exchange's withdrawal fee per coin, in units of that coin (the
  example values above are illustrative, not real fees). None of the five default exchanges publishes withdrawal
  fees without an API key, so copy them from each exchange's withdrawal fee page. Where the fee is known, the best
  spread also carries the net after the withdrawal, and Bullroom and the alerts use that number; where it is not,
  it says "not set". Not included: the transfer time (the price moves meanwhile) and moving the money back.
  The values can also be edited in Bullroom's Markets panel.

The core also keeps a small history of each pair's best net spread (one sample per minute, last 25 hours) in
`history.json`, next to `config.json`, saved every 5 minutes and on exit. With it, every pair in `/v1/state` carries
`windows`: how much the net spread changed over 5 min, 1 h and 24 h, plus the low and high in each window (`null`
until there is enough history). Bullroom shows them in its Spreads panel and on each room card. Deleting the file
just starts the history over.

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

## Paper trading

Turn it on in Bullroom (**Settings › Robots**) or with an `engine` block in the config. It starts off, with no pair allowed.

For each robot (one pair, two exchanges), every reading works like this:

1. If the best net spread reaches your minimum, the trade goes through a **risk gate**: allowed pair, trade size, quote age,
   exchange health, minimum order, balance on each exchange and daily loss. The gate blocks it and says why, or lets it pass.
2. The engine waits a configurable latency (1 s by default), reads both public order books and walks them for the size it can
   fill on both legs. If the opportunity vanished during the wait, that shows up as a **loss**, not as a cancelled trade.
3. Fees, balances and P&L update. Robots run on pretend capital (US$ 1,000 by default, with a 20% reserve and a 50% cap per
   robot). Every decision is appended to `engine/ledger.jsonl`, next to the config.

Limits come only from your config; nothing here changes them. A robot that hits the daily loss limit is ejected until the next
UTC day.

**What this does not tell you:**

- **Paper trading does not guarantee real results.** There is no queue, no order rejection and no failure of just one leg: both
  legs always fill together.
- **Without transfers, a robot runs out of balance fast.** It starts with a quarter of its capital in each coin on each exchange,
  so a one-way spread stops it after a trade or two, until the spread flips. Rebalancing is not simulated.
- **Real opportunities are rare.** On 4 Nov 2026, 16 exchange combinations across 1,227 USDT pairs had a positive net spread, almost
  all altcoins. A large spread that lasts can mean suspended withdrawals or different tokens sharing a symbol. It is not free money.
- **No arbitrage backtest.** That takes historical order books, which we do not have, so we show no number. Bullroom shows the
  best net spread of the last 24 h and how many readings reached your minimum instead.
- **Fees are public taker fees,** not your account's. An exchange that does not report a fee blocks the trade.

The risk gate, capital split and ledger take ideas from [trader-skill](https://github.com/Jakeschincariol/trader-skill) (MIT),
rewritten here.

This is software, not investment advice.

## Connect Claude or Codex (MCP)

With the core running (`npm start`), register the server with your own client. Use the full path to your clone:

```bash
claude mcp add openspread -- node /full/path/to/OpenSpread/core/bin/openspread-mcp.mjs
```

```bash
codex mcp add openspread -- node /full/path/to/OpenSpread/core/bin/openspread-mcp.mjs
```

The server runs over stdio and only talks to the core on `127.0.0.1` (another port: `OPENSPREAD_PORT`). It needs no key of its own.
Whatever your client sends to its model, including chart screenshots and the data these tools return, follows that client's terms.
Tested with an MCP client over stdio against live exchange data. Not yet tested inside the Claude Code or Codex apps.

| Tool | What it does |
|---|---|
| `get_market`, `get_agenda`, `get_wallets`, `get_sources` | Read quotes and spreads, the calendar and headlines, public wallets, data source health |
| `get_risk_policy`, `get_paper_bots` | Read your limits and the simulated robots |
| `get_scoreboard`, `list_analyses` | Read the scoreboard and past analyses |
| `submit_analysis` | Record an analysis. It is permanent and places no order |
| `start_paper_bot`, `stop_paper_bot` | Start or stop a **simulated** robot, through the same risk gate |

**That list is closed.** There is no tool for real orders, withdrawals, API keys, or changing your settings or risk limits; a test
fails if one is added. Headlines and third-party labels arrive under `untrusted`, as data and never as instructions, but a
malicious headline can still try to influence your model, so read what it proposes.

### How analyses are scored

An analysis has a direction, a conviction from 50 to 100 (the stated probability of being right), factors, optional plans A and B
with a stop and targets, and its reasoning. Hit rate alone says nothing, so the scoreboard shows the method too:

- **The core sets the reference price** (median of the exchange mid prices) when it records the analysis. The client cannot send one.
- **Permanent:** analyses cannot be edited or withdrawn. Only one can be open per model, pair and horizon (1h, 4h, 24h or 7d).
- **Direction:** compared with the first price sampled at or after expiry. A tie counts as a miss.
- **Plans:** the first touch of the stop or first target closes the plan, otherwise it closes at expiry. When the order is unknown, the
  stop wins. Results subtract two public taker fees, and nothing else: no slippage, no funding, no transfer.
- **Missing data:** with no sample within 15 minutes of expiry, the analysis counts as `void`, reported apart, and never disappears.
- **Sample:** no hit rate below 30 resolved analyses.
- **Calibration:** the Brier score, against 0.25 for always saying 50%. Above 0 in `skill` beats that coin flip.

Analyses in a row on one asset are not independent, stablecoin pairs barely move, and `model` is only what the client declares, so
treat the numbers as evidence, not proof. They live in `analyses/`, next to the config, on your machine. Not financial advice.

## Roadmap

Real orders with Hummingbot behind the same risk gate → Nostr for identity, signed analyses and donations.

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
