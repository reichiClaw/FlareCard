import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ImageIcon,
  LockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, type ContactSummary } from "@/lib/api";
import { cn, initials } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states";
import { ContactDialog } from "@/components/contact-dialog";
import { ImportDialog } from "@/components/import-dialog";

const PAGE_SIZE = 25;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ContactsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; uid: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<ContactSummary | null>(null);

  useEffect(() => setPage(0), [q]);

  const contacts = useQuery({
    queryKey: ["contacts", q, page],
    queryFn: () => api.contacts({ q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["contacts"] });
    qc.invalidateQueries({ queryKey: ["settings"] });
  };

  const seed = useMutation({
    mutationFn: api.seedDemo,
    onSuccess: (r) => {
      toast.success(`Loaded ${r.imported} demo contacts`);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Seeding failed"),
  });

  const remove = useMutation({
    mutationFn: (uid: string) => api.deleteContact(uid),
    onSuccess: () => {
      toast.success("Contact deleted");
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });

  const total = contacts.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = contacts.data?.items ?? [];
  const isEmptyDirectory = !contacts.isPending && !contacts.isError && total === 0 && !q;

  const header = useMemo(
    () => (
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-muted-foreground text-sm">
            {contacts.data ? `${contacts.data.total.toLocaleString()} contact${contacts.data.total === 1 ? "" : "s"} in the shared address book` : "Shared address book"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setImporting(true)}>
            <UploadIcon /> Import
          </Button>
          <Button variant="outline" asChild>
            <a href={api.exportUrl} download>
              <DownloadIcon /> Export .vcf
            </a>
          </Button>
          <Button onClick={() => setEditing({ mode: "create" })}>
            <PlusIcon /> New contact
          </Button>
        </div>
      </div>
    ),
    [contacts.data],
  );

  return (
    <div className="space-y-6">
      {header}

      <div className="relative">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          placeholder="Search by name, organization, email or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          aria-label="Search contacts"
        />
      </div>

      <div className="rounded-lg border">
        {contacts.isPending ? (
          <TableSkeleton rows={8} cols={4} />
        ) : contacts.isError ? (
          <div className="p-3">
            <ErrorState error={contacts.error} onRetry={() => contacts.refetch()} />
          </div>
        ) : isEmptyDirectory ? (
          <div className="p-3">
            <EmptyState
              icon={UsersIcon}
              title="No contacts yet"
              description="Create your first contact, import an existing .vcf or CSV export, or load a few demo contacts to try the CardDAV sync."
              action={
                <>
                  <Button onClick={() => setEditing({ mode: "create" })}>
                    <PlusIcon /> New contact
                  </Button>
                  <Button variant="outline" onClick={() => setImporting(true)}>
                    <UploadIcon /> Import
                  </Button>
                  <Button variant="secondary" onClick={() => seed.mutate()} disabled={seed.isPending}>
                    <SparklesIcon /> Load demo contacts
                  </Button>
                </>
              }
            />
          </div>
        ) : items.length === 0 ? (
          <div className="p-3">
            <EmptyState icon={SearchIcon} title="No matches" description={`Nothing matches “${q}”. Try a different name, email or organization.`} />
          </div>
        ) : (
          <Table className={cn(contacts.isFetching && "opacity-70 transition-opacity")}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Organization</TableHead>
                <TableHead className="hidden lg:table-cell">Email</TableHead>
                <TableHead className="hidden sm:table-cell">Phone</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow key={c.uid} className="cursor-pointer" onClick={() => setEditing({ mode: "edit", uid: c.uid })}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                        {c.hasPhoto ? <ImageIcon className="size-4" /> : initials(c.fn)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-medium">
                          <span className="truncate">{c.fn}</span>
                          <span
                            className="text-muted-foreground inline-flex shrink-0"
                            title="Locked: read-only on devices, edit here in the admin UI"
                            role="img"
                            aria-label="Locked, read-only on devices"
                          >
                            <LockIcon className="size-3.5" />
                          </span>
                        </div>
                        <div className="text-muted-foreground truncate text-xs md:hidden">{c.org || c.email || c.phone}</div>
                        {c.title && <div className="text-muted-foreground hidden truncate text-xs md:block">{c.title}</div>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{c.org || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {c.email ? <span className="font-mono text-xs">{c.email}</span> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{c.phone || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.fn}`}>
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing({ mode: "edit", uid: c.uid })}>
                          <PencilIcon /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <a href={`/dav/addressbooks/shared/${encodeURIComponent(c.uid)}.vcf`} target="_blank" rel="noreferrer">
                            <DownloadIcon /> Open .vcf
                          </a>
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(c)}>
                          <Trash2Icon /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeftIcon /> Previous
            </Button>
            <Badge variant="outline">
              {page + 1} / {pageCount}
            </Badge>
            <Button variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRightIcon />
            </Button>
          </div>
        </div>
      )}

      {!isEmptyDirectory && (
        <p className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
          <LockIcon className="size-3" aria-hidden="true" />
          All contacts are locked for devices: they sync read-only and edits made on a phone or Mac are reverted on the next
          sync. Edit them here.{" "}
          <button type="button" className="hover:text-foreground underline underline-offset-2" onClick={() => seed.mutate()} disabled={seed.isPending}>
            Load demo contacts
          </button>
        </p>
      )}

      <ContactDialog
        key={editing ? (editing.mode === "edit" ? editing.uid : "create") : "closed"}
        open={editing !== null}
        uid={editing?.mode === "edit" ? editing.uid : undefined}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          invalidate();
        }}
        onDelete={(uid) => {
          const c = items.find((i) => i.uid === uid);
          setEditing(null);
          setDeleting(c ?? { uid, fn: uid, org: "", title: "", email: "", phone: "", hasPhoto: false, etag: "", updatedAt: 0 });
        }}
      />

      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={invalidate} />

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete contact?</DialogTitle>
            <DialogDescription>
              <span className="text-foreground font-medium">{deleting?.fn}</span> will be removed from every synced device on
              its next sync. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting.uid)}>
              <Trash2Icon /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
