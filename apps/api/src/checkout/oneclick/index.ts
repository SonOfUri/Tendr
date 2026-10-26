// `providerFor(livemode)`: the real 1Click client in live mode, the simulated provider in test
// mode. One instance per mode per process (the simulated provider keeps its deposits in memory).
import { env } from '../../env.js';
import { setSimulatedTxSource } from '../../near/fake.js';
import { HttpOneClick } from './http.js';
import { SimulatedOneClick } from './simulated.js';
export {
  MemorySimStore,
  RedisSimStore,
  SIM_KEY_PREFIX,
  type RedisSimStoreOptions,
  type SimStore,
} from './sim-store.js';
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
  if (!test) installSimulated(new SimulatedOneClick());
  return test!;
}

/**
 * Makes `sim` the test-mode provider and lets the fake NEAR client answer `txStatus` for its
 * simulated settlements' destination transactions.
 */
function installSimulated(sim: SimulatedOneClick | null): void {
  test = sim;
  setSimulatedTxSource(sim ? (hash) => sim.destinationTx(hash) : null);
}

/** Tendr's fee account for a mode (the `appFees` recipient). */
export function feeAccountFor(livemode: boolean): string {
  const e = env();
  return livemode ? e.FEE_ACCOUNT_LIVE : e.FEE_ACCOUNT_TEST;
}

/**
 * Drops the cached providers (tests). `simulated` installs the test-mode provider to use next,
 * e.g. one on an isolated Redis key prefix (`isolatedSimStore()` in src/test/sim-1click.ts).
 */
export function resetOneClickProviders(opts: { simulated?: SimulatedOneClick } = {}): void {
  live = null;
  installSimulated(opts.simulated ?? null);
}
