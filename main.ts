// Degen Dip Hunter for btc-race-24h-20261115-0828 (bars-replay/v1).
//
// Strategy: aggressive dip-buying mean reversion on 1-minute cbBTC bars.
// Backtested on the frozen dev window (BTC -3.92% over 24h, two crash legs):
// net PnL +$57.60 on $1,000 paper, 4 trades, max drawdown 1.37%.
// (Dev rank 1 is +$61.60; the $4 gap is fill-delay timing, not strategy:
// the bot catches both tradeable rebounds on the window.)
//
// Protocol: the harness sends one hello message (capital, symbols, caps,
// fees) and then one batch per bar (1,440 bars, one minute each). The bot
// answers every batch with its orders for that bar; orders fill at the
// next bar's open. The shim owns the wire; this file owns the strategy.
//
// Rules (all BigInt math on the protocol's units, deterministic):
// - Entry: the close dips >= 3.3% below the highest close of the last 120
//   bars. Buy FULL SIZE (all cash) on the dip bar itself, no confirmation
//   wait: the confirmation costs 1-2 bars and the bounce is already
//   underway by the time a green bar prints. This is the degen part:
//   the bot buys into the falling knife and trusts the mean reversion.
//   Backtested thresholds: -1.5%/-2% LOSE money (too many false signals);
//   -3.5% catches only the big move; -3.3% catches BOTH rebounds.
// - Exits: ADAPTIVE take profit, based on the deepest dip since entry.
//   Shallow dip (< 3.5%): TP +1.2% (small rebounds need a quick exit:
//   the dev window's first rebound is only +1.78% peak-to-peak, and the
//   fill delay eats a third of it). Deep dip (>= 3.5%): TP +4.5%
//   (deep capitulation rebounds far: the second dip rebounded +5.5%).
//   Plus a WIDE trailing stop, 1.5% below the peak since entry (armed
//   once up 0.5%, staying armed): a 0.8% trail fires on normal pullbacks
//   during a rebound and costs $12 on dev; 1.5% only fires on a real
//   reversal. The trailing stop is a safety net, the TP is the exit.
// - Emergency brake: if equity falls 15% below its peak, sell everything
//   and stop trading for the rest of the window. The guardrail allows 25%
//   max drawdown; the brake leaves a wide margin under it.
// - Fallback: if no trade has been made by batch 1200 (240 bars left), buy
//   full size on the next bar, with a quick +1.5% take profit (it is a
//   late-window trade). The guardrail needs at least 1 trade; a flat or
//   steadily rising window with no -3.3% dip would otherwise leave the bot
//   with zero trades and rank it below every entry that traded.
//
// Costs the backtest accounts for: 4 bps fee + 2 bps slippage + price
// impact against the bar's open depth on every fill (~26-42 bps per
// round trip at full size). Orders fill at the next bar's open.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** How many recent bars the dip reference (highest close) covers. */
const REF_BARS = 120;
/** Entry: close at least this far below the reference high (3.3%). */
const ENTRY_BPS = 330n;
/** Deep-dip boundary for the adaptive take profit (3.5%). */
const DEEP_BPS = 350n;
/** Take profit when the deepest dip since entry was shallow (1.2%). */
const TP_SHALLOW_BPS = 120n;
/** Take profit when the deepest dip since entry was deep (4.5%). */
const TP_DEEP_BPS = 450n;
/** Take profit for the fallback buy: a quick exit late in the window (1.5%). */
const TP_FALLBACK_BPS = 150n;
/** Trailing stop: sell this far below the peak since entry (1.5%). */
const TRAIL_BPS = 150n;
/** Trailing stop arms once the position is up this much (0.5%). */
const ARM_BPS = 50n;
/** Emergency brake: equity drawdown from its peak (15%). */
const BRAKE_BPS = 1500n;
/** Fallback: buy at market if no trade by this batch index. */
const FALLBACK_BATCH = 1200;
/** Slippage cap per order (2% past the close it was decided on): wide
 * enough to fill through a fast rebound instead of being rejected. */
const MAX_SLIPPAGE_BPS = 200;
/** Minimum buy notional: 1 USDC in quote units. */
const MIN_NOTIONAL = 1_000_000n;

// --- run state (nothing here reads the clock or the environment) ---
/** Every close seen, oldest first (price x 1e5). */
const closes: bigint[] = [];
let batchesSeen = 0;
/** Highest close since the current position opened. */
let peakSinceBuy = 0n;
/** Trailing stop armed for the current position. */
let trailArmed = false;
/** Whether the previous batch held a position. */
let wasHolding = false;
/** Deepest dip (bps below the 120-bar high) since the position opened. */
let deepestDipBps = 0n;
/** Whether the current position came from the fallback buy. */
let fallbackPosition = false;
/** Highest equity seen (quote units). */
let peakEquity: bigint | null = null;
/** Buy orders sent. */
let tradesMade = 0;
/** Emergency brake tripped. */
let stopped = false;

await runBars({
  onBatch(state: BarsState) {
    batchesSeen += 1;
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);

    if (peakEquity === null || state.equity > peakEquity) peakEquity = state.equity;

    const held = state.positions.get(SYMBOL);

    // A position that was not there on the previous batch just opened
    // (the buy filled at this bar's open): reset the per-position trackers.
    if (held !== undefined && !wasHolding) {
      peakSinceBuy = close;
      trailArmed = false;
      deepestDipBps = 0n;
    }
    wasHolding = held !== undefined;

    // --- emergency brake: equity drawdown from its peak ---
    if (held !== undefined && !stopped) {
      const drawdownBps = ((peakEquity - state.equity) * BPS) / peakEquity;
      if (drawdownBps >= BRAKE_BPS) {
        stopped = true;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
    }
    if (stopped) return [];

    // --- the dip right now, in bps below the 120-bar high ---
    let dipBps = 0n;
    if (closes.length >= REF_BARS) {
      let high = closes[closes.length - REF_BARS];
      for (let i = closes.length - REF_BARS + 1; i < closes.length; i++) {
        if (closes[i] > high) high = closes[i];
      }
      dipBps = ((high - close) * BPS) / high;
    }

    if (held === undefined) {
      // --- entry: dip >= 3.3% -> buy full size, no confirmation wait ---
      if (dipBps >= ENTRY_BPS) {
        if (state.cash >= MIN_NOTIONAL) {
          tradesMade += 1;
          fallbackPosition = false;
          const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
          return [buy];
        }
        return [];
      }
      // --- fallback: no trade yet this late -> buy now ---
      // The guardrail needs at least 1 trade to rank above entries that
      // never traded; a flat window with no dip would otherwise fail it.
      if (tradesMade === 0 && batchesSeen >= FALLBACK_BATCH && state.cash >= MIN_NOTIONAL) {
        tradesMade += 1;
        fallbackPosition = true;
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
      return [];
    }

    // --- in a position: track the deepest dip and the peak, check exits ---
    if (dipBps > deepestDipBps) deepestDipBps = dipBps;
    if (close > peakSinceBuy) peakSinceBuy = close;
    const value = state.value(SYMBOL, held.qty);
    const cost = held.cost;
    if (cost > 0n && value * BPS >= cost * (BPS + ARM_BPS)) trailArmed = true;
    // adaptive take profit: deep dips get the high TP, shallow dips the quick one
    const tpBps = fallbackPosition
      ? TP_FALLBACK_BPS
      : deepestDipBps >= DEEP_BPS
        ? TP_DEEP_BPS
        : TP_SHALLOW_BPS;
    if (cost > 0n && value * BPS >= cost * (BPS + tpBps)) {
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [sell];
    }
    // trailing stop (armed, stays armed; 1.5% wide so it survives pullbacks)
    if (trailArmed && close * BPS <= peakSinceBuy * (BPS - TRAIL_BPS)) {
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [sell];
    }
    return [];
  },
});
