import { load } from "cheerio";
import { type CollectedNativeSignal, collectContacts, collectNativeSignals, type NativeFeedItem } from "./native-collector.ts";
import { getWebClient } from "./web-client.ts";

/** Bounded, source-backed discovery. No model call, guessed emails, or automatic publication. */
export async function discoverNativeSignals(query: string): Promise<{ observations: CollectedNativeSignal[]; warnings: string[] }> {
  const warnings: string[] = [];
  const signal = AbortSignal.timeout(90_000);
  const onProgress = (message: string) => {
    if (message.startsWith("Skipped")) warnings.push(message);
  };
  if (/^https?:\/\//i.test(query)) {
    const doc = await getWebClient().scrape(query, { formats: ["markdown", "links"] });
    const website = doc.metadata?.sourceURL ?? query;
    const { contacts, methods } = await collectContacts(website, fetch, false, signal);
    const title = typeof doc.metadata?.title === "string" ? doc.metadata.title : new URL(website).hostname;
    const description = load(`<body>${doc.markdown ?? ""}</body>`)("body")
      .text()
      .slice(0, 1_000);
    return {
      observations: [
        {
          companyWebsite: website,
          contacts,
          amountAsWritten: null,
          stageAsWritten: null,
          fetchMethods: methods,
          input: {
            channel: "native-web",
            url: website,
            title: title.slice(0, 300),
            summary: description || null,
            company: new URL(website).hostname.replace(/^www\./, ""),
            confidence: null,
            tags: ["webpage", ...(contacts.length ? ["public-contact"] : [])],
            metadata: { collector: "signalround-native-v2", company_website: website, public_contacts: contacts, fetch_methods: methods },
          },
        },
      ],
      warnings: contacts.length ? [] : ["No public role-based email found on the pages read. No address was guessed."],
    };
  }
  let items: NativeFeedItem[] | undefined;
  let feedQuery: string | undefined;
  if (query) {
    try {
      const today = new Date();
      const from = new Date(today);
      from.setUTCMonth(from.getUTCMonth() - 3);
      const searchDate = (date: Date) => `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
      const tbs = `cdr:1,cd_min:${searchDate(from)},cd_max:${searchDate(today)}`;
      const results = await getWebClient().search(`${query} startup funding raised`, { limit: 10, sources: ["web"], tbs });
      items = (results.web ?? []).flatMap((result) => {
        const url = result.url;
        const title = result.title ?? result.metadata?.title;
        if (typeof url !== "string" || typeof title !== "string") return [];
        return [
          {
            url,
            title,
            summary: "description" in result && typeof result.description === "string" ? result.description : null,
            author: null,
            publishedAt: null,
            feedUrl: "live-search",
          },
        ];
      });
    } catch (error) {
      warnings.push(
        `Web search unavailable: ${error instanceof Error ? error.message : String(error)}. Searched current funding feeds instead; this is limited coverage, not a whole-web search.`,
      );
      feedQuery = query;
    }
  }
  const observations = await collectNativeSignals({
    items,
    query: feedQuery,
    signal,
    limit: 5,
    since: new Date(Date.now() - 93 * 86_400_000),
    jinaFallback: false,
    onProgress,
  });
  if (!observations.length)
    warnings.unshift(
      "No matching, readable funding announcements found. Try a company website URL or leave the search blank for recent feeds.",
    );
  return { observations, warnings: warnings.slice(0, 20) };
}
