// NEAR gasless signing (NEP-366 meta-transactions, spec §2.3): the wallet signs a delegate action
// holding exactly the payment `ft_transfer` (and, when the shopper pays, the fee `ft_transfer`),
// 1 yoctoNEAR attached each (from the shopper's own account, as NEP-141 requires); Tendr's relayer
// wraps it and pays the gas. The actions are checked here against the quote before the wallet is
// asked. Only wallets that can sign a delegate action get this option (ruling T10-e): others pay
// normally.
import { WalletError, toWalletError } from '../errors';
import type { PayTarget } from '../index';
import { mismatch, uintOf, type GaslessMethod, type GaslessSigner } from './index';

export const NEAR_DELEGATE_KIND = 'near_delegate_action';
const TGAS = 1_000_000_000_000n;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface NearFunctionCallAction {
  type: 'FunctionCall';
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
}

/** Signs one delegate action and returns it as base64 borsh `SignedDelegate`. */
export type NearSignDelegate = (d: {
  receiverId: string;
  actions: NearFunctionCallAction[];
  blockHeightTtl: number;
}) => Promise<string>;

export interface NearGaslessDeps {
  address(): string | null;
  /** The connected wallet's delegate-action signing, or null when it has none. */
  signDelegate(): NearSignDelegate | null;
}

function checkTransfer(raw: unknown, to: string, amount: bigint, field: string) {
  const a = raw as NearFunctionCallAction | null;
  const p = a?.params;
  const args = p?.args;
  if (
    !a ||
    a.type !== 'FunctionCall' ||
    Object.keys(a).length !== 2 ||
    !p ||
    Object.keys(p).length !== 4 ||
    p.methodName !== 'ft_transfer' ||
    p.deposit !== '1' ||
    !args ||
    Object.keys(args).join(',') !== 'receiver_id,amount' ||
    args.receiver_id !== to
  ) {
    throw mismatch(field);
  }
  let gas: bigint;
  try {
    gas = uintOf(p.gas, field);
    if (uintOf(args.amount, field) !== amount) throw mismatch(field);
  } catch {
    throw mismatch(field);
  }
  if (gas < 5n * TGAS || gas > 30n * TGAS) throw mismatch(field);
}

export function createNearGasless(target: PayTarget, deps: NearGaslessDeps): GaslessSigner {
  if (target.family !== 'near') throw new WalletError('failed', { detail: 'not a NEAR asset' });
  return {
    async methods(): Promise<GaslessMethod[]> {
      return deps.signDelegate() && target.kind === 'token' ? ['meta_tx'] : [];
    },
    async nativeBalance() {
      return null;
    },
    async sign(p, e) {
      const address = deps.address();
      const signDelegate = deps.signDelegate();
      if (!address || !signDelegate) throw new WalletError('failed', { detail: 'not connected' });
      if (address !== e.wallet) throw new WalletError('account_changed', { address });
      if (p.to_sign.length !== 1 || p.to_sign[0]!.kind !== NEAR_DELEGATE_KIND) {
        throw mismatch('to_sign');
      }
      const td = p.to_sign[0]!.typed_data as {
        sender_id?: unknown;
        receiver_id?: unknown;
        actions?: unknown;
        block_height_ttl?: unknown;
      } | null;
      if (!td) throw mismatch('typed_data');
      if (td.sender_id !== e.wallet) throw mismatch('sender_id');
      if (td.receiver_id !== target.contract) throw mismatch('receiver_id');
      const actions = td.actions;
      if (!Array.isArray(actions) || actions.length !== (e.fee > 0n ? 2 : 1)) {
        throw mismatch('actions');
      }
      checkTransfer(actions[0], e.depositAddress, e.amount, 'actions[0]');
      if (e.fee > 0n) {
        const to = (actions[1] as NearFunctionCallAction | null)?.params?.args?.receiver_id;
        if (typeof to !== 'string' || to === e.depositAddress || to === e.wallet) {
          throw mismatch('actions[1]');
        }
        checkTransfer(actions[1], to, e.fee, 'actions[1]');
      }
      const ttl = td.block_height_ttl;
      if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 100_000) {
        throw mismatch('block_height_ttl');
      }
      let signed: unknown;
      try {
        signed = await signDelegate({
          receiverId: target.contract!,
          actions: actions as NearFunctionCallAction[],
          blockHeightTtl: ttl,
        });
      } catch (err) {
        // Only a signature: Tendr relays it, so nothing was sent.
        throw toWalletError(err);
      }
      if (typeof signed !== 'string' || !BASE64.test(signed) || signed.length > 1700) {
        throw new WalletError('failed', { detail: 'bad signed delegate' });
      }
      return { kind: 'submit', body: { signed_delegate: signed } };
    },
  };
}
