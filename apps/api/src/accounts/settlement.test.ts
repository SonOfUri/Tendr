import { describe, expect, it } from 'vitest';
import { SIM_TOKENS } from '../checkout/oneclick/simulated.js';
import { SETTLEMENT_CHOICES } from './settlement.js';

describe('settlement choices', () => {
  it('every test-mode choice can be quoted by the simulated 1Click (test mode is simulated)', () => {
    for (const c of SETTLEMENT_CHOICES.test) {
      const t = SIM_TOKENS.find((x) => x.assetId === c.asset);
      expect(t, c.asset).toBeDefined();
      expect(t!.symbol).toBe(c.symbol);
      expect(t!.blockchain).toBe('near');
    }
  });

  it('USDC is the one default in each mode, listed first', () => {
    for (const mode of ['test', 'live'] as const) {
      const defaults = SETTLEMENT_CHOICES[mode].filter((c) => c.default);
      expect(defaults.map((c) => c.symbol)).toEqual(['USDC']);
      expect(SETTLEMENT_CHOICES[mode][0]!.default).toBe(true);
    }
  });
});
