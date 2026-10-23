import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const styles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--tendr-indigo)',
    color: 'var(--tendr-white)',
    border: '1px solid transparent',
  },
  secondary: {
    background: 'transparent',
    color: 'var(--tendr-white)',
    border: '1px solid var(--tendr-border)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--tendr-lavender)',
    border: '1px solid transparent',
  },
};

export function Button({ variant = 'primary', children, style, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      style={{
        ...styles[variant],
        borderRadius: 'var(--tendr-radius)',
        padding: '0.75rem 1.25rem',
        fontFamily: 'var(--tendr-font-sans)',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
