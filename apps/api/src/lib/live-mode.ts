// The live-mode switch (`LIVE_MODE_ENABLED`, deploy spec §6). While it is off, nothing live is
// made or used: going live, provisioning a mainnet merchant account, and every write by a
// live-mode principal are refused. One guard, so the checks cannot drift apart.
import { env } from '../env.js';
import { AppError } from './errors.js';

/** The refusal every live path returns while the switch is off. */
export function liveModeUnavailable(): AppError {
  return new AppError(
    'LIVE_MODE_UNAVAILABLE',
    'Live payments are not open yet. Test mode works as usual.',
    403,
  );
}

/** Whether live mode is open platform-wide. */
export function liveModeOpen(): boolean {
  return env().LIVE_MODE_ENABLED;
}

/** Throws `liveModeUnavailable()` while live mode is switched off. */
export function assertLiveModeOpen(): void {
  if (!liveModeOpen()) throw liveModeUnavailable();
}
