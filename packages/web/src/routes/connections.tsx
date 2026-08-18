import { AddOrgDialog } from '@/components/connections/AddOrgDialog';
import { RegisterSourceDialog } from '@/components/connections/RegisterSourceDialog';
import { ConnectionsList } from '@/components/connections/ConnectionsList';

export function ConnectionsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="text-neutral-500 dark:text-neutral-400">
            Orgs come from the <code>sf</code> CLI&apos;s local auth store — VibeSet never stores a credential of its own.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <RegisterSourceDialog />
          <AddOrgDialog />
        </div>
      </div>

      <ConnectionsList />
    </div>
  );
}
