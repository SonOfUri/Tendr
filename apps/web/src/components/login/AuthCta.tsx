import type { ReactNode } from 'react';
import type { ButtonProps } from '@tendr/ui';
import { Button } from '@tendr/ui';

type AuthCtaProps = ButtonProps & {
  icon?: ReactNode;
  /** Dark passkey-style CTA, or Tendr yellow email CTA. */
  tone?: 'dark' | 'yellow';
};

/** Primary auth action, styled like the demo “Continue to Payment” button. */
export function AuthCta({
  className,
  children,
  icon,
  tone = 'dark',
  ...rest
}: AuthCtaProps) {
  return (
    <Button
      className={[
        'login-panel-cta',
        tone === 'yellow' ? 'login-panel-cta--yellow' : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <span className="login-panel-cta-label">
        {icon ? <span className="login-panel-cta-icon">{icon}</span> : null}
        {children}
      </span>
    </Button>
  );
}
