import { expect, test } from "vitest";
import { readFeedPage } from "../lib/feed-page";
import { listRounds, persistRecords, setDisposition } from "../lib/persist";
import { record, testDb } from "./helpers";

test("numbered feed pages preserve the original row order and API cursor", async () => {
  const handle = await testDb();
  const summary = await persistRecords(
    handle,
    Array.from({ length: 5 }, (_, i) =>
      record({
        company_name: `Page Company ${i}`,
        announced_date: `2026-09-0${i + 1}`,
        sources: [{ url: `https://wire.example/${i}`, host: "wire.example", title: `Round ${i}` }],
      }),
    ),
    "series-a-b",
    "run-1",
  );
  for (const id of summary.changedIds) await setDisposition(handle, id, "publish");
  const original = await listRounds(handle, { limit: 5 });
  const pages = await Promise.all([1, 2, 3].map((page) => readFeedPage(handle, { filters: {}, sort: "", page, size: 2 })));
  expect(pages.flatMap(({ rows }) => rows.map(({ id }) => id))).toEqual(original.rows.map(({ id }) => id));
  expect(pages.map(({ page, count, total }) => ({ page, count, total }))).toEqual([
    { page: 1, count: 3, total: 5 },
    { page: 2, count: 3, total: 5 },
    { page: 3, count: 3, total: 5 },
  ]);
  const cursorPage = await listRounds(handle, { limit: 2, cursor: (await listRounds(handle, { limit: 2 })).nextCursor ?? undefined });
  expect(cursorPage.rows.map(({ id }) => id)).toEqual(pages[1].rows.map(({ id }) => id));
});
