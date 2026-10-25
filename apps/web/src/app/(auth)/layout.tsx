// Sign-up, sign-in, email confirmation and invites. Rendered per request so the CSP nonce set by
// the middleware reaches Next's scripts.
export const dynamic = 'force-dynamic';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="auth-shell">{children}</div>;
}
