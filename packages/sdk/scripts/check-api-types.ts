// Compile-time integration checks against the API's actual serializers (no DB or network).
import type {
  CreateSessionInput,
  CreatedSession,
  SessionView,
} from '../../../apps/api/src/checkout/sessions.js';
import type {
  merchantRefundView,
  MerchantRefundInputSchema,
} from '../../../apps/api/src/checkout/merchant-refunds.js';
import type { PaymentLinkView } from '../../../apps/api/src/payment-links/links.js';
import type { HookCallView } from '../../../apps/api/src/hooks/hooks.js';
import type { GasSponsorshipView } from '../../../apps/api/src/gas/sponsorships.js';
import type {
  ThemeObject as ApiTheme,
  ThemeUpdate as ApiThemeUpdate,
} from '../../contracts/src/themes.js';
import type { z } from 'zod';
import type {
  CheckoutSession,
  CreatedCheckoutSession,
  SessionCreateInput,
  RefundObject,
  RefundCreateInput,
  PaymentLinkObject,
  HookCall,
  GasSponsorship,
  ThemeObject,
  ThemeUpdate,
} from '../src/index.js';

type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;
// Prisma JSON columns and unannotated literals are broader in the internal serializer.
type SessionFields = Exclude<keyof SessionView, 'line_items' | 'delivery'>;
export type Checks = [
  Assert<Fits<SessionCreateInput, CreateSessionInput>>,
  Assert<Fits<CreatedSession, CreatedCheckoutSession>>,
  Assert<Fits<Pick<SessionView, SessionFields>, Pick<CheckoutSession, SessionFields>>>,
  Assert<Fits<keyof SessionView, keyof CheckoutSession>>,
  Assert<Fits<keyof CheckoutSession, keyof SessionView>>,
  Assert<Fits<Awaited<ReturnType<typeof merchantRefundView>>, RefundObject>>,
  Assert<Fits<RefundCreateInput, z.infer<typeof MerchantRefundInputSchema>>>,
  Assert<Fits<PaymentLinkView, PaymentLinkObject>>,
  Assert<Fits<Omit<HookCallView, 'status'>, Omit<HookCall, 'status'>>>,
  Assert<Fits<GasSponsorshipView, GasSponsorship>>,
  Assert<Fits<ApiTheme, ThemeObject>>,
  Assert<Fits<ThemeObject, ApiTheme>>,
  Assert<Fits<ApiThemeUpdate, ThemeUpdate>>,
  Assert<Fits<ThemeUpdate, ApiThemeUpdate>>,
];
declare const session: Pick<SessionView, SessionFields>;
export const sessionCheck: Pick<CheckoutSession, SessionFields> = session;
