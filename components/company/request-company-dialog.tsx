"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { addRequest } from "@/lib/company-request-history";
import { loadRequests, saveRequests } from "@/lib/company-request-storage";

/** This browser's list of requests; a browser that refuses storage still gets its company page. */
function rememberRequest(id: string, companyUrl: string) {
  const domain = decodeURIComponent(companyUrl.slice("/companies/".length));
  saveRequests(addRequest(loadRequests(), { id, domain, submittedAt: Date.now() }));
}

export function RequestCompanyForm({
  initialWebsite = "",
  onSuccess,
  className,
}: {
  initialWebsite?: string;
  onSuccess?: () => void;
  className?: string;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [website, setWebsite] = useState(initialWebsite);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [existingUrl, setExistingUrl] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    setExistingUrl("");
    try {
      const response = await fetch("/api/company-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: website }),
      });
      const data = (await response.json()) as { error?: string; id?: string; companyUrl?: string };
      if (!response.ok) {
        setError(data.error ?? "The request could not be started. Please try again.");
        return;
      }
      if (!data.companyUrl?.startsWith("/companies/")) throw new Error("Missing company URL");
      if (!data.id) {
        setExistingUrl(data.companyUrl);
        return;
      }
      rememberRequest(data.id, data.companyUrl);
      onSuccess?.();
      router.push(data.companyUrl);
    } catch {
      setError("The request could not be started. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className={className}>
      <label htmlFor={fieldId} className="text-label-small">
        Company website
      </label>
      <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          id={fieldId}
          aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-error` : ""}`}
          aria-invalid={Boolean(error)}
          autoComplete="url"
          inputMode="url"
          placeholder="company.com"
          value={website}
          onChange={(event) => {
            setWebsite(event.target.value);
            setError("");
            setExistingUrl("");
          }}
          required
          maxLength={2048}
          className="h-10 sm:flex-1"
        />
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Starting research..." : "Research it"}
        </Button>
      </div>
      <p id={`${fieldId}-hint`} className="mt-1.5 text-body-small text-muted-foreground">
        The company's own website, for example apple.com
      </p>
      {error && (
        <p id={`${fieldId}-error`} role="alert" className="mt-2 text-body-small text-crimson-ink">
          {error}
        </p>
      )}
      {existingUrl && (
        <p role="status" className="mt-2 text-body-small text-muted-foreground">
          Already in Fireround.{" "}
          <Link href={existingUrl} className="text-foreground underline underline-offset-4">
            Open the company page
          </Link>
          .
        </p>
      )}
    </form>
  );
}

export function RequestCompanyDialog({
  initialWebsite = "",
  trigger,
  open,
  onOpenChange,
}: {
  initialWebsite?: string;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const changeOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Dialog open={open ?? localOpen} onOpenChange={changeOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-md">
        <DialogTitle>Research this company</DialogTitle>
        <DialogDescription>Enter the company's website. We'll check the site and look for funding announcements.</DialogDescription>
        <RequestCompanyForm initialWebsite={initialWebsite} onSuccess={() => changeOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
