import type { ButtonProps } from '@tendr/ui';
import { Button } from '@tendr/ui';

/** Primary auth action, styled like the demo “Continue to Payment” button. */
export function AuthCta({ className, children, ...rest }: ButtonProps) {
  return (
    <Button className={['login-panel-cta', className].filter(Boolean).join(' ')} {...rest}>
      <span className="login-panel-cta-label">{children}</span>
    </Button>
  );
}
