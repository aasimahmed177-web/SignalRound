// The answer engines' crawlers and fetchers. They read a page's HTML without running its scripts, so
// next.config.ts adds them to Next's HTML-limited bots: they get the title, description, and
// canonical blocking in <head>, as Bingbot and Slackbot do, instead of streamed into the body
// after it. Googlebot is left out on purpose: it renders the page and reads streamed metadata.

import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";

export const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "CCBot",
  "Amazonbot",
  "meta-externalagent",
  "meta-externalfetcher",
  "DuckAssistBot",
  "MistralAI-User",
  "cohere-ai",
  "Bytespider",
  "YouBot",
];

/** Next's own list plus the answer engines', matched case-insensitively as Next matches it. */
export const HTML_LIMITED_BOTS = new RegExp(`${HTML_LIMITED_BOT_UA_RE.source}|${AI_CRAWLERS.join("|")}`, "i");
