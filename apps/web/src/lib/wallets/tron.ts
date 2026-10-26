// Tron deposits through TronLink's injected TronWeb (no SDK is bundled). TRX is `sendTrx` in sun;
// USDT (TRC-20, the verified contract in wallets/index.ts) is `transfer(address,uint256)` with the
// amount passed as an exact decimal string. TronLink must be on Tron mainnet (api.trongrid.io).
import { WalletError, toWalletError } from './errors';
import type { PayTarget, WalletAdapter } from './index';
import { assertDepositMatches } from './match';

interface TronWebLike {
  defaultAddress?: { base58?: string | false };
  fullNode?: { host?: string };
  transactionBuilder: {
    sendTrx(to: string, amount: number, from: string): Promise<object>;
    triggerSmartContract(
      contract: string,
      fn: string,
      options: { feeLimit: number },
      params: { type: string; value: string }[],
      from: string,
    ): Promise<{ result?: { result?: boolean }; transaction?: object }>;
  };
  trx: {
    sign(tx: object): Promise<object>;
    sendRawTransaction(tx: object): Promise<{ result?: boolean; txid?: string }>;
  };
}

export interface TronWindow {
  tronLink?: {
    request(args: { method: string }): Promise<{ code?: number } | undefined>;
    tronWeb?: TronWebLike | false;
  };
  tronWeb?: TronWebLike | false;
}

const MAINNET_HOST = /^https:\/\/api\.trongrid\.io\/?$/;
const TXID = /^[0-9a-fA-F]{64}$/;
const BASE58_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
/** 100 TRX: the most a TRC-20 transfer may burn for energy. */
const FEE_LIMIT_SUN = 100_000_000;

function tronWebOf(win: TronWindow): TronWebLike | null {
  const tw = win.tronLink?.tronWeb || win.tronWeb;
  return tw || null;
}

export function createTronAdapter(target: PayTarget, deps: { win: TronWindow }): WalletAdapter {
  if (target.family !== 'tron') throw new WalletError('failed', { detail: 'not a Tron asset' });
  let address: string | null = null;
  return {
    chainFamily: 'tron',
    async connect() {
      const link = deps.win.tronLink;
      if (!link) throw new WalletError('unavailable', { detail: 'TronLink not found' });
      let res: { code?: number } | undefined;
      try {
        res = await link.request({ method: 'tron_requestAccounts' });
      } catch (err) {
        throw toWalletError(err);
      }
      if (res && res.code !== undefined && res.code !== 200) throw new WalletError('rejected');
      const tw = tronWebOf(deps.win);
      const a = tw && tw.defaultAddress?.base58;
      if (!a || !BASE58_ADDRESS.test(a))
        throw new WalletError('unavailable', { detail: 'no account' });
      address = a;
      return { address };
    },
    async sendDeposit(q) {
      const tw = tronWebOf(deps.win);
      if (!address || !tw) throw new WalletError('failed', { detail: 'not connected' });
      const amount = assertDepositMatches(target, q);
      if (!MAINNET_HOST.test(tw.fullNode?.host ?? '')) {
        throw new WalletError('chain_mismatch', { network: 'Tron' });
      }
      let unsigned: object | undefined;
      try {
        if (target.kind === 'native') {
          if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new WalletError('failed', { detail: 'amount too large for TronWeb' });
          }
          unsigned = await tw.transactionBuilder.sendTrx(q.depositAddress, Number(amount), address);
        } else {
          if (!target.contract) throw new WalletError('failed', { detail: 'no token contract' });
          const r = await tw.transactionBuilder.triggerSmartContract(
            target.contract,
            'transfer(address,uint256)',
            { feeLimit: FEE_LIMIT_SUN },
            [
              { type: 'address', value: q.depositAddress },
              { type: 'uint256', value: amount.toString() },
            ],
            address,
          );
          if (!r.result?.result || !r.transaction) {
            throw new WalletError('failed', { detail: 'could not build the transfer' });
          }
          unsigned = r.transaction;
        }
        const signed = await tw.trx.sign(unsigned);
        const sent = await tw.trx.sendRawTransaction(signed);
        if (!sent.result || typeof sent.txid !== 'string' || !TXID.test(sent.txid)) {
          throw new WalletError('failed', { detail: 'not broadcast' });
        }
        return { txHash: sent.txid };
      } catch (err) {
        throw toWalletError(err);
      }
    },
    async disconnect() {
      address = null;
    },
  };
}
