import { Link, Outlet } from '@tanstack/react-router';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/connections', label: 'Connections' },
  { to: '/comparisons', label: 'Comparisons' },
  { to: '/deployments', label: 'Deployments' },
  { to: '/history', label: 'History' },
] as const;

export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <span className="text-base font-semibold tracking-tight">VibeSet</span>
          <nav className="flex gap-1">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-50',
                )}
                activeProps={{
                  className: 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900',
                }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
