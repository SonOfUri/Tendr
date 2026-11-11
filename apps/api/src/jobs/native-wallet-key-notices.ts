import type { Event } from '@prisma/client';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { sendOncePerEvent } from '../merchants/store-notices.js';
import { registerEventHandler } from './handlers.js';

export async function onNativeWalletKeysChanged(event: Event) {
  if (!event.merchantId || !event.livemode || event.aggregateType !== 'native_wallet') return;
  const wallet = await prisma.nativeWallet.findFirst({
    where: { id: event.aggregateId, merchantId: event.merchantId, livemode: true },
    include: { owner: true, account: true },
  });
  if (!wallet?.owner.emailVerifiedAt) return;
  const payload = event.payload as { kind?: string };
  const changes: Record<string, string> = {
    add_passkey: 'A new wallet passkey was enabled.',
    add_recovery: 'A wallet recovery kit was enabled. Any previous kit was revoked.',
    recover:
      'A replacement wallet passkey was enabled using the recovery kit. Previous Tendr wallet passkeys were revoked.',
    revoke: 'A wallet key was revoked.',
  };
  await sendOncePerEvent(event.id, 'wallet_keys_changed', [wallet.owner.email], {
    data: {
      at: event.createdAt.toISOString(),
      change: changes[payload.kind ?? ''] ?? 'Your wallet keys changed.',
      account: wallet.account.nearAccountId,
      url: new URL('/dashboard/wallet', env().WEB_URL).toString(),
    },
  });
}
export function registerNativeWalletKeyNotices() {
  registerEventHandler(
    'native_wallet.keys_changed',
    'wallet-key-notice',
    onNativeWalletKeysChanged,
  );
}
