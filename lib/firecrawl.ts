import { savePageSnapshot } from "@fireround/core/snapshots";
import { Firecrawl } from "firecrawl";

let client: Firecrawl | null = null;

export function getFirecrawl(): Firecrawl {
  if (client) return client;
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey || apiKey === "fc-YOUR-API-KEY") {
    throw new Error("FIRECRAWL_API_KEY is not set. Copy .env.example to .env and paste your key (https://www.firecrawl.dev/app/api-keys).");
  }
  client = new Firecrawl({ apiKey });
  const scrape = client.scrape.bind(client);
  client.scrape = (async (...args: unknown[]) => {
    const doc = (await Reflect.apply(scrape, client, args)) as { markdown?: string; json?: unknown };
    const options = args[1] as { formats?: unknown[] } | undefined;
    if (typeof args[0] === "string" && options?.formats?.includes("markdown") && doc.markdown) {
      try {
        await savePageSnapshot(args[0], doc.markdown, doc.json);
      } catch {}
    }
    return doc;
  }) as Firecrawl["scrape"];
  const search = client.search.bind(client);
  client.search = (async (...args: unknown[]) => {
    const result = (await Reflect.apply(search, client, args)) as {
      web?: Array<{ url?: string; markdown?: string; metadata?: { sourceURL?: string } }>;
    };
    const options = args[1] as { scrapeOptions?: { formats?: unknown[] } } | undefined;
    if (options?.scrapeOptions?.formats?.includes("markdown")) {
      await Promise.all(
        (result.web ?? []).map(async (page) => {
          const url = page.url ?? page.metadata?.sourceURL;
          if (!url || !page.markdown) return;
          try {
            await savePageSnapshot(url, page.markdown);
          } catch {}
        }),
      );
    }
    return result;
  }) as Firecrawl["search"];
  return client;
}
