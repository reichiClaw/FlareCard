import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AppleIcon, Loader2Icon, SmartphoneIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
