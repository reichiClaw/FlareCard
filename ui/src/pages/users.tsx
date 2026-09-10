import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AppleIcon,
  KeyRoundIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  ShieldIcon,
  Trash2Icon,
  UserIcon,
  UserXIcon,
  UsersIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, type PublicUser } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states";
import { CopyButton } from "@/components/copy-button";

export function UsersPage() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users });
  const signing = useQuery({ queryKey: ["signing"], queryFn: api.signing, staleTime: 60_000 });
  const profilesSigned = signing.data ? signing.data.source !== "none" && (signing.data.source === "external" || signing.data.enabled) : null;
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ username: string; password: string; created: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "reset" | "delete"; user: PublicUser } | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["users"] });
    qc.invalidateQueries({ queryKey: ["settings"] });
  };

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { disabled?: boolean; role?: "admin" | "user" } }) => api.updateUser(id, patch),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });
  const reset = useMutation({
    mutationFn: (u: PublicUser) => api.resetPassword(u.id).then((r) => ({ ...r, username: u.username })),
    onSuccess: (r) => {
      setConfirm(null);
      setSecret({ username: r.username, password: r.password, created: false });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Reset failed"),
  });
  const remove = useMutation({
    mutationFn: (u: PublicUser) => api.deleteUser(u.id),
    onSuccess: () => {
      setConfirm(null);
      toast.success("User deleted");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });

  const items = users.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-muted-foreground text-sm">
            Each person gets an app password for CardDAV. Admins can also sign in here.
            {profilesSigned === false && (
              <>
                {" "}
                Downloaded profiles are unsigned;{" "}
                <Link to="/setup" className="hover:text-foreground underline underline-offset-2">
                  enable profile signing
                </Link>{" "}
                so iPhones show them as “Verified”.
              </>
            )}
            {profilesSigned === true && <> Downloaded profiles are signed.</>}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon /> New user
        </Button>
      </div>

      <div className="rounded-lg border">
        {users.isPending ? (
          <TableSkeleton rows={4} cols={4} />
        ) : users.isError ? (
          <div className="p-3">
            <ErrorState error={users.error} onRetry={() => users.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-3">
            <EmptyState icon={UsersIcon} title="No users" description="Create a user to hand out CardDAV credentials." />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="hidden md:table-cell">Created</TableHead>
                <TableHead className="text-right">Profile</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <TableRow key={u.id} className={u.disabled ? "opacity-60" : undefined}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full">
                          {u.role === "admin" ? <ShieldIcon className="size-4" /> : <UserIcon className="size-4" />}
                        </div>
                        <div>
                          <div className="font-medium">
                            {u.username} {isMe && <span className="text-muted-foreground text-xs">(you)</span>}
                          </div>
                          <div className="text-muted-foreground font-mono text-xs">/dav/principals/{encodeURIComponent(u.username)}/</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role}</Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {u.disabled ? <Badge variant="destructive">Disabled</Badge> : <Badge variant="success">Active</Badge>}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden md:table-cell">{formatDate(u.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" asChild>
                        <a href={api.profileUrl(u.id)} download>
                          <AppleIcon /> iOS/macOS profile
                        </a>
                      </Button>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.username}`}>
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setConfirm({ kind: "reset", user: u })}>
                            <KeyRoundIcon /> Reset app password
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={isMe}
                            onSelect={() => update.mutate({ id: u.id, patch: { role: u.role === "admin" ? "user" : "admin" } })}
                          >
                            <ShieldIcon /> {u.role === "admin" ? "Make regular user" : "Make admin"}
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={isMe} onSelect={() => update.mutate({ id: u.id, patch: { disabled: !u.disabled } })}>
                            <UserXIcon /> {u.disabled ? "Enable" : "Disable"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" disabled={isMe} onSelect={() => setConfirm({ kind: "delete", user: u })}>
                            <Trash2Icon /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        Need Android? Point people at the <Link to="/setup" className="hover:text-foreground underline underline-offset-2">device setup</Link> page for DAVx5 instructions.
      </p>

      <CreateUserDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(username, password) => {
          setCreating(false);
          invalidate();
          setSecret({ username, password, created: true });
        }}
      />

      <Dialog open={secret !== null} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{secret?.created ? "User created" : "App password reset"}</DialogTitle>
            <DialogDescription>
              This password for <span className="text-foreground font-medium">{secret?.username}</span> is shown once. Share
              it securely; it cannot be retrieved later, only reset again.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-muted flex items-center justify-between gap-3 rounded-md border px-4 py-3">
            <code className="text-lg font-semibold tracking-wide select-all">{secret?.password}</code>
            <CopyButton value={secret?.password ?? ""} />
          </div>
          <Alert variant="info">
            <AlertTitle>Next step</AlertTitle>
            <AlertDescription>
              Download the iOS/macOS profile for this user or follow the DAVx5 guide. The device will ask for this password.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.kind === "reset" ? "Reset app password?" : "Delete user?"}</DialogTitle>
            <DialogDescription>
              {confirm?.kind === "reset"
                ? `Devices signed in as ${confirm.user.username} will stop syncing until they enter the new password.`
                : `${confirm?.user.username} will lose access immediately. Contacts already synced to their devices remain on those devices until the account is removed there.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            {confirm?.kind === "reset" ? (
              <Button onClick={() => reset.mutate(confirm.user)} disabled={reset.isPending}>
                {reset.isPending && <Loader2Icon className="animate-spin" />}
                Reset password
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => confirm && remove.mutate(confirm.user)} disabled={remove.isPending}>
                <Trash2Icon /> Delete
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (username: string, password: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createUser(username.trim(), role),
    onSuccess: (r) => {
      setUsername("");
      setRole("user");
      setError(null);
      onCreated(r.user.username, r.password);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not create user"),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New user</DialogTitle>
            <DialogDescription>An app password is generated automatically and shown once after creation.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-username">Username</Label>
            <Input
              id="new-username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="jane.doe"
              pattern="[a-zA-Z0-9._@+\-]{2,64}"
              required
            />
            <p className="text-muted-foreground text-xs">Letters, digits and . _ @ + - only. Used as the CardDAV login.</p>
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "admin" | "user")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User — read-only CardDAV access</SelectItem>
                <SelectItem value="admin">Admin — can also manage contacts and users</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !username.trim()}>
              {create.isPending && <Loader2Icon className="animate-spin" />}
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
