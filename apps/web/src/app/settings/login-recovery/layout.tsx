// Per-request rendering lets Next attach the middleware's nonce to hydration scripts.
export const dynamic = 'force-dynamic';

export default function LoginRecoveryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
