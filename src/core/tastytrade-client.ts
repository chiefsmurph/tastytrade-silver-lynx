import TastytradeClient from "@tastytrade/api";
import { describeOrderError } from "~/core/tastytrade-order-service";
import { config } from "dotenv";
import { assertNotReadOnly } from "./read-only-accounts";
import type { TypedOrderService } from "./tastytrade-order-service";
import type { getBidAskForSymbol as GetBidAskForSymbol, getUnderlyingPrice as GetUnderlyingPrice } from "./market-data";
import type { fetchOptionChain as FetchOptionChain, fetchOptionChainWithVolume as FetchOptionChainWithVolume } from "./option-service";
import type {
  CurrentPosition,
  TastytradeCustomerAccountResource,
  TastytradeOptionChains,
  TastytradeAccountBalance,
  TastytradeCurrentPosition,
} from "./types";

config();

const rawTastytradeApi = new TastytradeClient({
  baseUrl: process.env.CORE_BASE_URL as string,
  accountStreamerUrl: "wss://streamer.cert.tastyworks.com/streamer",
  refreshToken: process.env.CORE_API_REFRESH_TOKEN as string,
  clientSecret: process.env.CORE_API_CLIENT_SECRET as string,
  oauthScopes: ["read", "trade"],
});

type RawTastytradeClient = InstanceType<typeof TastytradeClient>;

type TypedAccountsAndCustomersService = {
  getCustomerAccounts(): Promise<TastytradeCustomerAccountResource[]>;
} & RawTastytradeClient["accountsAndCustomersService"];

type TypedBalancesAndPositionsService = {
  getPositionsList(accountNumber: string): Promise<CurrentPosition[]>;
  getAccountBalanceValues(accountNumber: string): Promise<TastytradeAccountBalance>;
} & RawTastytradeClient["balancesAndPositionsService"];

type TypedInstrumentsService = {
  getNestedOptionChain(symbol: string): Promise<TastytradeOptionChains>;
} & RawTastytradeClient["instrumentsService"];

type TypedOrderServiceWithRaw = TypedOrderService & RawTastytradeClient["orderService"];

export interface JohnsService {
  fetchOptionChain: (
    ...args: Parameters<typeof FetchOptionChain>
  ) => ReturnType<typeof FetchOptionChain>;
  fetchOptionChainWithVolume: (
    ...args: Parameters<typeof FetchOptionChainWithVolume>
  ) => ReturnType<typeof FetchOptionChainWithVolume>;
  getBidAskForSymbol: (
    ...args: Parameters<typeof GetBidAskForSymbol>
  ) => ReturnType<typeof GetBidAskForSymbol>;
  getUnderlyingPrice: (
    ...args: Parameters<typeof GetUnderlyingPrice>
  ) => ReturnType<typeof GetUnderlyingPrice>;
}

export type TypedTastytradeClient = Omit<
  RawTastytradeClient,
  "accountsAndCustomersService" | "balancesAndPositionsService" | "instrumentsService" | "orderService"
> & {
  accountsAndCustomersService: TypedAccountsAndCustomersService;
  balancesAndPositionsService: TypedBalancesAndPositionsService;
  instrumentsService: TypedInstrumentsService;
  johnsService: JohnsService;
  orderService: TypedOrderServiceWithRaw;
};

const tastytradeApi = rawTastytradeApi as unknown as TypedTastytradeClient;

const rawGetPositionsList =
  tastytradeApi.balancesAndPositionsService.getPositionsList.bind(
    tastytradeApi.balancesAndPositionsService,
  );

const rawGetAccountBalanceValues =
  tastytradeApi.balancesAndPositionsService.getAccountBalanceValues.bind(
    tastytradeApi.balancesAndPositionsService,
  );

tastytradeApi.balancesAndPositionsService.getPositionsList = async (
  accountNumber: string,
) => {
  const positions =
    await rawGetPositionsList(accountNumber) as unknown as TastytradeCurrentPosition[];

  return positions as unknown as CurrentPosition[];
};

tastytradeApi.balancesAndPositionsService.getAccountBalanceValues = async (
  accountNumber: string,
) => {
  const accountBalance =
    await rawGetAccountBalanceValues(accountNumber) as unknown as TastytradeAccountBalance;

  return accountBalance;
};

// Broker rejection logging at the same chokepoint.
//
// `createTypedOrderService` already logs `order-service-error` WITH the response
// body — but it "is never invoked in the wiring" (see below), so that logger has
// never once fired in production. Two days of identical HTTP 422s on the same
// close (SGML, 2026-08-06/07) were reported as bare "status code 422" with the
// broker's reason discarded, because close-position's catch only reads
// `err.message`. Log it HERE, where every mutating call actually passes, so the
// reason survives for any path — close, seed, allocation, or manual IPC.
const logOrderFailure = (
  call: string,
  accountNumber: string,
  error: unknown,
): void => {
  const { status, body } = describeOrderError(error);
  console.error(
    JSON.stringify({
      scope: "order-service-error",
      call,
      accountNumber,
      status,
      body,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
};

// Rethrows unchanged — this is observability only, every caller's error handling
// (the tick-chase 422 break, seed skip paths) behaves exactly as before.
const withOrderFailureLog = async <T>(
  call: string,
  accountNumber: string,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    logOrderFailure(call, accountNumber, error);
    throw error;
  }
};

// Read-only enforcement at the broker chokepoint.
//
// The production `orderService` is the raw SDK client (createTypedOrderService
// is never invoked in the wiring), so guarding the typed factory alone would
// NOT protect the live path. Wrap the raw mutating placement methods here so
// every caller — run-cycle, manual IPC (bot:seedSymbol / purchaseSymbol /
// closePosition), and secret-auto-seed — must cross the same check.
//
// Dry-run / preview endpoints (postOrderDryRun, replacementOrderDryRun) are
// intentionally left unwrapped: they are non-mutating and are legitimately
// used on read-only accounts for margin / buying-power effect calculations.
const rawCreateOrder = tastytradeApi.orderService.createOrder.bind(
  tastytradeApi.orderService,
);
const rawReplaceOrder = tastytradeApi.orderService.replaceOrder.bind(
  tastytradeApi.orderService,
);
const rawCreateComplexOrder = tastytradeApi.orderService.createComplexOrder.bind(
  tastytradeApi.orderService,
);
const rawEditOrder = tastytradeApi.orderService.editOrder.bind(
  tastytradeApi.orderService,
);

tastytradeApi.orderService.createOrder = ((accountNumber: string, order) => {
  assertNotReadOnly(accountNumber);
  return withOrderFailureLog("createOrder", accountNumber, () =>
    rawCreateOrder(accountNumber, order),
  );
}) as typeof tastytradeApi.orderService.createOrder;

tastytradeApi.orderService.replaceOrder = ((
  accountNumber: string,
  orderId,
  replacementOrder,
) => {
  assertNotReadOnly(accountNumber);
  return withOrderFailureLog("replaceOrder", accountNumber, () =>
    rawReplaceOrder(accountNumber, orderId, replacementOrder),
  );
}) as typeof tastytradeApi.orderService.replaceOrder;

tastytradeApi.orderService.createComplexOrder = ((
  accountNumber: string,
  order,
) => {
  assertNotReadOnly(accountNumber);
  return withOrderFailureLog("createComplexOrder", accountNumber, () =>
    rawCreateComplexOrder(accountNumber, order),
  );
}) as typeof tastytradeApi.orderService.createComplexOrder;

tastytradeApi.orderService.editOrder = ((
  accountNumber: string,
  orderId,
  order,
) => {
  assertNotReadOnly(accountNumber);
  return withOrderFailureLog("editOrder", accountNumber, () =>
    rawEditOrder(accountNumber, orderId, order),
  );
}) as typeof tastytradeApi.orderService.editOrder;

tastytradeApi.johnsService = {
  async getBidAskForSymbol(...args) {
    const { getBidAskForSymbol } = await import("./market-data");
    return getBidAskForSymbol(...args);
  },
  async getUnderlyingPrice(...args) {
    const { getUnderlyingPrice } = await import("./market-data");
    return getUnderlyingPrice(...args);
  },
  async fetchOptionChain(...args) {
    const { fetchOptionChain } = await import("./option-service");
    return fetchOptionChain(...args);
  },
  async fetchOptionChainWithVolume(...args) {
    const { fetchOptionChainWithVolume } = await import("./option-service");
    return fetchOptionChainWithVolume(...args);
  },
};

export default tastytradeApi;


