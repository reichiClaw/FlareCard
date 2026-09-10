import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AppleIcon, BadgeCheckIcon, Loader2Icon, RefreshCwIcon, ShieldAlertIcon, ShieldOffIcon, SmartphoneIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import type { SigningStatus } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/states";
import { CopyButton } from "@/components/copy-button";

export function SetupPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  if (settings.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;

  const s = settings.data;
  const scheme = s.useSSL ? "https" : "http";
  const baseUrl = `${scheme}://${s.host}`;
  const serverUrl = `${baseUrl}/dav/`;
  const addressbookUrl = `${baseUrl}${s.addressbookPath}`;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Device setup</h1>
        <p className="text-muted-foreground text-sm">
          Share these instructions with your team. Every user needs their own username and app password from the{" "}
          <Link to="/users" className="hover:text-foreground underline underline-offset-2">Users</Link> page.
        </p>
      </div>

      {!s.useSSL && (
        <Alert variant="destructive">
          <AlertTitle>Not served over HTTPS</AlertTitle>
          <AlertDescription>
            iOS and DAVx5 require TLS for Basic auth in practice. Put FlareCard behind Caddy/nginx with a certificate before
            handing these instructions out.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Server details</CardTitle>
          <CardDescription>Fixed paths; the same shared address book is served to every user.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Detail label="Server / discovery URL" value={serverUrl} />
          <Detail label="Address book URL" value={addressbookUrl} />
          <Detail label="Well-known" value={`${baseUrl}/.well-known/carddav`} />
          <Detail label="Principal URL pattern" value={`${baseUrl}/dav/principals/<username>/`} />
        </CardContent>
      </Card>

      <Tabs defaultValue="apple">
        <TabsList>
          <TabsTrigger value="apple">
            <AppleIcon /> iOS &amp; macOS
          </TabsTrigger>
          <TabsTrigger value="android">
            <SmartphoneIcon /> Android (DAVx5)
          </TabsTrigger>
        </TabsList>

        <TabsContent value="apple">
          <Card>
            <CardHeader>
              <CardTitle>iPhone, iPad and Mac</CardTitle>
              <CardDescription>The quickest path is the per-user configuration profile.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Steps
                title="Option A — install the profile"
                steps={[
                  <>Open <Link to="/users" className="underline underline-offset-2">Users</Link> and click <em>iOS/macOS profile</em> next to the person. Send them the <code>.mobileconfig</code> file (AirDrop, email, MDM).</>,
                  <>On iOS: open the file, then go to <em>Settings → Profile Downloaded → Install</em>. On macOS: double-click, then <em>System Settings → Privacy &amp; Security → Profiles → Install</em>.</>,
                  <>When prompted, enter the app password. The account appears in Contacts as “{s.addressbookName}”.</>,
                ]}
              />
              <Steps
                title="Option B — add manually"
                steps={[
                  <>iOS: <em>Settings → Apps → Contacts → Contacts Accounts → Add Account → Other → Add CardDAV Account</em>. macOS: <em>Contacts → Settings → Accounts → + → Other Contacts Account → CardDAV</em>, account type <em>Manual</em>.</>,
                  <>Server: <code>{s.host}</code> — Username: their username — Password: their app password.</>,
                  <>Tap <em>Next</em>. Discovery goes through <code>/.well-known/carddav</code> automatically.</>,
                ]}
              />
              <Alert>
                <AlertTitle>Read-only by design</AlertTitle>
                <AlertDescription>
                  Contacts can be viewed, called and messaged from the shared address book, but edits made on the device are
                  rejected by the server (HTTP 403) and reverted on the next sync. Edit contacts here in the admin UI instead.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="android">
          <Card>
            <CardHeader>
              <CardTitle>Android with DAVx5</CardTitle>
              <CardDescription>
                DAVx5 is an open-source CardDAV sync adapter available on Google Play and F-Droid.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Steps
                title="Add the account"
                steps={[
                  <>Install <em>DAVx5</em>, open it and tap <em>+</em> (Add account).</>,
                  <>Choose <em>Login with URL and user name</em>. Base URL: <code>{serverUrl}</code> — User name and password: the person's FlareCard credentials.</>,
                  <>Tap <em>Login</em>, then <em>Create account</em>. Under <em>CardDAV</em>, tick “{s.addressbookName}”. Set the sync interval you prefer.</>,
                  <>Grant the Contacts permission. The contacts show up in the stock Contacts app (or Google Contacts) under the DAVx5 account.</>,
                ]}
              />
              <Alert>
                <AlertTitle>Tips</AlertTitle>
                <AlertDescription>
                  <p>Disable battery optimisation for DAVx5 if syncs are delayed.</p>
                  <p>Edits made on the phone show a sync error and are reverted; that is expected — this address book is read-only.</p>
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AddressBookSettings name={s.addressbookName} description={s.addressbookDescription} />
      <LockMarkerSettings enabled={s.lockMarker} mark={s.lockMark} />
      <ProfileSigningSettings />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{label}</div>
      <div className="flex items-center gap-2">
        <code className="bg-muted flex-1 truncate rounded-md border px-2.5 py-1.5 text-xs">{value}</code>
        <CopyButton value={value} label="Copy" />
      </div>
    </div>
  );
}

function Steps({ title, steps }: { title: string; steps: React.ReactNode[] }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 text-sm leading-relaxed">
            <span className="bg-primary/10 text-primary flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
              {i + 1}
            </span>
            <span className="[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs">{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AddressBookSettings({ name, description }: { name: string; description: string }) {
  const qc = useQueryClient();
  const [n, setN] = useState(name);
  const [d, setD] = useState(description);
  const save = useMutation({
    mutationFn: () => api.updateSettings({ addressbookName: n, addressbookDescription: d }),
    onSuccess: () => {
      toast.success("Address book settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Address book name</CardTitle>
        <CardDescription>Shown as the account and group name in Contacts apps.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ab-name">Display name</Label>
            <Input id="ab-name" value={n} onChange={(e) => setN(e.target.value)} maxLength={100} required />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="ab-desc">Description</Label>
            <Textarea id="ab-desc" value={d} onChange={(e) => setD(e.target.value)} maxLength={500} rows={2} />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={save.isPending || !n.trim()}>
              {save.isPending && <Loader2Icon className="animate-spin" />}
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function LockMarkerSettings({ enabled, mark }: { enabled: boolean; mark: string }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (lockMarker: boolean) => api.updateSettings({ lockMarker }),
    onSuccess: (res, lockMarker) => {
      toast.success(
        lockMarker ? `Names on devices now end with ${mark}` : `Lock marker removed from device names`,
        { description: `${res.touched} contact${res.touched === 1 ? "" : "s"} flagged for resync.` },
      );
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lock marker on devices</CardTitle>
        <CardDescription>
          Phones and Macs cannot show that a contact is read-only, so FlareCard can append {mark} to every name in the
          vCards it sends to devices. Names here in the admin UI stay unchanged.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="lock-marker" className="text-sm font-medium">
              Append {mark} to names during sync
            </Label>
            <p className="text-muted-foreground text-xs">
              Example: <span className="font-medium">Ada Lovelace</span> appears as{" "}
              <span className="font-medium">Ada Lovelace {mark}</span> in Contacts. Changing this makes every device
              re-download the address book on its next sync.
            </p>
          </div>
          <Switch
            id="lock-marker"
            checked={enabled}
            disabled={save.isPending}
            onCheckedChange={(v) => save.mutate(v)}
            aria-label={`Append ${mark} to names during sync`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function signingBadge(s: SigningStatus) {
  if (s.source === "external" || (s.source === "managed" && s.enabled && s.phase !== "error")) {
    return (
      <Badge variant="success">
        <BadgeCheckIcon /> Signed
      </Badge>
    );
  }
  if (s.enabled && s.inProgress) {
    return (
      <Badge variant="secondary">
        <Loader2Icon className="animate-spin" /> Requesting certificate
      </Badge>
    );
  }
  if (s.enabled && s.phase === "error") {
    return (
      <Badge variant="destructive">
        <ShieldAlertIcon /> Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      <ShieldOffIcon /> Not signed
    </Badge>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function ProfileSigningSettings() {
  const qc = useQueryClient();
  const signing = useQuery({
    queryKey: ["signing"],
    queryFn: api.signing,
    refetchInterval: (q) => (q.state.data?.inProgress ? 2000 : false),
  });
  const [email, setEmail] = useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["signing"] });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateSigning({ enabled, email: (email ?? signing.data?.email ?? "") || undefined }),
    onSuccess: (res) => {
      if (res.enabled) toast.success(res.phase === "issued" ? "Profiles are now signed" : "Requesting a certificate from Let's Encrypt…");
      else toast.success("Profiles are downloaded unsigned again");
      qc.setQueryData(["signing"], res);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update signing"),
  });
  const renew = useMutation({
    mutationFn: api.renewSigning,
    onSuccess: (res) => {
      toast.success("Renewal started");
      qc.setQueryData(["signing"], res);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not renew"),
  });

  if (signing.isPending) return <Skeleton className="h-48 w-full" />;
  if (signing.isError) return <ErrorState error={signing.error} onRetry={() => signing.refetch()} />;
  const s = signing.data;
  const emailValue = email ?? s.email ?? "";
  const busy = toggle.isPending || renew.isPending;
  const hostMismatch = s.enabled && s.domain && s.currentHost && s.domain !== s.currentHost;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Profile signing</CardTitle>
          {signingBadge(s)}
        </div>
        <CardDescription>
          Signed <code>.mobileconfig</code> files show “Verified” instead of “Not Signed” on iPhones and Macs. FlareCard can
          obtain and renew a free Let's Encrypt certificate for <span className="font-medium">{s.currentHost}</span> by itself;
          nothing to install or rotate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border p-4 text-sm">
          <p>{s.message}</p>
          {s.certificate && (
            <dl className="text-muted-foreground mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
              <dt className="font-medium">Certificate for</dt>
              <dd>{s.certificate.dnsNames.join(", ") || s.certificate.subject}</dd>
              <dt className="font-medium">Valid</dt>
              <dd>
                {formatDate(s.certificate.notBefore)} – {formatDate(s.certificate.notAfter)} ({s.certificate.daysLeft} days left
                {s.source === "managed" ? ", renews automatically" : ""})
              </dd>
              <dt className="font-medium">Key</dt>
              <dd>{s.certificate.algorithm}</dd>
            </dl>
          )}
          {s.error && <p className="text-destructive mt-3 text-xs break-words">{s.error}</p>}
          {hostMismatch && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
              The certificate was requested for <span className="font-medium">{s.domain}</span> but FlareCard is now reached as{" "}
              <span className="font-medium">{s.currentHost}</span>. Use “Renew now” to request one for the current hostname.
            </p>
          )}
        </div>

        {s.source === "external" ? (
          <p className="text-muted-foreground text-xs">
            A certificate is provided through <code>PROFILE_SIGNING_KEY</code>/<code>PROFILE_SIGNING_CERT</code> or the{" "}
            <code>SIGNING_CERTS</code> binding; it takes precedence over automatic signing.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="acme-email">Contact e-mail for Let's Encrypt (optional)</Label>
              <Input
                id="acme-email"
                type="email"
                placeholder="it@example.com"
                value={emailValue}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
              <p className="text-muted-foreground text-xs">Only used for expiry warnings from Let's Encrypt. Requires the server to be reachable from the internet as {s.currentHost}.</p>
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="signing-enabled" className="text-sm font-medium">
                Sign profiles automatically
              </Label>
              <Switch id="signing-enabled" checked={s.enabled} disabled={busy} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Sign profiles automatically" />
            </div>
            {s.enabled && (
              <div className="sm:col-span-2">
                <Button type="button" variant="outline" size="sm" disabled={busy || s.inProgress} onClick={() => renew.mutate()}>
                  {renew.isPending ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                  Renew now
                </Button>
              </div>
            )}
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          Let's Encrypt verifies ownership by fetching <code>http://{s.currentHost}/.well-known/acme-challenge/…</code>, which
          FlareCard answers itself. On Cloudflare nothing else is needed; behind your own reverse proxy make sure that path is
          forwarded to FlareCard.{" "}
          {s.acmeDirectory.includes("staging") && <span className="text-amber-700 dark:text-amber-300">Using the Let's Encrypt staging directory: certificates will not be trusted by devices.</span>}
        </p>
      </CardContent>
    </Card>
  );
}
