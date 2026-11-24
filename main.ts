// Pump Replay Sprint Bot — an early-launch scalper for agent-fun/replay/v2.
//
// Design, in words: the hello event opens the run with 10 SOL of paper money.
// A coin is watched from the batch that carries its CreateEvent. Every batch
// after that, slot by slot, the bot re-reads that coin's tape — who bought,
// who sold, whether the creator sold, how far the price has run from its
// opening price, and how much real SOL the curve now holds — and only then
// decides a batch of orders. It buys once per coin, while the coin is still
// young and near its opening price, only after at least three trades from
// at least three distinct non-creator buyers with little selling against
// them, and it sells the whole position fast on a small take-profit, a
// tight stop-loss, staleness, a creator sale, or a maximum hold. Nothing
// here reads a clock, randomness, the environment, or
// the network: every decision comes from the harness state handed to onBatch.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// --- Entry constants (lamports; 1 SOL = 1_000_000_000) -----------------------
const STAKE_LAMPORTS = 28_000_000n; // 0.028 SOL aimed per coin
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL: smallest buy worth the fees
const MIN_REAL_SOL = 900_000_000n; // 0.9 SOL of real reserves before a buy
const MAX_REAL_SOL = 25_000_000_000n; // 25 SOL: skip curves already huge
const MAX_DEV_BUY = 1_800_000_000n; // 1.8 SOL: creator's own buys, at most
const MAX_AGE_SLOTS = 9; // buy only within 9 slots of the CreateEvent
const MIN_TRADES = 3; // at least three trades seen on the tape
const MIN_BUYERS = 3; // at least three distinct non-creator buyers
const MAX_BUYERS = 5; // more distinct early buyers smells like a bundle
const MAX_SELL_RATIO_BPS = 2000n; // others' sells / buys, at most 20%
const MIN_RUNUP_BPS = -400n; // price vs opening price: not dumped over 4%
const MAX_RUNUP_BPS = 1500n; // price vs opening price: not pumped over 15%
const FLOW_WINDOW_SLOTS = 8; // recent-flow window, in slots
const MIN_RECENT_FLOW = 0n; // recent net flow must not be negative

// --- Exit constants ----------------------------------------------------------
const TAKE_PROFIT_BPS = 1000n; // sell when the position is worth +10% over cost
const STOP_LOSS_BPS = 700n; // sell when it is worth -7% under cost
const MAX_HOLD_SLOTS = 30; // never hold longer than 30 slots
const STALE_SLOTS = 2; // sell when no trade has hit the coin for 2 slots
const BUY_SLIPPAGE_BPS = 8000; // wide enough to survive the 2-slot latency
const SELL_SLIPPAGE_BPS = 8000;

// Curve fees: protocol 95 bps + creator 30 bps = 125 bps, rounded up.
const FEE_BPS = 125n;
const BPS = 10_000n;

interface Tick {
  slot: number;
  signedSol: bigint; // +sol on a buy, -sol on a sell
}

interface CoinTape {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  lastTradeSlot: number;
  recent: Tick[];
  decided: boolean; // bought, or filtered out for good
}

interface HeldInfo {
  openedSlot: number;
}

/** What selling `tokens` against (vq, vt) would pay, after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const fee = (q * FEE_BPS + BPS - 1n) / BPS;
  return q - fee;
}

/** Price run-up vs the opening price, in bps (signed). */
function runupBps(tape: CoinTape, vq: bigint, vt: bigint): bigint {
  if (tape.vq0 <= 0n || tape.vt0 <= 0n || vq <= 0n || vt <= 0n) return 0n;
  const num = vq * tape.vt0 - tape.vq0 * vt;
  const den = tape.vq0 * vt;
  return (num * BPS) / den;
}

const tapes = new Map<Pubkey, CoinTape>();
const held = new Map<Pubkey, HeldInfo>();
const selling = new Set<Pubkey>();

function decideOrders(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const slot = batch.slot;
  const tx = state.txFeeLamports();

  // Fold this batch's events into each coin's tape.
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (!tapes.has(e.mint)) {
        tapes.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          lastTradeSlot: e.slot,
          recent: [],
          decided: false,
        });
      }
    } else if (e.event === 'TradeEvent') {
      const tape = tapes.get(e.mint);
      if (tape === undefined) continue;
      const sol = BigInt(e.sol_amount);
      tape.trades += 1;
      tape.lastTradeSlot = e.slot;
      if (e.is_buy) {
        tape.bought += sol;
        if (e.user === tape.creator) tape.devBuy += sol;
        else tape.buyers.add(e.user);
        tape.recent.push({ slot: e.slot, signedSol: sol });
      } else {
        if (e.user === tape.creator) tape.devSold = true;
        else tape.soldByOthers += sol;
        tape.recent.push({ slot: e.slot, signedSol: -sol });
      }
    } else if (e.event === 'CompleteEvent') {
      const tape = tapes.get(e.mint);
      if (tape !== undefined) tape.decided = true;
    }
  }
  // Drop ticks older than the flow window.
  for (const tape of tapes.values()) {
    while (tape.recent.length > 0 && slot - tape.recent[0]!.slot > FLOW_WINDOW_SLOTS) {
      tape.recent.shift();
    }
  }

  // Forget sells that have resolved (fills are keyed by mint here; the
  // pending map is keyed by client_id, so it cannot answer this by mint).
  for (const f of batch.fills) {
    if (f.side === 'sell' && f.status === 'filled') selling.delete(f.mint);
    if (f.side === 'sell' && f.status === 'rejected') selling.delete(f.mint);
  }
  for (const mint of state.positions.keys()) {
    if (!held.has(mint)) held.set(mint, { openedSlot: slot });
  }
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) held.delete(mint);
  }

  // --- Exits first: sell whole positions that hit a rule. ------------------
  for (const [mint, holding] of state.positions) {
    if (selling.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const info = held.get(mint);
    const opened = info === undefined ? slot : info.openedSlot;
    const value = sellValue(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
    const cost = holding.cost_lamports;
    const tape = tapes.get(mint);
    const devSold = tape !== undefined && tape.devSold;
    const stale = tape !== undefined && slot - tape.lastTradeSlot >= STALE_SLOTS;
    const tooOld = slot - opened >= MAX_HOLD_SLOTS;
    const takeProfit = cost > 0n && value * BPS >= cost * (BPS + TAKE_PROFIT_BPS);
    const stopLoss = cost > 0n && value * BPS <= cost * (BPS - STOP_LOSS_BPS);
    if (devSold || stale || tooOld || takeProfit || stopLoss) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      selling.add(mint);
      if (tape !== undefined) tape.decided = true;
    }
  }

  // --- Entries: one buy per coin, young and near its opening price. --------
  let free = state.freeCashLamports();
  let room = state.hello.caps.max_open_positions - state.committedPositionCount();
  for (const tape of tapes.values()) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (tape.decided) continue;
    if (state.positions.has(tape.mint)) {
      tape.decided = true;
      continue;
    }
    const curve = state.curves.get(tape.mint);
    if (curve === undefined || curve.complete) {
      tape.decided = true;
      continue;
    }
    const age = slot - tape.createSlot;
    if (age > MAX_AGE_SLOTS) {
      tape.decided = true;
      continue;
    }
    // Hard filters: once failed, the coin is done for good.
    if (tape.devSold || tape.devBuy > MAX_DEV_BUY || tape.buyers.size > MAX_BUYERS) {
      tape.decided = true;
      continue;
    }
    if (tape.bought > 0n && tape.soldByOthers * BPS > tape.bought * MAX_SELL_RATIO_BPS) {
      tape.decided = true;
      continue;
    }
    const runup = runupBps(tape, curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (runup > MAX_RUNUP_BPS) {
      tape.decided = true;
      continue;
    }
    // Soft filters: wait while the tape is still thin or the price is low.
    if (tape.trades < MIN_TRADES || tape.buyers.size < MIN_BUYERS) continue;
    if (runup < MIN_RUNUP_BPS) continue;
    let flow = 0n;
    for (const t of tape.recent) flow += t.signedSol;
    if (flow < MIN_RECENT_FLOW) continue;
    if (curve.real_quote_reserves < MIN_REAL_SOL || curve.real_quote_reserves > MAX_REAL_SOL) continue;
    // Size: the 1%-of-real-reserves cap bounds the buy; it must clear the floor.
    const cap = state.maxBuyLamports(tape.mint);
    if (cap < MIN_BUY_LAMPORTS) continue;
    const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
    if (room <= 0 || free < amount + tx) continue;
    orders.push({ side: 'buy', mint: tape.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
    tape.decided = true;
    free -= amount + tx;
    room -= 1;
  }

  return orders;
}

await runBot({
  onBatch: (state, batch) => decideOrders(state, batch),
});
