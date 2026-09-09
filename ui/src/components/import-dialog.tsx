import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileUpIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { api, type ImportSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const MAX_BYTES = 25 * 1024 * 1024;

export function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [format, setFormat] = useState<"vcf" | "csv">("vcf");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setText("");
    setFileName(null);
    setResult(null);
  };

  const importMutation = useMutation({
    mutationFn: () => api.importContacts(format, text),
    onSuccess: (r) => {
      setResult(r);
      onImported();
      if (r.imported) toast.success(`Imported ${r.imported} contact${r.imported === 1 ? "" : "s"}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Import failed"),
  });

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error("File is larger than 25 MB");
      return;
    }
    setFileName(file.name);
    setText(await file.text());
    if (/\.csv$/i.test(file.name)) setFormat("csv");
    else if (/\.vcf$|\.vcard$/i.test(file.name)) setFormat("vcf");
    setResult(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          reset();
        }
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>
            Existing contacts with the same UID are replaced. Everything is normalized to vCard 3.0.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={format} onValueChange={(v) => setFormat(v as "vcf" | "csv")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="vcf">vCard (.vcf)</TabsTrigger>
            <TabsTrigger value="csv">CSV</TabsTrigger>
          </TabsList>
          <TabsContent value="vcf" className="text-muted-foreground pt-2 text-sm">
            Exports from Apple Contacts, Google Contacts, Outlook or another CardDAV server. Multiple cards per file are fine;
            vCard 2.1, 3.0 and 4.0 are accepted.
          </TabsContent>
          <TabsContent value="csv" className="text-muted-foreground pt-2 text-sm">
            First row must be a header. Recognized columns include <code className="text-xs">First Name</code>,{" "}
            <code className="text-xs">Last Name</code>, <code className="text-xs">Company</code>,{" "}
            <code className="text-xs">Job Title</code>, <code className="text-xs">Email</code>,{" "}
            <code className="text-xs">Mobile</code>, <code className="text-xs">Work Phone</code>,{" "}
            <code className="text-xs">Street</code>, <code className="text-xs">City</code>, <code className="text-xs">Notes</code>{" "}
            (Google and Outlook header names work too).
          </TabsContent>
        </Tabs>

        <div className="space-y-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="hover:bg-accent/50 flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors"
          >
            <FileUpIcon className="text-muted-foreground size-6" />
            <span className="text-sm font-medium">{fileName ?? "Choose a file"}</span>
            <span className="text-muted-foreground text-xs">.vcf, .vcard or .csv up to 25 MB</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".vcf,.vcard,.csv,text/vcard,text/csv,text/plain"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
            placeholder={format === "vcf" ? "…or paste vCard text here" : "…or paste CSV text here"}
            rows={6}
            className="font-mono text-xs"
          />
        </div>

        {result && (
          <Alert variant={result.imported ? "default" : "destructive"}>
            <AlertTitle>
              {result.imported} imported{result.skipped ? `, ${result.skipped} skipped` : ""}
            </AlertTitle>
            {result.unmappedHeaders && result.unmappedHeaders.length > 0 && (
              <AlertDescription>Ignored columns: {result.unmappedHeaders.join(", ")}</AlertDescription>
            )}
            {!result.imported && !result.skipped && <AlertDescription>No contacts were found in the input.</AlertDescription>}
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => { onClose(); reset(); }}>
            {result ? "Done" : "Cancel"}
          </Button>
          <Button onClick={() => importMutation.mutate()} disabled={!text.trim() || importMutation.isPending}>
            {importMutation.isPending && <Loader2Icon className="animate-spin" />}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
