import type { Event } from '@prisma/client';
import { LOGIN_RECOVERY_EVENTS } from '../auth/login-recovery.js';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { sendOncePerEvent } from '../merchants/store-notices.js';
import { handlerNamesFor, registerEventHandler } from './handlers.js';

export async function onLoginRecoveryNotice(event: Event) {
  if (event.merchantId || event.aggregateType !== 'user') return;
  const user = await prisma.user.findUnique({ where: { id: event.aggregateId } });
  if (!user?.emailVerifiedAt) return;
  const template =
    event.type === LOGIN_RECOVERY_EVENTS.codes
      ? 'login_recovery_codes_changed'
      : 'login_recovery_completed';
  await sendOncePerEvent(event.id, template, [user.email], {
    data: {
      at: event.createdAt.toISOString(),
      url: new URL('/settings/login-recovery', env().WEB_URL).toString(),
    },
  });
}
export function registerLoginRecoveryNotices() {
  for (const type of Object.values(LOGIN_RECOVERY_EVENTS)) {
    if (!handlerNamesFor(type).includes('login-recovery-notice'))
      registerEventHandler(type, 'login-recovery-notice', onLoginRecoveryNotice);
  }
}
