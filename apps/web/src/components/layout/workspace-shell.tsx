import Link from 'next/link';
import { Film, LayoutGrid, Github, Box } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Notion-style app shell: a fixed left sidebar (workspace switcher +
 * navigation) and a main content column. The sidebar is intentionally
 * narrow and information-dense, like Notion's own.
 */
export function WorkspaceShell({
  children,
  active,
  actions,
}: {
  children: React.ReactNode;
  active?: 'jobs' | 'new' | 'viewer';
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-surface">
      <Sidebar active={active} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar actions={actions} />
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

function Sidebar({ active }: { active?: string }) {
  const nav = [
    { href: '/', label: 'Jobs', icon: LayoutGrid, id: 'jobs' },
    { href: '/new', label: 'New capture', icon: Film, id: 'new' },
    { href: '/viewer', label: 'BVH viewer', icon: Box, id: 'viewer' },
  ];
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface-subtle">
      <div className="flex items-center gap-2 px-3 py-3">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-ink text-2xs font-bold text-surface">
          M
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-sm font-semibold">Mocap Studio</span>
          <span className="text-2xs text-ink-muted">motion workspace</span>
        </div>
      </div>

      <div className="px-2 pt-2">
        <Link
          href="/new"
          className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:bg-surface-hover"
        >
          <Film className="h-4 w-4" />
          New capture
        </Link>
      </div>

      <nav className="mt-4 flex flex-1 flex-col gap-0.5 px-2">
        {nav.map(item => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                'flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors',
                isActive ? 'bg-surface-active text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-2">
        <a
          href="https://github.com/ellyseum/mocap_ts"
          target="_blank"
          rel="noreferrer"
          className="flex h-8 items-center gap-2 rounded-md px-2 text-2xs text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink-muted"
        >
          <Github className="h-4 w-4" />
          mocap-ts core
        </a>
      </div>
    </aside>
  );
}

function TopBar({ actions }: { actions?: React.ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
      <div className="flex items-center gap-2 text-sm text-ink-muted">
        <span className="font-medium text-ink">Mocap</span>
        <span className="text-ink-subtle">/</span>
        <span>motion workspace</span>
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </header>
  );
}
