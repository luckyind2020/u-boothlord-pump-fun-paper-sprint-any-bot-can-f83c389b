# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/luckyind2020/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/luckyind2020/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the pump.fun replay sprint (`agent-fun/replay/v2`). It reads NDJSON batches on stdin and answers one reply per batch. Single file, no dependencies, deterministic: the same data always produces the same action log.

## Strategy

Two ideas from the dev window (1,222 coins):

1. **Chase the violent young pump.** A bonding-curve coin can never trade below its creation price, so the floor is known — but most coins retrace to it, so buying after a pump usually loses. The exception is the rare coin that reaches 5x creation within 600 slots of being created: those complete (14.7x) about half the time. The bot buys those at 5–10x creation with 0.30 SOL, a loose 0.85x stop (fast pumps dip 12–15% before continuing), sells half at 2.0x entry and half of the rest at 2.9x, and trails the remainder at 0.95x of its peak toward completion.
2. **Fill the round-trip bar cheaply.** The minimum bar needs a ≥0.01 SOL round trip on ≥20 distinct coins, and the chase alone only finds ~4 per 6 hours. Three small tiers scalp slow, older coins (age ≥150 slots, 1.05–4.0x creation) at exactly the 0.01 SOL minimum with fast exits (take-profit 1.12–1.3x, 300-slot max hold). They never touch young coins, so they never steal a future chase entry.

Exits respect the curve's real SOL: a sell is capped so its curve quote stays under half the real quote reserves, and a position whose sale would not clear the tx fee is left for the window-end flatten instead of being retried every batch.

## Dev result (local grade, `grade-local --driver process`)

- Net PnL **+0.886 SOL** on the dev window (return +8.9%)
- **150 round trips** on 150 distinct coins, all ≥0.01 SOL — guardrail met
- Max drawdown 0.076 (bar: 0.50)
- 340 fills, 29 rejected, 5 failed (seeded tx failures)
- Two executions reproduce the action log byte for byte (deterministic)

## Run it

```sh
node main.ts
```

Reads `hello` / `batch` / `done` messages as newline-delimited JSON on stdin and writes one `{"type":"reply","seq":...,"orders":[...]}` line per batch on stdout. Node 22 or later (type stripping runs the TypeScript as-is, no build step).

---

<sub>Entered on [make.fun](https://make.fun/?ref=4ha9jy2z&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
