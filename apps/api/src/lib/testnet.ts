import { env } from '../env.js';
import { conflict } from './errors.js';
import { assertLiveModeOpen } from './live-mode.js';

export const tidepoolEnabled = () => env().TEST_PAYMENT_PROVIDER === 'tidepool';
export const usesTidepool = (livemode: boolean) => !livemode && tidepoolEnabled();
export const intentsContractFor = (livemode: boolean) =>
  livemode ? env().INTENTS_CONTRACT_LIVE : env().INTENTS_CONTRACT_TEST;

export function assertNativeMode(livemode: boolean) {
  if (livemode) assertLiveModeOpen();
  else if (!tidepoolEnabled())
    throw conflict('Native Intents wallets are available in live mode only');
}
