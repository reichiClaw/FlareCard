import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CameraIcon, Loader2Icon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api, emptyFields, type AddressField, type ContactFields, type EmailField, type PhoneField } from "@/lib/api";
import { fileToPhoto, photoDataUrl } from "@/lib/photo";
import { initials } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/states";

const PHONE_TYPES = [
  { value: "CELL", label: "Mobile" },
  { value: "WORK", label: "Work" },
  { value: "HOME", label: "Home" },
  { value: "MAIN", label: "Main" },
  { value: "WORK,FAX", label: "Work fax" },
  { value: "HOME,FAX", label: "Home fax" },
  { value: "PAGER", label: "Pager" },
  { value: "OTHER", label: "Other" },
];
const CONTEXT_TYPES = [
  { value: "WORK", label: "Work" },
  { value: "HOME", label: "Home" },
  { value: "OTHER", label: "Other" },
];

interface Props {
  open: boolean;
  uid?: string;
  onClose: () => void;
  onSaved: () => void;
  onDelete: (uid: string) => void;
}

export function ContactDialog({ open, uid, onClose, onSaved, onDelete }: Props) {
  const isEdit = !!uid;
  const detail = useQuery({
    queryKey: ["contact", uid],
    queryFn: () => api.contact(uid!),
    enabled: open && isEdit,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit contact" : "New contact"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Changes are pushed to devices on their next sync." : "Stored as a vCard 3.0 in the shared address book."}
          </DialogDescription>
        </DialogHeader>
        {isEdit && detail.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : isEdit && detail.isError ? (
          <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
        ) : (
          <ContactForm
            initial={isEdit ? detail.data!.fields : emptyFields()}
            uid={uid}
            onCancel={onClose}
            onSaved={onSaved}
            onDelete={isEdit ? () => onDelete(uid!) : undefined}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ContactForm({
  initial,
  uid,
  onCancel,
  onSaved,
  onDelete,
}: {
  initial: ContactFields;
  uid?: string;
  onCancel: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const [f, setF] = useState<ContactFields>(() => structuredClone(initial));
  const [error, setError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const save = useMutation({
    mutationFn: (fields: ContactFields) => (uid ? api.updateContact(uid, fields) : api.createContact(fields)),
    onSuccess: () => {
      toast.success(uid ? "Contact updated" : "Contact created");
      onSaved();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Save failed"),
  });

  const set = <K extends keyof ContactFields>(key: K, value: ContactFields[K]) => setF((prev) => ({ ...prev, [key]: value }));
  const setN = (key: keyof ContactFields["n"], value: string) => setF((prev) => ({ ...prev, n: { ...prev.n, [key]: value } }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const derived = [f.n.prefix, f.n.given, f.n.additional, f.n.family, f.n.suffix].filter((s) => s.trim()).join(" ");
    if (!derived && !f.org.trim()) {
      setError("Enter at least a name or an organization.");
      return;
    }
    save.mutate({ ...f, fn: derived || f.org.trim() });
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoBusy(true);
    try {
      set("photo", await fileToPhoto(file));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not process photo");
    } finally {
      setPhotoBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const displayName = [f.n.given, f.n.family].filter(Boolean).join(" ") || f.org || "New contact";

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          {f.photo ? (
            <img src={photoDataUrl(f.photo)} alt="" className="size-20 rounded-full object-cover ring-1 ring-black/5" />
          ) : (
            <div className="bg-primary/10 text-primary flex size-20 items-center justify-center rounded-full text-xl font-semibold">
              {initials(displayName)}
            </div>
          )}
          {photoBusy && (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white">
              <Loader2Icon className="animate-spin" />
            </div>
          )}
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">Photo</div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={photoBusy}>
              <CameraIcon /> {f.photo ? "Replace" : "Upload"}
            </Button>
            {f.photo && (
              <Button type="button" variant="ghost" size="sm" onClick={() => set("photo", null)}>
                <XIcon /> Remove
              </Button>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => pickPhoto(e.target.files?.[0])} />
          </div>
          <p className="text-muted-foreground text-xs">Resized to 512px and stored as JPEG (max 512 KB).</p>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-6">
        <Field label="Prefix" className="sm:col-span-1">
          <Input value={f.n.prefix} onChange={(e) => setN("prefix", e.target.value)} placeholder="Dr." />
        </Field>
        <Field label="First name" className="sm:col-span-2">
          <Input ref={firstFieldRef} value={f.n.given} onChange={(e) => setN("given", e.target.value)} />
        </Field>
        <Field label="Middle" className="sm:col-span-1">
          <Input value={f.n.additional} onChange={(e) => setN("additional", e.target.value)} />
        </Field>
        <Field label="Last name" className="sm:col-span-2">
          <Input value={f.n.family} onChange={(e) => setN("family", e.target.value)} />
        </Field>
        <Field label="Nickname" className="sm:col-span-2">
          <Input value={f.nickname} onChange={(e) => set("nickname", e.target.value)} />
        </Field>
        <Field label="Organization" className="sm:col-span-2">
          <Input value={f.org} onChange={(e) => set("org", e.target.value)} />
        </Field>
        <Field label="Department" className="sm:col-span-2">
          <Input value={f.department} onChange={(e) => set("department", e.target.value)} />
        </Field>
        <Field label="Job title" className="sm:col-span-3">
          <Input value={f.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Birthday" className="sm:col-span-3">
          <Input type="date" value={f.birthday} onChange={(e) => set("birthday", e.target.value)} />
        </Field>
      </section>

      <ListSection
        title="Phones"
        items={f.phones}
        onChange={(phones) => set("phones", phones)}
        create={(): PhoneField => ({ type: "CELL", value: "" })}
        render={(p, update) => (
          <>
            <TypeSelect value={p.type} options={PHONE_TYPES} onChange={(type) => update({ ...p, type })} />
            <Input type="tel" value={p.value} onChange={(e) => update({ ...p, value: e.target.value })} placeholder="+1 555 0100" className="flex-1" />
          </>
        )}
      />

      <ListSection
        title="Emails"
        items={f.emails}
        onChange={(emails) => set("emails", emails)}
        create={(): EmailField => ({ type: "WORK", value: "" })}
        render={(e, update) => (
          <>
            <TypeSelect value={e.type} options={CONTEXT_TYPES} onChange={(type) => update({ ...e, type })} />
            <Input type="email" value={e.value} onChange={(ev) => update({ ...e, value: ev.target.value })} placeholder="name@company.com" className="flex-1" />
          </>
        )}
      />

      <ListSection
        title="Addresses"
        items={f.addresses}
        onChange={(addresses) => set("addresses", addresses)}
        create={(): AddressField => ({ type: "WORK", street: "", city: "", region: "", postalCode: "", country: "" })}
        stacked
        render={(a, update) => (
          <div className="grid flex-1 gap-2 sm:grid-cols-6">
            <TypeSelect value={a.type} options={CONTEXT_TYPES} onChange={(type) => update({ ...a, type })} className="sm:col-span-2" />
            <Input value={a.street} onChange={(e) => update({ ...a, street: e.target.value })} placeholder="Street" className="sm:col-span-4" />
            <Input value={a.city} onChange={(e) => update({ ...a, city: e.target.value })} placeholder="City" className="sm:col-span-2" />
            <Input value={a.region} onChange={(e) => update({ ...a, region: e.target.value })} placeholder="State / Region" className="sm:col-span-2" />
            <Input value={a.postalCode} onChange={(e) => update({ ...a, postalCode: e.target.value })} placeholder="Postal code" className="sm:col-span-2" />
            <Input value={a.country} onChange={(e) => update({ ...a, country: e.target.value })} placeholder="Country" className="sm:col-span-6" />
          </div>
        )}
      />

      <ListSection
        title="Websites"
        items={f.urls}
        onChange={(urls) => set("urls", urls)}
        create={() => ({ type: "WORK", value: "" })}
        render={(u, update) => (
          <>
            <TypeSelect value={u.type} options={CONTEXT_TYPES} onChange={(type) => update({ ...u, type })} />
            <Input type="url" value={u.value} onChange={(e) => update({ ...u, value: e.target.value })} placeholder="https://" className="flex-1" />
          </>
        )}
      />

      <Field label="Notes">
        <Textarea value={f.note} onChange={(e) => set("note", e.target.value)} rows={3} />
      </Field>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DialogFooter className="sm:justify-between">
        <div>
          {onDelete && (
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete}>
              <Trash2Icon /> Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending || photoBusy}>
            {save.isPending && <Loader2Icon className="animate-spin" />}
            {uid ? "Save changes" : "Create contact"}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function TypeSelect({
  value,
  options,
  onChange,
  className,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  className?: string;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <Select value={known ? value : "OTHER"} onValueChange={onChange}>
      <SelectTrigger className={`w-32 ${className ?? ""}`} aria-label="Type">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ListSection<T>({
  title,
  items,
  onChange,
  create,
  render,
  stacked = false,
}: {
  title: string;
  items: T[];
  onChange: (items: T[]) => void;
  create: () => T;
  render: (item: T, update: (next: T) => void) => React.ReactNode;
  stacked?: boolean;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{title}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...items, create()])}>
          <PlusIcon /> Add
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-xs">None</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className={`flex gap-2 ${stacked ? "items-start" : "items-center"}`}>
              {render(item, (next) => onChange(items.map((x, j) => (j === i ? next : x))))}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${title.toLowerCase()} entry`}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
