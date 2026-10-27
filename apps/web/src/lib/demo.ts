import type { Quote, SessionView, Token } from '@/lib/checkout/api';

export type DemoSlug = 'ecommerce' | 'fintech' | 'gaming' | 'prediction-markets';

/** Prefetched checkout payload so the demo panel can skip cold session/token/quote roundtrips. */
export type DemoCheckoutBootstrap = {
  session: SessionView;
  tokens: Token[];
  tokenId: string;
  quote: Quote | null;
};

export type DemoFlowStep = {
  title: string;
};

/** Sidebar + checkout identity for each scenario (no hardcoding in UI). */
export type DemoBranding = {
  /** Meta column label under the stepper (e.g. Store / Studio). */
  entityLabel: string;
  nameFieldLabel: string;
  logoFieldLabel: string;
  defaultName: string;
  defaultLogoUrl: string;
  customizeHint: string;
  /** Prefix before the brand name on checkout (e.g. "Paying"). */
  payEyebrow: string;
};

export type DemoDefinition = {
  slug: DemoSlug;
  title: string;
  /** Compact label for the scenario segmented toggle. */
  shortTitle: string;
  eyebrow: string;
  blurb: string;
  /** Vertical sidebar flow steps (idle → checkout → settled). */
  flowSteps: readonly [DemoFlowStep, DemoFlowStep, DemoFlowStep];
  productName: string;
  productDetail: string;
  amount: string;
  currency: string;
  successHint: string;
  branding: DemoBranding;
  /** Fintech dashboard display helpers */
  balanceLabel?: string;
  changeLabel?: string;
};

const LOGO_STORE = '/demo/adidas-store-logo.png';
const LOGO_FINTECH = '/demo/pulse-finance-icon.png';
const LOGO_GAMING = '/demo/pixel-forge-logo.png';
const LOGO_PREDICTION = '/demo/omni-markets-logo.png';
const LOGO_TENDR = '/demo/tendr-logo.png';

export const DEMOS: DemoDefinition[] = [
  {
    slug: 'ecommerce',
    title: 'E-commerce',
    shortTitle: 'E-commerce',
    eyebrow: 'Store checkout',
    blurb: 'A real cart checkout → Tendr payment → order confirmation after settlement.',
    flowSteps: [
      { title: 'Cart checkout' },
      { title: 'Tendr payment' },
      { title: 'Order confirmation' },
    ],
    productName: 'Your Cart',
    productDetail: '2 items · Men’s puffer + women’s tailored jacket',
    amount: '2213.00',
    currency: 'USD',
    successHint: 'Order confirmed. Fulfillment can proceed.',
    branding: {
      entityLabel: 'Store',
      nameFieldLabel: 'Store name',
      logoFieldLabel: 'Store logo',
      defaultName: 'Adidas',
      defaultLogoUrl: LOGO_STORE,
      customizeHint: 'Shown on the Tendr checkout panel. Settlement routing is unchanged.',
      payEyebrow: 'Paying',
    },
  },
  {
    slug: 'fintech',
    title: 'Fintech',
    shortTitle: 'Fintech',
    eyebrow: 'In-app funding',
    blurb: 'Fund a simulated premium feature. Balances are labelled test-mode only.',
    flowSteps: [
      { title: 'Choose feature' },
      { title: 'Tendr payment' },
      { title: 'Balance credited' },
    ],
    productName: 'Premium Analytics (30 days)',
    productDetail: 'Test-mode funding for an in-app feature unlock.',
    amount: '20.00',
    currency: 'USD',
    successHint: 'Test balance credited. Feature unlocked for this session.',
    branding: {
      entityLabel: 'App',
      nameFieldLabel: 'App name',
      logoFieldLabel: 'App icon',
      defaultName: 'Pulse Finance',
      defaultLogoUrl: LOGO_FINTECH,
      customizeHint: 'Shown on the funding checkout. Balances stay test-mode.',
      payEyebrow: 'Funding',
    },
    balanceLabel: '$ 20.00',
    changeLabel: '+ 13% ($2.77) · Last 30 days',
  },
  {
    slug: 'gaming',
    title: 'Gaming',
    shortTitle: 'Gaming',
    eyebrow: 'Item unlock',
    blurb: 'Purchase a cosmetic. It unlocks only after payment reaches a verified success state.',
    flowSteps: [
      { title: 'Select item' },
      { title: 'Tendr payment' },
      { title: 'Item unlocked' },
    ],
    productName: 'Nebula Skin',
    productDetail: 'Rare cosmetic for your avatar. Equips only after payment settles.',
    amount: '9.99',
    currency: 'USD',
    successHint: 'Nebula Skin unlocked. Equipped in inventory.',
    branding: {
      entityLabel: 'Studio',
      nameFieldLabel: 'Studio name',
      logoFieldLabel: 'Studio logo',
      defaultName: 'Pixel Forge',
      defaultLogoUrl: LOGO_GAMING,
      customizeHint: 'Shown on the in-game checkout panel for this scenario.',
      payEyebrow: 'BUYING FROM',
    },
  },
  {
    slug: 'prediction-markets',
    title: 'Prediction markets',
    shortTitle: 'Prediction',
    eyebrow: 'Ballon d’Or market',
    blurb: 'Pick Kane or Mbappé, then fund the stake through Tendr.',
    flowSteps: [
      { title: 'Pick a winner' },
      { title: 'Tendr payment' },
      { title: 'Stake recorded' },
    ],
    productName: 'Ballon d’Or stake',
    productDetail: 'Harry Kane vs Kylian Mbappé — prediction stake.',
    amount: '25.00',
    currency: 'USD',
    successHint: 'Stake recorded for your Ballon d’Or pick.',
    branding: {
      entityLabel: 'Market',
      nameFieldLabel: 'Market name',
      logoFieldLabel: 'Market logo',
      defaultName: 'Omni Markets',
      defaultLogoUrl: LOGO_PREDICTION,
      customizeHint: 'Shown on the stake checkout for this market.',
      payEyebrow: 'Staking on',
    },
  },
];

export function getDemo(slug: string): DemoDefinition | undefined {
  return DEMOS.find((d) => d.slug === slug);
}

export function demoCodeSnippet(demo: DemoDefinition): string {
  return `import { TendrCheckout, useCheckoutSession } from "@tendr/react"

function App() {
  const session = useCheckoutSession({
    amount: "${demo.amount}",
    currency: "${demo.currency}",
    description: "${demo.productName}",
    mode: "test",
    onSuccess: () => {
      console.log("Payment settled")
    },
  })

  return (
    <div>
      <button onClick={session.open}>Pay with Tendr</button>
      <TendrCheckout {...session} />
    </div>
  )
}`;
}
