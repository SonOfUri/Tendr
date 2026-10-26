import { describe, expect, it } from 'vitest';
import { WalletError, toWalletError, walletErrorCopy } from './errors';

const SEND_FAILED = "Your wallet couldn't send this payment. Try again or pay by sending manually.";

describe('wallet error copy (never raw wallet or RPC text)', () => {
  it.each([
    [Object.assign(new Error('User rejected the request.'), { code: 4001 })],
    [{ code: 4001, message: 'whatever' }],
    [Object.assign(new Error('x'), { code: 'ACTION_REJECTED' })],
    [new Error('User denied transaction signature')],
    [new Error('Transaction cancelled')],
    [new Error('Confirmation declined by user')],
    ['User closed the window'],
    [new WalletError('rejected')],
  ])('a rejection reads "You cancelled in your wallet" (%#)', (err) => {
    expect(toWalletError(err).kind).toBe('rejected');
    expect(walletErrorCopy(err)).toBe('You cancelled in your wallet.');
  });

  it('a chain mismatch names the network', () => {
    expect(walletErrorCopy(new WalletError('chain_mismatch', { network: 'Base' }))).toBe(
      'Switch your wallet to Base to pay.',
    );
  });

  it.each([
    new Error('execution reverted: ERC20: transfer amount exceeds balance'),
    new Error(
      '-32603 Internal JSON-RPC error. {"code":-32000,"message":"insufficient funds for gas"}',
    ),
    { message: '<script>alert(1)</script>' },
    undefined,
    null,
    42,
    new WalletError('failed'),
    new WalletError('unavailable'),
  ])('everything else is the generic copy (%#)', (err) => {
    const copy = walletErrorCopy(err);
    expect(copy).toBe(SEND_FAILED);
    expect(copy).not.toMatch(/gas|intent|solver|revert|rpc|json/i);
  });
});
