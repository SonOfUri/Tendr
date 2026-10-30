'use client';

import type { DemoDefinition } from '@/lib/demo';

export type DemoFlowStage = 'idle' | 'checkout' | 'settled';

type Props = {
  demo: DemoDefinition;
  stage: DemoFlowStage;
  entityName: string;
  entityLogoUrl: string;
  /** Live cart total (e.g. after coupon). Falls back to demo.amount. */
  amount?: string;
  discountLabel?: string | null;
};

function stepState(index: number, stage: DemoFlowStage): 'done' | 'active' | 'todo' {
  const current = stage === 'idle' ? 0 : stage === 'checkout' ? 1 : 2;
  if (index < current) return 'done';
  if (index === current) return 'active';
  return 'todo';
}

function formatAmount(amount: string) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `$${amount}`;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function DemoFlowStepper({
  demo,
  stage,
  entityName,
  entityLogoUrl,
  amount,
  discountLabel,
}: Props) {
  const steps = demo.flowSteps;
  const displayAmount = amount ?? demo.amount;
  const { entityLabel } = demo.branding;

  return (
    <div className="demo-flow" data-scenario={demo.slug}>
      <ol className="demo-flow-steps" aria-label={`${demo.title} flow`}>
        {steps.map((step, i) => {
          const state = stepState(i, stage);
          return (
            <li key={`${demo.slug}-${step.title}`} className="demo-flow-step" data-state={state}>
              {i < steps.length - 1 ? <span className="demo-flow-connector" aria-hidden /> : null}
              <span className="demo-flow-index" aria-hidden>
                {state === 'done' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M5 13l4 4L19 7"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <div className="demo-flow-copy">
                <span className="demo-flow-kicker">Step {i + 1}</span>
                <span className="demo-flow-title">{step.title}</span>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="demo-flow-meta">
        <div className="demo-flow-meta-item">
          <span className="demo-flow-meta-label">{entityLabel}</span>
          <span className="demo-flow-meta-value demo-flow-meta-store">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={entityLogoUrl} alt="" width={22} height={22} />
            {entityName}
          </span>
        </div>
        <div className="demo-flow-meta-item">
          <span className="demo-flow-meta-label">
            Amount
            {discountLabel ? <span className="demo-flow-meta-promo">{discountLabel}</span> : null}
          </span>
          <span
            className="demo-flow-meta-value demo-flow-meta-amount"
            data-discounted={discountLabel ? 'true' : 'false'}
          >
            {formatAmount(displayAmount)}
          </span>
        </div>
      </div>
    </div>
  );
}
