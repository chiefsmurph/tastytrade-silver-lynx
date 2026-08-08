// An overnight reduction is a RISK action on an already-over-cap position. Gating it
// on spread inverts the intent: the wide-spread names are exactly the ones you least
// want to hold oversized overnight.
//
// THE CASE (SGML, 2026-08-05 -> 08-07): over its overnight cap for three sessions.
// ~82 reduction attempts per day, 79 rejected with "Morning spread gate active"
// (60.5% -> 33.6% spread vs a 25-30% cap). Quantity and cost basis never moved.
// ee729f1 had already exempted stop-loss and EOD closes — but a reduction is neither,
// so it stayed fully gated.
//
// Deliberately forceThroughSpreadGate and NOT isUrgentClose: urgency ALSO disables the
// mid floor (midFloorApplies), and a reduction has no reason to concede the whole
// spread. These assertions pin that separation.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { shouldSkipClosePositionForMorningSpread } from "~/bot/actions/close-position";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, rel), "utf8");

// A wide-spread, mid-morning group — the SGML shape.
const wideSpreadEvaluation = (): never =>
  ({
    metrics: {
      currentTime: new Date("2026-08-07T14:30:00Z"), // inside the morning window
      currentBidPrice: 1.0,
      currentAskPrice: 2.6, // ~89% spread, far past any cap
      weightedAverageFill: 2.8, // deeply red, so no take-profit escape
    },
  }) as never;

test("the gate DOES block a wide spread for a normal (discretionary) close", () => {
  const gate = shouldSkipClosePositionForMorningSpread(wideSpreadEvaluation(), false);
  assert.equal(gate.shouldSkip, true, "control: without a bypass this must be blocked");
  assert.match(String(gate.skippedReason), /Morning spread gate active/);
});

test("isUrgentClose still bypasses it (ee729f1 unchanged)", () => {
  const gate = shouldSkipClosePositionForMorningSpread(wideSpreadEvaluation(), true);
  assert.equal(gate.shouldSkip, false);
});

test("overnight-position-reduction passes forceThroughSpreadGate", () => {
  const s = src("../overnight-position-reduction.ts");
  // the flag must be inside the closePosition call, not merely present in the file
  const call = s.slice(s.indexOf("await closePosition("));
  const args = call.slice(0, call.indexOf("});") + 3);
  assert.match(args, /orderSource: OVERNIGHT_REDUCTION_ORDER_SOURCE/);
  assert.match(args, /forceThroughSpreadGate: true/);
});

// Strip comments before asserting on absence. An earlier version of this test failed
// on the word "isUrgentClose" inside the explanatory comment that says NOT to use it —
// the assertion matched the prose describing the rule rather than the code obeying it.
const codeOnly = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');

test("overnight reduction does NOT claim urgency (mid floor must stay armed)", () => {
  const code = codeOnly(src("../overnight-position-reduction.ts"));
  assert.ok(
    !/isUrgentClose/.test(code),
    "a reduction must not borrow isUrgentClose — that would also disable the mid floor",
  );
  // and prove the stripper isn't just blanking everything
  assert.match(code, /forceThroughSpreadGate: true/);
});

test("forceThroughSpreadGate bypasses ONLY the spread gate, never the mid floor", () => {
  const s = src("../actions/close-position.ts");
  // the mid floor keys off isUrgentClose alone
  assert.match(s, /!isUrgentClose && isMidFloorEnabled\(\)/);
  assert.ok(
    !/forceThroughSpreadGate[^\n]*midFloor/.test(s) &&
      !/midFloorApplies\([^)]*forceThroughSpreadGate/.test(s),
    "the two concerns must stay separate",
  );
});

// ── the 422 body ───────────────────────────────────────────────────────────────
// createTypedOrderService logs order-service-error WITH the response body, but the
// client wiring never invokes it ("createTypedOrderService is never invoked in the
// wiring" — tastytrade-client.ts). So across 2026-08-06/07, three identical HTTP 422s
// on the SGML close produced ZERO order-service-error lines and the broker's reason
// was discarded. The logging has to live at the chokepoint that actually runs.

test("the order chokepoint logs failures with status AND body", () => {
  const s = src("../../core/tastytrade-client.ts");
  assert.match(s, /scope: "order-service-error"/, "must emit the same scope");
  assert.match(s, /describeOrderError/, "must reuse the helper that extracts the body");
  assert.match(s, /\bbody,/, "the response body is the whole point");
  assert.match(s, /\bstatus,/);
});

test("every mutating order method is wrapped", () => {
  const s = src("../../core/tastytrade-client.ts");
  for (const call of ["createOrder", "replaceOrder", "createComplexOrder", "editOrder"]) {
    assert.match(
      s,
      new RegExp(`withOrderFailureLog\\("${call}"`),
      `${call} must log its rejection`,
    );
  }
});

test("the wrapper RETHROWS — observability only, no behaviour change", () => {
  const s = src("../../core/tastytrade-client.ts");
  const fn = s.slice(s.indexOf("const withOrderFailureLog"));
  const body = fn.slice(0, fn.indexOf("\n};") + 3);
  assert.match(body, /throw error;/, "callers' 422 handling must be unaffected");
  assert.ok(
    body.indexOf("logOrderFailure") < body.indexOf("throw error;"),
    "log before rethrowing, or the log is unreachable",
  );
});

test("the stale pointer to the dead logger is gone", () => {
  const s = src("../actions/close-position.ts");
  assert.ok(
    !/error body is\s*\n?\s*\/\/ logged by the order service \(order-service-error\)\.\s*\[preserves/.test(
      s,
    ),
    "that comment sent the reader to a factory that never runs in production",
  );
  assert.match(s, /never wired in\s*\n\s*\/\/ production/);
});
