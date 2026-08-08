import { PositionGroupEvaluation } from "./evaluate-position";
import { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import { isOvernightPosition, getPositionAgeDays } from "./position-registry";
import { computeOvernightReductionTargetPct } from "~/strategy/overnight-reduction";
import { OVERNIGHT_REDUCTION_ORDER_SOURCE } from "./order-sources";
import { getDoNotTouchGroupKeys, isEvaluationDoNotTouch } from "./do-not-touch-groups";

// Cash accumulation cutoff: 1:00 PM PT (same as getNoBuyCutoffMinute("cash")).
// Overnight reductions placed after this time serve no purpose — the window
// closes at 11:30 AM and new buys stop at 1:00 PM, so any remaining exposure
// will be held until the next day regardless.
const CASH_ACCUMULATION_CUTOFF_MINUTE = 13 * 60;

function computePartialCloseContracts(
  currentExposurePct: number,
  targetExposurePct: number,
  totalCapital: number,
  avgAskPrice: number,
): number {
  if (avgAskPrice <= 0 || totalCapital <= 0) return 0;
  const valueToSell = (currentExposurePct - targetExposurePct) * totalCapital;
  if (valueToSell <= 0) return 0;
  return Math.ceil(valueToSell / (avgAskPrice * 100));
}

export interface OvernightReductionOrder extends ClosePositionResult {
  reductionTargetPct: number;
  reductionContractsToClose: number;
}

// fallow-ignore-next-line complexity
export async function executeOvernightReductions(
  accountNumber: string,
  evaluations: readonly PositionGroupEvaluation[],
  sharedTargets: ExecutionTargets,
  totalCapital: number,
  alreadyClosingSymbols: ReadonlySet<string>,
  currentTime: Date,
  liveOvernightReductionSymbols: ReadonlySet<string> = new Set(),
): Promise<OvernightReductionOrder[]> {
  // Skip overnight reductions entirely after the cash accumulation cutoff
  // (1:00 PM PT). The reduction window closes at 11:30 AM; placing orders
  // beyond 1:00 PM just generates noise that will never fill.
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  if (minuteOfDay >= CASH_ACCUMULATION_CUTOFF_MINUTE) {
    return [];
  }

  const results: OvernightReductionOrder[] = [];
  const doNotTouchGroupKeys = getDoNotTouchGroupKeys();

  for (const evaluation of evaluations) {
    const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
    if (!symbol) continue;

    if (isEvaluationDoNotTouch(evaluation, doNotTouchGroupKeys)) continue;

    if (alreadyClosingSymbols.has(symbol)) continue;

    // A live overnight-reduction order for this symbol is already working —
    // skip placing a duplicate. The order was placed in a prior cycle and
    // protected from the cancel sweep; let it fill or expire naturally.
    if (liveOvernightReductionSymbols.has(symbol)) {
      console.log(
        JSON.stringify({
          scope: "overnight-position-reduction",
          symbol,
          accountNumber,
          message: "skipped — live overnight reduction order already working",
          currentTime: currentTime.toISOString(),
        }),
      );
      continue;
    }

    const overnight = await isOvernightPosition(accountNumber, symbol);
    if (!overnight) continue;

    const ageDays = await getPositionAgeDays(accountNumber, symbol);

    const totalQuantityWeight = evaluation.positionSnapshots.reduce(
      (sum, s) => sum + s.quantityWeight,
      0,
    );
    if (totalQuantityWeight <= 0) continue;

    const groupAskValue = evaluation.positionSnapshots.reduce(
      (sum, s) => sum + s.currentAskPrice * s.quantityWeight,
      0,
    );
    const currentExposurePct = totalCapital > 0 ? groupAskValue / totalCapital : 0;

    const signals = evaluation.executionTargets?.positionGate?.signals;
    const targetPct = computeOvernightReductionTargetPct(
      currentTime,
      currentExposurePct,
      signals,
      ageDays,
    );

    if (targetPct === null || currentExposurePct <= targetPct) continue;

    const avgAskPrice =
      totalQuantityWeight > 0 ? groupAskValue / totalQuantityWeight : 0;
    const contractsToClose = computePartialCloseContracts(
      currentExposurePct,
      targetPct,
      totalCapital,
      avgAskPrice,
    );

    if (contractsToClose <= 0) continue;

    console.log(
      JSON.stringify({
        scope: "overnight-position-reduction",
        symbol,
        accountNumber,
        ageDays,
        currentExposurePct: Number((currentExposurePct * 100).toFixed(2)),
        targetPct: Number((targetPct * 100).toFixed(2)),
        contractsToClose,
        signalOverride: signals?.crossAccountYes || signals?.strongStockYes || false,
        currentTime: currentTime.toISOString(),
      }),
    );

    // Bypass the morning spread gate. An overnight reduction is a RISK action, not a
    // discretionary exit: it only fires on a position already over its overnight
    // exposure cap, and the cost of not reducing is carrying that excess through the
    // close. Gating it on spread inverts the intent — the illiquid, wide-spread names
    // are exactly the ones you least want to hold oversized overnight.
    //
    // Observed: SGML sat over-cap for THREE sessions (2026-08-05 -> 08-07) while the
    // bot made ~82 reduction attempts per day; 79 of them were rejected with "Morning
    // spread gate active" (60.5% -> 33.6% spread vs a 25-30% cap). Its quantity and
    // cost basis never moved.
    //
    // Deliberately forceThroughSpreadGate and NOT isUrgentClose: urgency additionally
    // disables the mid floor (see midFloorApplies), and a reduction has no reason to
    // concede the whole spread. This bypasses the gate while leaving price protection
    // exactly as it is. Mirrors ee729f1, which did the same for stop-loss exits.
    const closeResults = await closePosition(accountNumber, evaluation, {
      maxQuantityToClose: contractsToClose,
      orderSource: OVERNIGHT_REDUCTION_ORDER_SOURCE,
      forceThroughSpreadGate: true,
    });

    for (const r of closeResults) {
      results.push({
        ...r,
        reductionTargetPct: targetPct,
        reductionContractsToClose: contractsToClose,
      });
    }
  }

  return results;
}
