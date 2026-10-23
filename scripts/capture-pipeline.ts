import { readFile, writeFile } from "node:fs/promises";
import { ROUNDS_PAGE_PROMPT, roundsPageJsonSchema } from "@fireround/core";
import { NativeWebClient } from "@fireround/core/web";

const client = new NativeWebClient();
const cases = JSON.parse(await readFile(new URL("../evals/pipeline-cases.json", import.meta.url), "utf8")) as {
  cases: Array<{ id: string; url: string }>;
};
const additional = JSON.parse(
  await readFile(new URL("../evals/pipeline-new-cases.json", import.meta.url), "utf8").catch(() => '{"cases":[]}'),
) as typeof cases;
cases.cases.push(...additional.cases);
const quoted = !process.argv.includes("--baseline");
const path = new URL(quoted ? "../evals/pipeline-quoted-captures.json" : "../evals/pipeline-captures.json", import.meta.url);
const baseline = quoted
  ? (
      JSON.parse(await readFile(new URL("../evals/pipeline-captures.json", import.meta.url), "utf8")) as {
        captures: Record<string, { markdown: string }>;
      }
    ).captures
  : null;
const previous = await readFile(path, "utf8").catch(() => '{"captures":{}}');
const captures = (JSON.parse(previous) as { captures: Record<string, unknown> }).captures;

for (let start = 0; start < cases.cases.length; start += 4) {
  await Promise.all(
    cases.cases.slice(start, start + 4).map(async ({ id, url }) => {
      if (captures[id] && !process.argv.includes("--refresh")) return;
      const t = performance.now();
      try {
        const doc = await client.scrape(url, {
          formats: ["markdown", { type: "json", schema: roundsPageJsonSchema, prompt: ROUNDS_PAGE_PROMPT }],
          onlyMainContent: true,
          timeout: 60_000,
          maxAge: quoted ? 86_400_000 : 0,
        });
        if (!doc.markdown || !doc.json) throw new Error("missing markdown or JSON");
        const sameMarkdown = baseline?.[id]?.markdown === doc.markdown;
        captures[id] = {
          url,
          markdown: doc.markdown,
          json: doc.json,
          metadata: doc.metadata,
          ms: Math.round(performance.now() - t),
          sameMarkdown,
        };
        process.stderr.write(`${id}: captured${quoted ? (sameMarkdown ? " (same page)" : " (page changed)") : ""}\n`);
      } catch (error) {
        process.stderr.write(`${id}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }),
  );
  await writeFile(path, `${JSON.stringify({ captures }, null, 2)}\n`);
}
