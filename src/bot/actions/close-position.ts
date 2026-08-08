import tastytradeApi from "~/core/tastytrade-client";
import type { TastytradePlacedOrderResponse } from "~/core/types";
import { PositionGroupEvaluation, type PositionQuoteSnapshot } from "../evaluate-position";
import {
  StrategyAccountType,
  evaluateTradingStrategy,
  getDynamicTakeProfitTarget,
} from "~/strategy/evaluate-trading-strategy";
import type { ScaleOutContext } from "~/strategy/scale-out";
import {
  EOD_ARMED_MINUTE,
  EOD_FORCED_CLOSE_MINUTE,
  getMorningSpreadThresholdPct,
} from "~/strategy/spread-thresholds";
import { buildClosingOrderPayload, getMidpointPrice, waitForOrderFillById, type OrderPayload } from "./order-utils";
import { readEnvInt, toBooleanFlag } from "~/core/env-utils";
import { getCachedSecretRegime } from "~/strategy/secret";

const CLOSE_TICK_CHASE_ENABLED = true;
const DEFAULT_CLOSE_TICK_INTERVAL_MS = 30_000;
// Hard-risk closes (EOD liquidation, stop-loss) chase every 10s instead of 30s
// so a full 10-move chase completes in ~100s, not ~5 minutes — a chase that
// starts at 12:58 must finish before the 1:00 PM PT options close.
const DEFAULT_URGENT_CLOSE_TICK_INTERVAL_MS = 10_000;
const MAX_CLOSE_TICK_MOVES = 10;

// Hard bound on the configurable dwell. See the budget arithmetic below for why a
// large value is not simply "more patient" — it can stall the whole cycle.
const MAX_CONFIGURABLE_TICK_INTERVAL_MS = 120_000;

/**
 * How long each rung rests before the chase concedes one tick.
 *
 * WHY THIS IS THE ONLY USEFUL LEVER
 * MAX_CLOSE_TICK_MOVES is already 10, but the ladder is bounded by TICK
 * GRANULARITY, not by that count: getCloseTickSize floors the step at
 * getMinTickSize (0.05 under $3). A typical option here has a 10c spread, so only
 * TWO moves fit — ask, mid, bid — and raising the move count adds nothing. Observed
 * 2026-08-03: EOSE ask 0.930 / mid 0.880 / bid 0.830 chased in 2 moves, 63 seconds.
 * To wait longer you must dwell longer.
 *
 * BUDGET — read before raising this
 * The chase BLOCKS the cycle (run-cycle awaits executePositionEvaluations awaits
 * closePosition), the cycle runs every ~4 minutes, and overnight-position-reduction
 * closes run SEQUENTIALLY in a for-loop (unlike the main close path, which is
 * Promise.all and therefore parallel). So the worst case is roughly:
 *
 *     dwell x movesAvailable x sequentialReductionsThisCycle
 *
 * At 30s x 2 moves that is 60s per close — comfortable. At 150s (the "5 minute
 * chase" shape) two sequential reductions would overrun the 4-minute cycle and stall
 * everything behind them. 60-90s is the range that buys real patience while still
 * fitting. Capped at 120s for that reason.
 *
 * Also worth weighing: a profit-target close has ALREADY met its target at the BID
 * (currentReturn is bid-based), so waiting longer risks giving back a locked-in gain
 * to chase half a spread. Patience is not free on that path.
 */
function getCloseTickIntervalMs(): number {
  return readEnvInt(
    "STRATEGY_CLOSE_TICK_INTERVAL_MS",
    DEFAULT_CLOSE_TICK_INTERVAL_MS,
    (n) => n >= 1_000 && n <= MAX_CONFIGURABLE_TICK_INTERVAL_MS,
  );
}

function getUrgentCloseTickIntervalMs(): number {
  return readEnvInt(
    "STRATEGY_CLOSE_URGENT_TICK_INTERVAL_MS",
    DEFAULT_URGENT_CLOSE_TICK_INTERVAL_MS,
    (n) => n >= 1_000 && n <= MAX_CONFIGURABLE_TICK_INTERVAL_MS,
  );
}

export interface ClosePositionResult {
  accountNumber: string;
  action: "CLOSE_POSITION";
  orderResponse?: TastytradePlacedOrderResponse;
  placedOrder: boolean;
  skippedReason?: string;
  symbol: string;
  underlyingSymbol: string;
}

export interface ClosePositionDependencies {
  createOrder?: typeof tastytradeApi.orderService.createOrder;
  cancelOrder?: typeof tastytradeApi.orderService.cancelOrder;
  checkOrderFilled?: (
    accountNumber: string,
    orderId: string,
    timeoutMs: number,
  ) => Promise<boolean>;
  tickChaseEnabled?: boolean;
  tickIntervalMs?: number;
  maxTickMoves?: number;
  // Hard-risk close (EOD liquidation, stop-loss): chase on the urgent tick
  // interval and cross all the way to the edge price on the final tick move.
  isUrgentClose?: boolean;
  urgentTickIntervalMs?: number;
  // Partial close: stop after closing this many total contracts across all snapshots
  maxQuantityToClose?: number;
  // Account type for the execution-time strategy re-check — cutoff minutes and
  // the EOD liquidation rule differ by account type.
  accountType?: StrategyAccountType;
  // Bypass the morning spread gate so an illiquid position can be closed regardless
  // of spread. Two callers, both non-discretionary:
  //   - the manual IPC close path (operator-initiated surgical flatten)
  //   - overnight-position-reduction (risk action on an over-cap position; see the
  //     comment there for the 3-session SGML case that motivated it)
  // The scheduled MANAGE/take-profit path never sets it — there the half-spread is a
  // real cost and nothing forces the exit.
  forceThroughSpreadGate?: boolean;
  // Override the default order source tag written to the broker. Used to stamp
  // overnight-reduction sells with a distinct source so the cancel sweep can
  // protect them from being cancelled between cycles.
  orderSource?: string;
  // Live market regime, for the mid-floor stand-down. Injected (rather than imported
  // at the call site) because ES module exports are read-only and cannot be stubbed.
  getRegime?: () => { crashRegime?: boolean } | null | undefined;
  // Scale-out context for the execution-time recovery re-check. Must match what
  // built the original decision, or a scaled runner's breakeven/target exit
  // would be seen as "recovered" (MANAGE_ALLOCATION) and wrongly skipped.
  scaleOut?: ScaleOutContext;
}

function getMinTickSize(referencePrice: number): number {
  return referencePrice < 3 ? 0.05 : 0.1;
}

/**
 * Opt-in floor: stop a NON-URGENT sell chase at the midpoint instead of conceding
 * all the way to the bid.
 *
 * Walking to the bid exists to GUARANTEE THE CLEAR, which is the right trade when
 * something forces the exit — EOD liquidation or a stop. It is a poor one when
 * nothing does: on a wide spread it hands the market maker the entire half-spread on
 * a position being closed for profit. 2026-08-03: EOSE bid 0.730 / mid 0.775 / ask
 * 0.820 filled 0.750; WU C6 bid 0.600 / mid 0.650 / ask 0.700 filled 0.620.
 *
 * DEFAULT OFF, deliberately. The tick-chase was separately broken until that same
 * day — waitForOrderFillById never waited, so the ladder reached the bid within ~1s
 * of posting. With the chase now genuinely resting at ask and mid, this floor may be
 * unnecessary. Enable only after a session's fills show closes STILL ending at the
 * bid; otherwise it is redundant risk.
 *
 * Never applies when isUrgentClose: an unfilled hard-risk close is a far worse
 * outcome than a conceded spread, and the EOD path must still clear.
 */
function isMidFloorEnabled(): boolean {
  return toBooleanFlag(process.env.STRATEGY_CLOSE_MID_FLOOR_ENABLED ?? false);
}

/**
 * Should the mid floor stand down for market reasons?
 *
 * ONLY a crashRegime disqualifies it. That is deliberately narrower than gating on
 * regimeMarginMult >= 1.0, which sounds reasonable and is nearly useless in practice:
 * sampled live on 2026-08-03 the posture multiplier had median 0.740 and cleared 1.0
 * in 7 of 144 samples, so a floor gated that way would stand down ~95% of the time
 * and never meaningfully run.
 *
 * A mild down-regime (0.74) is not a reason to hand the market maker the whole
 * spread — that is precisely when the spread costs most. A crash is: there, clearing
 * beats price, and an unfilled close compounds.
 *
 * Fails toward TODAY'S BEHAVIOUR: no feed, no regime, or an unreadable one all count
 * as "stand down" (walk to the bid). The feed is optional by design, so the floor
 * must never depend on it being up in order for positions to clear.
 */
function shouldStandDownForRegime(
  getRegime: () => { crashRegime?: boolean } | null | undefined,
): boolean {
  try {
    const regime = getRegime();
    if (!regime) return true;
    return regime.crashRegime === true;
  } catch {
    return true;
  }
}

/** All three conditions that must hold for the mid floor to bind. */
function midFloorApplies(
  isUrgentClose: boolean,
  getRegime: () => { crashRegime?: boolean } | null | undefined,
): boolean {
  return (
    !isUrgentClose && isMidFloorEnabled() && !shouldStandDownForRegime(getRegime)
  );
}

/** How far down a SELL chase may walk. See isMidFloorEnabled for the rationale. */
function getSellEdgePrice(
  bid: number,
  midpoint: number,
  isUrgentClose: boolean,
  getRegime: () => { crashRegime?: boolean } | null | undefined,
): number {
  const bidEdge = bid > 0 ? bid : midpoint;
  // Math.max, not an unconditional midpoint: on a crossed or stale quote mid can sit
  // at or BELOW the bid, and floating the floor above a reachable price would just
  // mean never filling. Taking the max falls through to the bid in that case.
  return midFloorApplies(isUrgentClose, getRegime)
    ? Math.max(midpoint, bidEdge)
    : bidEdge;
}

function getEdgePrice(
  action: string,
  bid: number,
  ask: number,
  midpoint: number,
  isUrgentClose = false,
  getRegime: () => { crashRegime?: boolean } | null | undefined = getCachedSecretRegime,
): number {
  if (action.startsWith("Buy")) {
    return ask > 0 ? ask : midpoint;
  }

  return getSellEdgePrice(bid, midpoint, isUrgentClose, getRegime);
}

// Where the chase STARTS. A sell posts HIGH (toward the ask) and walks down to
// the bid, so a taker willing to pay above mid is captured — instead of starting
// at mid and only ever conceding (which caps upside at mid and hands the top half
// of the spread to the market maker on an instant fill). Non-urgent starts at the
// ask; urgent (EOD/stop) starts just above mid to test for the eager taker while
// still leaving room to walk to the bid and guarantee the clear. Buys unchanged
// (start at mid). Never returns worse than mid for a sell.
function getCloseStartPrice(
  action: string,
  ask: number,
  midpoint: number,
  isUrgentClose: boolean,
): number {
  if (action.startsWith("Buy")) return midpoint;
  if (!(ask > midpoint)) return midpoint;
  if (isUrgentClose) {
    return Math.min(ask, midpoint + 2 * getMinTickSize(midpoint));
  }
  return ask;
}

function getCloseTickSize(
  action: string,
  startPrice: number,
  edgePrice: number,
  maxTickMoves: number,
): number {
  const safeMoveCount = Math.max(1, maxTickMoves);
  const minTickSize = getMinTickSize(startPrice);

  if (action.startsWith("Buy")) {
    if (edgePrice <= startPrice || !Number.isFinite(edgePrice)) {
      return minTickSize;
    }

    return Math.max((edgePrice - startPrice) / safeMoveCount, minTickSize);
  }

  if (edgePrice >= startPrice || !Number.isFinite(edgePrice)) {
    return minTickSize;
  }

  return Math.max((startPrice - edgePrice) / safeMoveCount, minTickSize);
}

function moveClosePriceTowardEdge(
  action: string,
  currentPrice: number,
  edgePrice: number,
  tickSize: number,
): number {
  if (action.startsWith("Buy")) {
    return Math.min(edgePrice, currentPrice + tickSize);
  }

  return Math.max(edgePrice, currentPrice - tickSize);
}

function pricesAreEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

// Returns whether the cancellation was confirmed. Callers must stop chasing on
// false — an unconfirmed cancel followed by a fresh sell can double-sell the
// position (the buy side has had this guard since v1; this mirrors it).
async function cancelOrderById(
  accountNumber: string,
  orderId: string,
  cancelOrder: typeof tastytradeApi.orderService.cancelOrder,
): Promise<boolean> {
  const numericOrderId = Number(orderId);
  if (!Number.isFinite(numericOrderId)) {
    return false;
  }

  try {
    await cancelOrder(accountNumber, numericOrderId);
    return true;
  } catch {
    return false;
  }
}

function getTimeInMinutes(currentTime: Date): number {
  return currentTime.getHours() * 60 + currentTime.getMinutes();
}

function getSpreadPct(bidPrice: number, askPrice: number): number {
  const midpoint = bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : 0;

  if (!(midpoint > 0)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, askPrice - bidPrice) / midpoint;
}

export function shouldSkipClosePositionForMorningSpread(
  evaluation: PositionGroupEvaluation,
  isUrgentClose = false,
): { skippedReason?: string; shouldSkip: boolean } {
  const currentTime = evaluation.metrics.currentTime;

  // EOD closes must execute regardless of spread — a skipped liquidation
  // leaves margin exposure held overnight.
  if (getTimeInMinutes(currentTime) >= EOD_ARMED_MINUTE) {
    return { shouldSkip: false };
  }

  // Stop-loss / hard-risk closes must clear regardless of spread. The position has
  // crossed its bid-return floor and MUST exit — and the same blowout that tripped
  // the stop is what widened the spread, so gating here re-traps the very exit the
  // stop exists to force. Observed twice: LCID 2026-07-02 and again 2026-08-05, a
  // bid stop past -40% sat un-sellable through 8+ cycles purely because its own
  // spread exceeded the 30% cap, escaping only by luck when it happened to bounce.
  // Only NON-urgent closes (take-profit / manage) should wait for a tighter spread —
  // there the half-spread cost is real and nothing forces the exit. isUrgentClose is
  // set by the strategy for exactly the EOD + intraday/eod stop-loss floors (see
  // evaluate-trading-strategy.ts), so this decouples the close-side spread gate from
  // the stop-loss without loosening the gate for discretionary closes.
  if (isUrgentClose) {
    return { shouldSkip: false };
  }

  const bidReturnPct =
    evaluation.metrics.weightedAverageFill > 0
      ? (evaluation.metrics.currentBidPrice - evaluation.metrics.weightedAverageFill) /
        evaluation.metrics.weightedAverageFill
      : 0;
  const highBidReturnPct = getDynamicTakeProfitTarget(currentTime);

  if (bidReturnPct >= highBidReturnPct) {
    return { shouldSkip: false };
  }

  const spreadPct = getSpreadPct(
    evaluation.metrics.currentBidPrice,
    evaluation.metrics.currentAskPrice,
  );
  const maxAllowedSpreadPct = getMorningSpreadThresholdPct(currentTime);

  if (spreadPct > maxAllowedSpreadPct) {
    return {
      shouldSkip: true,
      skippedReason: `Morning spread gate active (${(spreadPct * 100).toFixed(2)}% spread > ${(maxAllowedSpreadPct * 100).toFixed(2)}% max at ${currentTime.getHours().toString().padStart(2, "0")}:${currentTime.getMinutes().toString().padStart(2, "0")})`,
    };
  }

  return { shouldSkip: false };
}

interface CloseTickChaseParams {
  accountNumber: string;
  baseOrder: OrderPayload;
  orderAction: string;
  startPrice: number;
  edgePrice: number;
  tickSize: number;
  maxTickMoves: number;
  isUrgentClose: boolean;
  tickChaseEnabled: boolean;
  tickIntervalMs: number;
  createOrder: NonNullable<ClosePositionDependencies["createOrder"]>;
  cancelOrder: NonNullable<ClosePositionDependencies["cancelOrder"]>;
  checkOrderFilled: NonNullable<ClosePositionDependencies["checkOrderFilled"]>;
}

// Walks the limit price from startPrice toward edgePrice, re-placing the order
// each tick, until it fills, reaches the edge, or exhausts maxTickMoves.
// Urgent closes must fill: the final move crosses straight to the edge (the
// bid for a sell) instead of stepping one tick at a time.
function advanceClosePrice(
  orderAction: string,
  currentPrice: number,
  edgePrice: number,
  tickSize: number,
  isUrgentClose: boolean,
  isFinalTickMove: boolean,
): number {
  if (isUrgentClose && isFinalTickMove) {
    return edgePrice;
  }
  return moveClosePriceTowardEdge(orderAction, currentPrice, edgePrice, tickSize);
}

// Places one close order, converting a broker rejection (e.g. 422 — stale/phantom
// position, nothing to close, bad order) into `undefined` so the tick-chase loop
// stops instead of letting the throw crash the cycle. The tastytrade error body is
// logged as `order-service-error` at the client chokepoint (core/tastytrade-client).
// NOTE: that used to name createTypedOrderService, which is never wired in
// production — so the body was silently dropped for every rejection until the
// chokepoint logger was added. [preserves main afc73e8 through the PR-27
// runCloseTickChase extraction]
async function placeCloseOrder(
  accountNumber: string,
  order: OrderPayload,
  createOrder: NonNullable<ClosePositionDependencies["createOrder"]>,
): Promise<TastytradePlacedOrderResponse | undefined> {
  try {
    return await createOrder(accountNumber, order);
  } catch (err) {
    console.warn(
      `[close-position] order placement rejected (${accountNumber}) — ${
        err instanceof Error ? err.message : String(err)
      }. Skipping close.`,
    );
    return undefined;
  }
}

// The option-close tick-chase state machine the PR-27 refactor pulled out of
// closePosition: cancel → place → fill-check → advance, up to MAX_CLOSE_TICK_MOVES,
// with urgent-close special-casing plus a rejection break that keeps a 422 from
// crashing the cycle (main afc73e8). The branch count is intrinsic to that loop —
// the single break that tips it over threshold IS the crash-safety guard — and
// splitting it further would scatter one coherent state machine across helpers.
// fallow-ignore-next-line complexity
async function runCloseTickChase(
  params: CloseTickChaseParams,
): Promise<{
  activeOrderId: string | undefined;
  lastOrderResponse: TastytradePlacedOrderResponse | undefined;
}> {
  const {
    accountNumber,
    baseOrder,
    orderAction,
    startPrice,
    edgePrice,
    tickSize,
    maxTickMoves,
    isUrgentClose,
    tickChaseEnabled,
    tickIntervalMs,
    createOrder,
    cancelOrder,
    checkOrderFilled,
  } = params;

  let currentPrice = startPrice;
  let tickMoveCount = 0;
  let activeOrderId: string | undefined;
  let lastOrderResponse: TastytradePlacedOrderResponse | undefined;

  while (tickMoveCount <= maxTickMoves) {
    const mustCancelPrevious =
      Boolean(activeOrderId) && tickChaseEnabled && tickMoveCount > 0;
    const cancelledPrevious = mustCancelPrevious
      ? await cancelOrderById(accountNumber, activeOrderId as string, cancelOrder)
      : true;
    if (!cancelledPrevious) {
      // Can't confirm the previous sell died — placing another would risk
      // a double-sell. Leave the existing order working; the next cycle's
      // cancelAllLiveOrders sweep owns cleanup.
      break;
    }

    const order = {
      ...baseOrder,
      price: (Math.round(currentPrice * 100) / 100).toFixed(2),
    };
    const orderResponse = await placeCloseOrder(accountNumber, order, createOrder);
    if (!orderResponse) {
      // Placement rejected (see placeCloseOrder) — stop chasing; the caller records
      // this leg as a skip instead of letting the throw crash the cycle.
      break;
    }
    lastOrderResponse = orderResponse;
    activeOrderId = orderResponse.order?.id;

    if (!tickChaseEnabled || tickMoveCount >= maxTickMoves) {
      break;
    }

    if (pricesAreEqual(currentPrice, edgePrice)) {
      break;
    }

    const isFilled = activeOrderId
      ? await checkOrderFilled(accountNumber, activeOrderId, tickIntervalMs)
      : false;

    if (isFilled) {
      break;
    }

    currentPrice = advanceClosePrice(
      orderAction,
      currentPrice,
      edgePrice,
      tickSize,
      isUrgentClose,
      tickMoveCount + 1 >= maxTickMoves,
    );
    tickMoveCount += 1;
  }

  return { activeOrderId, lastOrderResponse };
}

// The CLOSE_POSITION decision was made at cycle start with prices that can
// be minutes stale by the time this order goes out. Re-run the strategy
// against the prices this order is actually priced from — a position that
// recovered past its stop (or corrected back below its profit target)
// must not be sold on the stale trigger. EOD forced liquidation always
// bypasses this re-check: its trigger is the clock, not the price. The
// strategy.action gate exempts overnight partial reductions, which are
// exposure-driven closes, not stop/target closes.
function hasStrategyRecoveredAtExecution(
  evaluation: PositionGroupEvaluation,
  snapshot: PositionQuoteSnapshot,
  accountType: StrategyAccountType,
  scaleOut?: ScaleOutContext,
): boolean {
  const isEodForcedClose =
    getTimeInMinutes(evaluation.metrics.currentTime) >= EOD_FORCED_CLOSE_MINUTE;
  if (evaluation.strategy.action !== "CLOSE_POSITION" || isEodForcedClose) {
    return false;
  }

  const freshStrategy = evaluateTradingStrategy(
    {
      currentBidPrice: snapshot.currentBidPrice,
      currentAskPrice: snapshot.currentAskPrice,
      weightedAverageFill: snapshot.weightedAverageFill,
      currentTime: new Date(),
      lastActionTime: evaluation.metrics.lastActionTime,
    },
    accountType,
    scaleOut,
  );

  if (freshStrategy.action !== "MANAGE_ALLOCATION") {
    return false;
  }

  console.warn(
    `[close-position] ${snapshot.position.symbol}: strategy flipped to MANAGE_ALLOCATION at execution time — original close reason "${evaluation.strategy.reason}" no longer holds at bid ${snapshot.currentBidPrice} (${freshStrategy.reason}). Skipping close.`,
  );
  return true;
}

export async function closePosition(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
  dependencies: ClosePositionDependencies = {},
) {
  const results: ClosePositionResult[] = [];
  const createOrder =
    dependencies.createOrder ??
    tastytradeApi.orderService.createOrder.bind(tastytradeApi.orderService);
  const cancelOrder =
    dependencies.cancelOrder ??
    tastytradeApi.orderService.cancelOrder.bind(tastytradeApi.orderService);
  const checkOrderFilled = dependencies.checkOrderFilled ?? waitForOrderFillById;
  const tickChaseEnabled =
    dependencies.tickChaseEnabled ?? CLOSE_TICK_CHASE_ENABLED;
  const isUrgentClose = dependencies.isUrgentClose ?? false;
  const tickIntervalMs = isUrgentClose
    ? dependencies.urgentTickIntervalMs ?? getUrgentCloseTickIntervalMs()
    : dependencies.tickIntervalMs ?? getCloseTickIntervalMs();
  const maxTickMoves = Math.max(
    0,
    dependencies.maxTickMoves ?? MAX_CLOSE_TICK_MOVES,
  );
  let remainingToClose = dependencies.maxQuantityToClose ?? Infinity;
  const orderSource = dependencies.orderSource;

  const morningSpreadGate = dependencies.forceThroughSpreadGate
    ? { shouldSkip: false as const }
    : shouldSkipClosePositionForMorningSpread(evaluation, isUrgentClose);
  if (morningSpreadGate.shouldSkip) {
    return evaluation.positionSnapshots.map((snapshot) => ({
      accountNumber,
      action: "CLOSE_POSITION" as const,
      placedOrder: false,
      skippedReason: morningSpreadGate.skippedReason,
      symbol: snapshot.position.symbol,
      underlyingSymbol: evaluation.underlyingSymbol,
    }));
  }

  for (const snapshot of evaluation.positionSnapshots) {
    if (remainingToClose <= 0) break;

    const snapshotQty = Math.abs(Number(snapshot.position.quantity) || 0);
    const qtyToClose = Math.min(snapshotQty, remainingToClose);

    let baseOrder = buildClosingOrderPayload(snapshot, orderSource);
    if (qtyToClose < snapshotQty && baseOrder) {
      baseOrder = {
        ...baseOrder,
        legs: baseOrder.legs.map((leg) => ({ ...leg, quantity: qtyToClose })),
      };
    }
    if (!baseOrder) {
      results.push({
        accountNumber,
        action: "CLOSE_POSITION",
        placedOrder: false,
        skippedReason: "missing price or quantity",
        symbol: snapshot.position.symbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
      continue;
    }

    const orderAction = baseOrder.legs[0]?.action ?? "";
    const midpointPrice = getMidpointPrice(
      snapshot.currentBidPrice,
      snapshot.currentAskPrice,
    );

    if (!(midpointPrice > 0)) {
      results.push({
        accountNumber,
        action: "CLOSE_POSITION",
        placedOrder: false,
        skippedReason: "missing midpoint price",
        symbol: snapshot.position.symbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
      continue;
    }

    if (
      hasStrategyRecoveredAtExecution(
        evaluation,
        snapshot,
        dependencies.accountType ?? "unknown",
        dependencies.scaleOut,
      )
    ) {
      results.push({
        accountNumber,
        action: "CLOSE_POSITION",
        placedOrder: false,
        skippedReason:
          "strategy flipped to MANAGE_ALLOCATION at execution time (recovered from stop/target)",
        symbol: snapshot.position.symbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
      continue;
    }

    const edgePrice = getEdgePrice(
      orderAction,
      snapshot.currentBidPrice,
      snapshot.currentAskPrice,
      midpointPrice,
      isUrgentClose,
      dependencies.getRegime ?? getCachedSecretRegime,
    );
    // Start high (toward the ask) and walk down to the edge (bid) — the tick size
    // spans the FULL start→edge range so the walk still completes in maxTickMoves.
    const startPrice = getCloseStartPrice(
      orderAction,
      snapshot.currentAskPrice,
      midpointPrice,
      isUrgentClose,
    );
    const tickSize = getCloseTickSize(
      orderAction,
      startPrice,
      edgePrice,
      maxTickMoves,
    );

    let { activeOrderId, lastOrderResponse } = await runCloseTickChase({
      accountNumber,
      baseOrder,
      orderAction,
      startPrice,
      edgePrice,
      tickSize,
      maxTickMoves,
      isUrgentClose,
      tickChaseEnabled,
      tickIntervalMs,
      createOrder,
      cancelOrder,
      checkOrderFilled,
    });

    // Fetch final order state to capture fills for JSONL — createOrder response
    // typically doesn't include fills, but a subsequent getOrder does.
    if (activeOrderId) {
      try {
        const numericId = Number(activeOrderId);
        if (Number.isFinite(numericId)) {
          const finalOrder = await tastytradeApi.orderService.getOrder(
            accountNumber,
            numericId,
          );
          if (lastOrderResponse) {
            lastOrderResponse = { ...lastOrderResponse, order: finalOrder };
          }
        }
      } catch {
        // use lastOrderResponse as-is
      }
    }

    if (!lastOrderResponse) {
      // The tick-chase never got a resting order placed (every attempt was rejected —
      // see the order-placement-rejected warning above). Record a skip, not a fill,
      // so we don't decrement remainingToClose or claim a close that never happened.
      results.push({
        accountNumber,
        action: "CLOSE_POSITION",
        placedOrder: false,
        skippedReason: "order placement rejected by broker (see order-service-error log)",
        symbol: snapshot.position.symbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
      continue;
    }

    remainingToClose -= qtyToClose;
    results.push({
      accountNumber,
      action: "CLOSE_POSITION",
      orderResponse: lastOrderResponse,
      placedOrder: true,
      symbol: snapshot.position.symbol,
      underlyingSymbol: evaluation.underlyingSymbol,
    });
  }

  return results;
}

export default closePosition;
