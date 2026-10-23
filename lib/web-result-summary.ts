export interface WebResultSummary {
  status: "completed" | "partial" | "failed";
  count?: number;
  unit?: string;
  provider?: string;
  detail: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Summarize known result shapes without treating a successful action as a successful read. */
export function summarizeWebResult(value: unknown): WebResultSummary {
  const envelope = record(value);
  const result = record(envelope.result);
  const metadata = record(result.metadata);
  const provider =
    typeof result.provider === "string" ? result.provider : typeof metadata.provider === "string" ? metadata.provider : undefined;
  let count: number | undefined;
  let unit: string | undefined;
  const collection = (items: unknown, label: string) => {
    if (Array.isArray(items)) {
      count = items.length;
      unit = label;
    }
  };
  switch (envelope.mode) {
    case "extract":
      collection(result.items, "matches");
      break;
    case "search":
      if (Array.isArray(result.web) && Array.isArray(result.news)) {
        count = result.web.length + result.news.length;
        unit = "results";
      }
      break;
    case "crawl":
      collection(result.data, "pages");
      break;
    case "audit":
      collection(result.pages, "pages");
      break;
    case "browser":
      collection(result.frames, "frames");
      break;
    case "discussion":
      collection(result.items, "posts / comments");
      break;
    case "map":
      collection(result.links, "links");
      break;
    case "scrape":
    case "reader":
    case "adaptive":
      if (typeof result.markdown === "string" || typeof result.html === "string") {
        count = 1;
        unit = "page";
      }
      if (Array.isArray(record(result.json).entries)) collection(record(result.json).entries, "feed entries");
      break;
  }
  const errors = Array.isArray(result.errors) ? result.errors.length : 0;
  const remaining = [result.remaining, result.remainingDiscovered].find((n) => typeof n === "number" && n > 0);
  const omitted = Array.isArray(result.omittedUrls) ? result.omittedUrls.length : 0;
  const partial =
    result.status === "partial" ||
    result.partial === true ||
    result.truncated === true ||
    metadata.truncated === true ||
    errors > 0 ||
    remaining !== undefined ||
    omitted > 0;
  const failed = result.status === "failed" || count === undefined || (count === 0 && partial);
  const status = failed ? "failed" : partial ? "partial" : "completed";
  const detail =
    count === undefined
      ? "Unrecognized response. Inspect the JSON before using it."
      : failed
        ? "The read failed. Inspect the JSON for errors."
        : partial
          ? "Some content was omitted or could not be read. Inspect the JSON for limits and errors."
          : count === 0
            ? "No matches returned. This does not prove none exist."
            : "Completed within this operation’s scope and limits.";
  return { status, count, unit, provider, detail };
}
