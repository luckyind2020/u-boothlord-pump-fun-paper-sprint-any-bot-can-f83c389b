// Pump.fun Paper Sprint — replay bot (agent-fun/replay/v2, NDJSON over stdin/stdout).
//
// Idea, learned from the dev window (1,222 coins, 44.8h of chain data):
//  * A bonding-curve coin can never trade below its creation price: sellers can only
//    return tokens somebody bought, so the price floor is the creation price. Coins
//    bought near creation therefore have a bounded downside, and coins bought after a
//    pump have already spent most of their upside — the median coin ends at 1.00x.
//  * The money is in the rare violent pump: coins that reach 5x creation within 600
//    slots of being created complete (14.7x) 44-52% of the time, while coins that take
//    longer to get there almost never do. So the bot chases only young 5-10x coins,
//    with a loose stop (fast pumps dip 12-15% before continuing) and lets the rest run
//    to the completion price with a trailing stop.
//  * The minimum bar needs a round trip of >= 0.01 SOL on >= 20 distinct coins, and
//    the chase alone only finds ~4 such coins per 6 hours. So three small "filler"
//    tiers scalp slow, older coins (age >= 150 slots, 1.05-4.0x) at the 0.01 SOL
//    minimum with fast exits. They are deliberately kept away from young coins so
//    they never steal a future chase entry.
//  * Exits respect the curve's real SOL: a sell is capped so its curve quote stays
//    under half the real quote reserves (a drained curve cannot pay a big sell), and
//    a position whose sale would not even clear the tx fee is left for the window-end
//    flatten instead of being retried every batch.
//
// Everything is deterministic: decisions depend only on the messages received, never
// on time, randomness, or iteration over unordered structures. All money math is
// BigInt; only the price multiple (a ratio used for triggers) is a float.

type Tier = {
  name: string;
  entryLo: number; // min price multiple vs creation price
  entryHi: number; // max price multiple vs creation price
  sizeLamports: bigint; // target buy size (capped at 0.9% of real quote reserves)
  maxAgeSlots: number; // entry only while younger than this (Infinity = no cap)
  minAgeSlots: number; // entry only once at least this old
  minTrades: number;
  minBuyers: number;
  minRealSolLamports: bigint; // entry only with at least this much real SOL in the curve
  minBuySellRatio: number; // recent-20-trades buy SOL / sell SOL
  requireRising: boolean; // entry only if price is above where it was 10 trades ago
  stopLoss: number; // sell everything at/below this multiple of entry price
  takeProfit1: number; // sell half at this multiple of entry price
  takeProfit2: number; // sell half of the rest at this multiple of entry price
  trail: number; // sell everything once price falls to this fraction of the peak
  maxHoldSlots: number; // sell everything after this long if still below 1.2x entry
};

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MIN_ROUND_TRIP_BUY = 10_000_000n; // 0.01 SOL, the guardrail's minimum buy
const SLIPPAGE_BPS = 500;
const SELL_QUOTE_CAP_NUM = 1n; // sell curve quote may use at most ...
const SELL_QUOTE_CAP_DEN = 2n; // ... one half of the real quote reserves
const DUST_FEE_MULT = 2n; // a sale must clear this many tx fees or it is dust

// Filler tiers first in the list would steal young coins from the chase, so the
// chase tier is evaluated first and the fillers only ever see older coins.
const TIERS: Tier[] = [
  {
    name: "chase",
    entryLo: 5, entryHi: 10,
    sizeLamports: 300_000_000n, // 0.30 SOL
    maxAgeSlots: 600, minAgeSlots: 0,
    minTrades: 8, minBuyers: 5, minRealSolLamports: 5n * LAMPORTS_PER_SOL,
    minBuySellRatio: 2, requireRising: true,
    stopLoss: 0.85, takeProfit1: 2.0, takeProfit2: 2.9, trail: 0.95,
    maxHoldSlots: 2400,
  },
  {
    name: "mid-low",
    entryLo: 1.2, entryHi: 2.5,
    sizeLamports: MIN_ROUND_TRIP_BUY,
    maxAgeSlots: Infinity, minAgeSlots: 150,
    minTrades: 5, minBuyers: 3, minRealSolLamports: 1_200_000_000n,
    minBuySellRatio: 1, requireRising: false,
    stopLoss: 0.95, takeProfit1: 1.15, takeProfit2: 1.3, trail: 0.97,
    maxHoldSlots: 300,
  },
  {
    name: "mid-high",
    entryLo: 2.5, entryHi: 4.0,
    sizeLamports: MIN_ROUND_TRIP_BUY,
    maxAgeSlots: Infinity, minAgeSlots: 150,
    minTrades: 5, minBuyers: 3, minRealSolLamports: 1_200_000_000n,
    minBuySellRatio: 1, requireRising: false,
    stopLoss: 0.95, takeProfit1: 1.15, takeProfit2: 1.3, trail: 0.97,
    maxHoldSlots: 300,
  },
  {
    name: "low",
    entryLo: 1.05, entryHi: 1.2,
    sizeLamports: MIN_ROUND_TRIP_BUY,
    maxAgeSlots: Infinity, minAgeSlots: 150,
    minTrades: 5, minBuyers: 3, minRealSolLamports: 1_200_000_000n,
    minBuySellRatio: 1, requireRising: false,
    stopLoss: 0.95, takeProfit1: 1.12, takeProfit2: 1.25, trail: 0.97,
    maxHoldSlots: 300,
  },
];

type Coin = {
  mint: string;
  createSlot: number;
  createPrice: number; // virtual quote / virtual token at creation
  trades: number;
  buySol: number; // cumulative buy SOL (lamports as a float; only used for ratios)
  sellSol: number;
  buyers: Set<string>;
  lastPrice: number;
  realSolLamports: bigint;
  realQuoteLamports: bigint;
  virtualQuote: bigint;
  virtualToken: bigint;
  completed: boolean;
  entered: boolean;
  tier: Tier | null;
  recent: Array<[boolean, number]>; // last 40 trades: [isBuy, sol lamports]
  hist: number[]; // last 30 trade prices
  slot2x: number | null; // first slot the price reached 2x creation
};

type Pos = {
  mint: string;
  tokens: bigint;
  entryPrice: number; // lamports paid per base unit on the entry fill
  peak: number; // highest price seen since entry
  entrySlot: number;
  tp1Done: boolean;
  tp2Done: boolean;
  dust: boolean; // sale would not clear fees; stop retrying, let the flatten take it
  tier: Tier;
};

type Order =
  | { side: "buy"; client_id: string; mint: string; quote_lamports: string; max_slippage_bps: number }
  | { side: "sell"; client_id: string; mint: string; token_amount: string; max_slippage_bps: number };

// ---- integer helpers (curve math mirrors the constant-product bonding curve) ----

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function feeOf(amount: bigint, bps: bigint): bigint {
  return ceilDiv((amount * bps), 10000n);
}

// Proceeds of selling `tokens` against reserves (vq, vt) with 95/30 bps fees.
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  const q = (tokens * vq) / (vt + tokens);
  return q - feeOf(q, 95n) - feeOf(q, 30n);
}

// Largest token amount whose curve quote stays under targetQ lamports.
function tokensForQuote(targetQ: bigint, vq: bigint, vt: bigint): bigint {
  if (targetQ <= 0n || vq <= targetQ) return 0n;
  return (targetQ * vt) / (vq - targetQ);
}

function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

// ---- bot state ----

const coins = new Map<string, Coin>();
const positions = new Map<string, Pos>();
const pendingBuy = new Set<string>();
const pendingSell = new Set<string>();
let clientCounter = 0;
let cashLamports = 0n;
let txFeeLamports = 105000n;
let maxOpenPositions = 5;
let maxOrdersPerBatch = 16;
let maxOrderBps = 100;

function nextClientId(): string {
  clientCounter += 1;
  return "o" + clientCounter;
}

function markFor(mint: string, marks: any[]): any | null {
  for (const m of marks) if (m.mint === mint) return m;
  return null;
}

function handleHello(msg: any): void {
  if (msg.capital && typeof msg.capital.lamports === "string") {
    cashLamports = BigInt(msg.capital.lamports);
  }
  if (msg.caps) {
    if (typeof msg.caps.max_open_positions === "number") maxOpenPositions = msg.caps.max_open_positions;
    if (typeof msg.caps.max_orders_per_batch === "number") maxOrdersPerBatch = msg.caps.max_orders_per_batch;
    if (typeof msg.caps.max_order_bps_of_real_reserve === "number") maxOrderBps = msg.caps.max_order_bps_of_real_reserve;
  }
  if (msg.fees) {
    const base = msg.fees.base_fee_lamports ? BigInt(msg.fees.base_fee_lamports) : 5000n;
    const prio = msg.fees.priority_fee_lamports ? BigInt(msg.fees.priority_fee_lamports) : 100000n;
    txFeeLamports = base + prio;
  }
}

function trackEvents(slot: number, events: any[]): Set<string> {
  const touched = new Set<string>();
  for (const e of events) {
    if (!e || typeof e.mint !== "string") continue;
    const mint: string = e.mint;
    touched.add(mint);
    if (e.event === "CreateEvent") {
      if (!coins.has(mint)) {
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        coins.set(mint, {
          mint,
          createSlot: slot,
          createPrice: priceOf(vq, vt),
          trades: 0,
          buySol: 0,
          sellSol: 0,
          buyers: new Set<string>(),
          lastPrice: priceOf(vq, vt),
          realSolLamports: 0n,
          realQuoteLamports: 0n,
          virtualQuote: vq,
          virtualToken: vt,
          completed: false,
          entered: false,
          tier: null,
          recent: [],
          hist: [],
          slot2x: null,
        });
      }
    } else if (e.event === "TradeEvent") {
      const c = coins.get(mint);
      if (!c) continue;
      c.trades += 1;
      const sol = Number(BigInt(e.sol_amount));
      if (e.is_buy) {
        c.buySol += sol;
        c.buyers.add(e.user);
      } else {
        c.sellSol += sol;
      }
      const vq = BigInt(e.virtual_quote_reserves);
      const vt = BigInt(e.virtual_token_reserves);
      const p = priceOf(vq, vt);
      c.lastPrice = p;
      c.virtualQuote = vq;
      c.virtualToken = vt;
      c.realSolLamports = BigInt(e.real_quote_reserves);
      c.realQuoteLamports = BigInt(e.real_quote_reserves);
      c.recent.push([e.is_buy === true, sol]);
      if (c.recent.length > 40) c.recent.shift();
      c.hist.push(p);
      if (c.hist.length > 30) c.hist.shift();
      if (c.slot2x === null && p >= 2 * c.createPrice) c.slot2x = slot;
    } else if (e.event === "CompleteEvent") {
      const c = coins.get(mint);
      if (c) c.completed = true;
    }
  }
  return touched;
}

function applyFills(fills: any[]): void {
  if (!Array.isArray(fills)) return;
  for (const f of fills) {
    if (!f || typeof f.mint !== "string") continue;
    const mint: string = f.mint;
    const isClose = typeof f.client_id === "string" && f.client_id.charAt(0) === "_";
    if (isClose) {
      // The harness closed this position itself (complete / flatten / writeoff).
      positions.delete(mint);
      pendingSell.delete(mint);
      continue;
    }
    if (f.status === "filled" && f.side === "buy") {
      const tokens = BigInt(f.token_amount);
      const paid = BigInt(f.quote_lamports);
      pendingBuy.delete(mint);
      if (tokens > 0n && !positions.has(mint)) {
        const c = coins.get(mint);
        const entryPrice = Number(paid) / Number(tokens);
        positions.set(mint, {
          mint,
          tokens,
          entryPrice,
          peak: entryPrice,
          entrySlot: typeof f.slot === "number" ? f.slot : 0,
          tp1Done: false,
          tp2Done: false,
          dust: false,
          tier: c && c.tier ? c.tier : TIERS[0],
        });
      }
    } else if (f.status === "filled" && f.side === "sell") {
      pendingSell.delete(mint);
    } else if (f.status === "rejected" || f.status === "failed") {
      if (f.side === "buy") pendingBuy.delete(mint);
      else pendingSell.delete(mint);
    }
  }
}

function syncAccount(account: any): void {
  if (!account || !Array.isArray(account.positions)) return;
  if (typeof account.cash_lamports === "string") cashLamports = BigInt(account.cash_lamports);
  const live = new Set<string>();
  for (const p of account.positions) {
    if (!p || typeof p.mint !== "string") continue;
    live.add(p.mint);
    const tokens = BigInt(p.token_amount);
    const cost = BigInt(p.cost_lamports);
    const existing = positions.get(p.mint);
    if (existing) {
      existing.tokens = tokens;
    } else if (tokens > 0n) {
      // A position the fills never told us about (defensive): seed it from cost.
      const c = coins.get(p.mint);
      positions.set(p.mint, {
        mint: p.mint,
        tokens,
        entryPrice: Number(cost) / Number(tokens),
        peak: Number(cost) / Number(tokens),
        entrySlot: 0,
        tp1Done: false,
        tp2Done: false,
        dust: false,
        tier: c && c.tier ? c.tier : TIERS[0],
      });
    }
  }
  for (const mint of Array.from(positions.keys())) {
    if (!live.has(mint)) positions.delete(mint);
  }
}

function decideExits(batch: any, orders: Order[]): void {
  const marks: any[] = Array.isArray(batch.marks) ? batch.marks : [];
  const slot: number = batch.slot;
  for (const pos of Array.from(positions.values())) {
    if (pendingSell.has(pos.mint) || pos.dust) continue;
    const mark = markFor(pos.mint, marks);
    const coin = coins.get(pos.mint);
    let vq: bigint;
    let vt: bigint;
    let rq: bigint;
    if (mark) {
      vq = BigInt(mark.virtual_quote_reserves);
      vt = BigInt(mark.virtual_token_reserves);
      rq = BigInt(mark.real_quote_reserves);
    } else if (coin) {
      vq = coin.virtualQuote;
      vt = coin.virtualToken;
      rq = coin.realQuoteLamports;
    } else {
      continue;
    }
    if (vt === 0n) continue;
    const price = priceOf(vq, vt);
    if (price > pos.peak) pos.peak = price;
    const t = pos.tier;
    let frac = 0;
    if (price <= pos.entryPrice * t.stopLoss) frac = 1;
    else if (!pos.tp1Done && price >= pos.entryPrice * t.takeProfit1) frac = 0.5;
    else if (pos.tp1Done && !pos.tp2Done && price >= pos.entryPrice * t.takeProfit2) frac = 0.5;
    else if (pos.tp1Done && price <= pos.peak * t.trail) frac = 1;
    else if (slot - pos.entrySlot > t.maxHoldSlots && price < pos.entryPrice * 1.2) frac = 1;
    if (frac === 0) continue;
    // Cap the sale so its curve quote stays under half the real quote reserves.
    let amount = (pos.tokens * BigInt(Math.round(frac * 1000))) / 1000n;
    if (rq > 0n && vq > 0n) {
      const targetQ = (rq * SELL_QUOTE_CAP_NUM) / SELL_QUOTE_CAP_DEN;
      const cap = tokensForQuote(targetQ, vq, vt);
      if (cap < amount) amount = cap;
    }
    // A sale that cannot clear the tx fee is dust: never retry it.
    if (amount <= 0n || sellProceeds(amount, vq, vt) <= DUST_FEE_MULT * txFeeLamports) {
      pos.dust = true;
      continue;
    }
    orders.push({
      side: "sell",
      client_id: nextClientId(),
      mint: pos.mint,
      token_amount: amount.toString(),
      max_slippage_bps: SLIPPAGE_BPS,
    });
    pendingSell.add(pos.mint);
    if (frac === 0.5 && !pos.tp1Done) pos.tp1Done = true;
    else if (frac === 0.5 && pos.tp1Done && !pos.tp2Done) pos.tp2Done = true;
  }
}

function decideEntries(batch: any, touched: Set<string>, orders: Order[]): void {
  const slot: number = batch.slot;
  let openCount = positions.size;
  for (const tier of TIERS) {
    if (openCount >= maxOpenPositions) break;
    const candidates: Array<{ buySol: number; mint: string; coin: Coin }> = [];
    for (const mint of touched) {
      const c = coins.get(mint);
      if (!c || c.entered || positions.has(mint) || pendingBuy.has(mint) || c.completed) continue;
      if (c.trades < tier.minTrades) continue;
      if (c.slot2x === null) continue; // the coin must have touched 2x creation
      const mult = c.lastPrice / c.createPrice;
      if (mult < tier.entryLo || mult > tier.entryHi) continue;
      if (c.buyers.size < tier.minBuyers) continue;
      if (c.realSolLamports < tier.minRealSolLamports) continue;
      const age = slot - c.createSlot;
      if (age > tier.maxAgeSlots || age < tier.minAgeSlots) continue;
      let buy = 0;
      let sell = 0;
      const window = c.recent.slice(-20);
      for (const [isBuy, sol] of window) {
        if (isBuy) buy += sol;
        else sell += sol;
      }
      if (buy < tier.minBuySellRatio * Math.max(sell, 1)) continue;
      if (tier.requireRising && c.hist.length >= 10 && c.lastPrice <= c.hist[c.hist.length - 10]) continue;
      candidates.push({ buySol: buy, mint, coin: c });
    }
    // Strongest recent buy flow first; mint breaks ties so the order is stable.
    candidates.sort((a, b) => (b.buySol - a.buySol) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    for (const cand of candidates) {
      if (openCount >= maxOpenPositions) break;
      if (orders.length >= maxOrdersPerBatch) break;
      const c = cand.coin;
      // 0.9% of real quote reserves, never above the tier size, never below 0.01 SOL.
      let size = tier.sizeLamports;
      const cap = (c.realQuoteLamports * 9n) / 1000n;
      if (cap < size) size = cap;
      if (size < MIN_ROUND_TRIP_BUY) continue;
      if (size + txFeeLamports > cashLamports) continue;
      orders.push({
        side: "buy",
        client_id: nextClientId(),
        mint: c.mint,
        quote_lamports: size.toString(),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      c.entered = true;
      c.tier = tier;
      pendingBuy.add(c.mint);
      openCount += 1;
    }
  }
}

function handleBatch(batch: any): void {
  const orders: Order[] = [];
  try {
    const slot: number = typeof batch.slot === "number" ? batch.slot : 0;
    const events: any[] = Array.isArray(batch.events) ? batch.events : [];
    const touched = trackEvents(slot, events);
    applyFills(batch.fills);
    syncAccount(batch.account);
    decideExits(batch, orders);
    decideEntries(batch, touched, orders);
  } catch (_e) {
    // Never crash and never miss a reply: fall back to whatever was decided.
    orders.length = 0;
  }
  const reply = { type: "reply", seq: batch.seq, orders: orders.slice(0, maxOrdersPerBatch) };
  process.stdout.write(JSON.stringify(reply) + "\n");
}

function main(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      if (!msg || typeof msg.type !== "string") continue;
      if (msg.type === "hello") {
        handleHello(msg);
      } else if (msg.type === "batch") {
        handleBatch(msg);
      } else if (msg.type === "done") {
        process.exit(0);
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

main();
