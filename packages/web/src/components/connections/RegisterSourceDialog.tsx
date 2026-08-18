import { useState } from 'react';
import { FolderGit2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { trpc } from '@/lib/trpc';

/** Registers a local SFDX project directory or a Git repo + ref as a comparison source. */
export function RegisterSourceDialog() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'sfdx-project' | 'git-ref'>('sfdx-project');
  const [label, setLabel] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [gitRef, setGitRef] = useState('main');

  const utils = trpc.useUtils();
  const addConnection = trpc.connections.add.useMutation({
    onSuccess: () => {
      utils.connections.list.invalidate();
      setOpen(false);
      setLabel('');
      setProjectPath('');
    },
  });

  const canSubmit = label.trim() && projectPath.trim() && (kind === 'sfdx-project' || gitRef.trim());

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FolderGit2 className="h-4 w-4" /> Register local source
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a local source</DialogTitle>
          <DialogDescription>A local SFDX project directory, or a Git repo at a specific ref.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sfdx-project">Local SFDX project</SelectItem>
                <SelectItem value="git-ref">Git repo + ref</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="src-label">Label</Label>
            <Input id="src-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="my-feature-branch" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="src-path">{kind === 'sfdx-project' ? 'Project path' : 'Repo path'}</Label>
            <Input
              id="src-path"
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="/Users/you/projects/my-sfdx-app"
            />
          </div>
          {kind === 'git-ref' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="src-ref">Git ref</Label>
              <Input id="src-ref" value={gitRef} onChange={(e) => setGitRef(e.target.value)} placeholder="main" />
            </div>
          )}
          {addConnection.isError && <p className="text-sm text-red-600">{addConnection.error.message}</p>}
        </div>

        <DialogFooter>
          <Button
            disabled={!canSubmit || addConnection.isPending}
            onClick={() =>
              addConnection.mutate(
                kind === 'sfdx-project'
                  ? { kind: 'sfdx-project', label: label.trim(), projectPath: projectPath.trim() }
                  : { kind: 'git-ref', label: label.trim(), projectPath: projectPath.trim(), gitRef: gitRef.trim() },
              )
            }
          >
            {addConnection.isPending ? 'Registering...' : 'Register'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
