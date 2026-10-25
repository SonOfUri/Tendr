// `providerFor(livemode)`: the real 1Click client in live mode, the simulated provider in test
// mode. One instance per mode per process (the simulated provider keeps its deposits in memory).
import { env } from '../../env.js';
import { HttpOneClick } from './http.js';
import { SimulatedOneClick } from './simulated.js';
export { MemorySimStore, RedisSimStore, type SimStore } from './sim-store.js';
import type { OneClickProvider } from './types.js';

export * from './types.js';
export { HttpOneClick } from './http.js';
export {
  SIMULATE_SCENARIOS,
  SimulatedOneClick,
  simulatedDestinationTxHash,
  type SimulateScenario,
} from './simulated.js';

let live: HttpOneClick | null = null;
let test: SimulatedOneClick | null = null;

export function providerFor(livemode: boolean): OneClickProvider {
  return livemode ? liveOneClick() : simulatedOneClick();
}

function liveOneClick(): HttpOneClick {
  if (!live) {
    const e = env();
    live = new HttpOneClick({
      baseUrl: e.ONECLICK_BASE_URL,
      ...(e.ONECLICK_API_KEY ? { apiKey: e.ONECLICK_API_KEY } : {}),
    });
  }
  return live;
}

/** The process-wide test-mode provider (for `simulate()`). */
export function simulatedOneClick(): SimulatedOneClick {
  test ??= new SimulatedOneClick();
  return test;
}

/** Tendr's fee account for a mode (the `appFees` recipient). */
export function feeAccountFor(livemode: boolean): string {
  const e = env();
  return livemode ? e.FEE_ACCOUNT_LIVE : e.FEE_ACCOUNT_TEST;
}

/** Drops the cached providers (tests). */
export function resetOneClickProviders(): void {
  live = null;
  test = null;
}
