import { z } from 'zod';

export const MerchantKindValues = ['merchant', 'integrator'] as const;
export type MerchantKind = (typeof MerchantKindValues)[number];
export const MerchantKindSchema = z.enum(MerchantKindValues);

export const MerchantStatusValues = ['active', 'suspended', 'closed'] as const;
export type MerchantStatus = (typeof MerchantStatusValues)[number];
export const MerchantStatusSchema = z.enum(MerchantStatusValues);

export const MerchantUserRoleValues = ['owner', 'admin', 'finance', 'viewer'] as const;
export type MerchantUserRole = (typeof MerchantUserRoleValues)[number];
export const MerchantUserRoleSchema = z.enum(MerchantUserRoleValues);

export const ApiKeyKindValues = ['secret', 'publishable'] as const;
export type ApiKeyKind = (typeof ApiKeyKindValues)[number];
export const ApiKeyKindSchema = z.enum(ApiKeyKindValues);

export const AccountKeyKindValues = ['passkey', 'fn_call'] as const;
export type AccountKeyKind = (typeof AccountKeyKindValues)[number];
export const AccountKeyKindSchema = z.enum(AccountKeyKindValues);

export const PayoutModeValues = ['wallet', 'intents'] as const;
export type PayoutMode = (typeof PayoutModeValues)[number];
export const PayoutModeSchema = z.enum(PayoutModeValues);

export const AllowlistStatusValues = ['pending', 'active', 'revoked'] as const;
export type AllowlistStatus = (typeof AllowlistStatusValues)[number];
export const AllowlistStatusSchema = z.enum(AllowlistStatusValues);

export const PaymentLinkStatusValues = ['active', 'inactive', 'expired'] as const;
export type PaymentLinkStatus = (typeof PaymentLinkStatusValues)[number];
export const PaymentLinkStatusSchema = z.enum(PaymentLinkStatusValues);

export const GasSponsorValues = ['default', 'merchant', 'buyer'] as const;
export type GasSponsor = (typeof GasSponsorValues)[number];
export const GasSponsorSchema = z.enum(GasSponsorValues);

export const ResolvedGasSponsorValues = ['merchant', 'buyer'] as const;
export type ResolvedGasSponsor = (typeof ResolvedGasSponsorValues)[number];
export const ResolvedGasSponsorSchema = z.enum(ResolvedGasSponsorValues);

export const AmountModeValues = ['EXACT_IN', 'EXACT_OUT'] as const;
export type AmountMode = (typeof AmountModeValues)[number];
export const AmountModeSchema = z.enum(AmountModeValues);

export const DeliveryValues = ['WEBHOOK', 'HOOK'] as const;
export type Delivery = (typeof DeliveryValues)[number];
export const DeliverySchema = z.enum(DeliveryValues);

export const FeePayerValues = ['merchant', 'payer'] as const;
export type FeePayer = (typeof FeePayerValues)[number];
export const FeePayerSchema = z.enum(FeePayerValues);

export const RefundReasonValues = ['expired', 'late', 'underpaid', 'failed'] as const;
export type RefundReason = (typeof RefundReasonValues)[number];
export const RefundReasonSchema = z.enum(RefundReasonValues);

export const ExternalTxStatusValues = ['pending', 'submitted', 'confirmed', 'failed'] as const;
export type ExternalTxStatus = (typeof ExternalTxStatusValues)[number];
export const ExternalTxStatusSchema = z.enum(ExternalTxStatusValues);

export const SponsorshipMethodValues = ['eip3009', 'permit', 'paymaster', 'paymaster_verifying', 'paymaster_erc20', 'energy', 'fee_payer'] as const;
export type SponsorshipMethod = (typeof SponsorshipMethodValues)[number];
export const SponsorshipMethodSchema = z.enum(SponsorshipMethodValues);

export const SponsorValues = ['merchant', 'tendr'] as const;
export type Sponsor = (typeof SponsorValues)[number];
export const SponsorSchema = z.enum(SponsorValues);

export const ScreeningDecisionValues = ['allow', 'block'] as const;
export type ScreeningDecision = (typeof ScreeningDecisionValues)[number];
export const ScreeningDecisionSchema = z.enum(ScreeningDecisionValues);

export const RevenueSourceValues = ['app_fee', 'spread'] as const;
export type RevenueSource = (typeof RevenueSourceValues)[number];
export const RevenueSourceSchema = z.enum(RevenueSourceValues);

export const ThemeStatusValues = ['draft', 'published'] as const;
export type ThemeStatus = (typeof ThemeStatusValues)[number];
export const ThemeStatusSchema = z.enum(ThemeStatusValues);

export const ThemeModeValues = ['light', 'dark', 'auto'] as const;
export type ThemeMode = (typeof ThemeModeValues)[number];
export const ThemeModeSchema = z.enum(ThemeModeValues);

export const ThemeLayoutValues = ['modal', 'inline', 'page'] as const;
export type ThemeLayout = (typeof ThemeLayoutValues)[number];
export const ThemeLayoutSchema = z.enum(ThemeLayoutValues);

export const ThemeAssetKindValues = ['logo', 'image', 'font'] as const;
export type ThemeAssetKind = (typeof ThemeAssetKindValues)[number];
export const ThemeAssetKindSchema = z.enum(ThemeAssetKindValues);

export const IdempotencyStatusValues = ['in_progress', 'completed'] as const;
export type IdempotencyStatus = (typeof IdempotencyStatusValues)[number];
export const IdempotencyStatusSchema = z.enum(IdempotencyStatusValues);
