import { DashboardShell } from '@/components/dashboard/DashboardShell';

// Rendered per request so the CSP nonce set by the middleware reaches Next's scripts. No
// third-party scripts are loaded anywhere under /dashboard (the CSP refuses them).
export const dynamic = 'force-dynamic';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
