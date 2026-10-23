import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { collectNativeSignals, DEFAULT_NATIVE_FEEDS } from "../lib/native-collector.ts";
import { ingestSignal } from "../lib/signals.ts";

function values(name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === name && process.argv[index + 1]) out.push(process.argv[index + 1]!);
  }
  return out;
}

function numberArg(name: string, fallback: number): number {
  const raw = values(name)[0];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive number`);
  return value;
}

const apply = process.argv.includes("--apply");
const noJina = process.argv.includes("--no-jina");
const limit = numberArg("--limit", 10);
const days = numberArg("--days", 7);
const feeds = values("--feed");

console.log(`SignalRound native collector (${apply ? "apply" : "dry run"})`);
console.log(`Feeds: ${(feeds.length ? feeds : DEFAULT_NATIVE_FEEDS).join(", ")}`);
console.log(`Window: ${days} day(s); maximum ${limit} observations; NativeWebClient: disabled`);

const observations = await collectNativeSignals({
  feeds,
  limit,
  since: new Date(Date.now() - days * 86_400_000),
  jinaFallback: !noJina,
  onProgress: (message) => console.log(`  ${message}`),
});

let stored = 0;
const handle = apply ? await openStore() : null;
for (const observation of observations) {
  if (handle) {
    await ingestSignal(handle, observation.input);
    stored++;
  }
  console.log(`\n${observation.input.company ?? "Unknown company"}: ${observation.input.title}`);
  console.log(`  article: ${observation.input.url}`);
  console.log(`  website: ${observation.companyWebsite ?? "not resolved"}`);
  console.log(`  funding: ${[observation.amountAsWritten, observation.stageAsWritten].filter(Boolean).join(" · ") || "not parsed"}`);
  console.log(`  contacts: ${observation.contacts.map((contact) => `${contact.email} (${contact.sourceUrl})`).join(", ") || "none found"}`);
  console.log(`  fetch: ${observation.fetchMethods.join(" + ")}`);
}

console.log(
  `\nCollected ${observations.length} real observation(s)${apply ? `; stored ${stored}` : "; nothing written (pass --apply to store)"}.`,
);
if (handle) await closeDb();
