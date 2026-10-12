// The API reference page (app/(site)/docs) names only what the OpenAPI document serves: every
// endpoint, every parameter, and every query parameter its copyable requests send.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { expect, test } from "vitest";
import { GET as openapiGet } from "../app/api/v1/openapi.json/route";
import { API_ENDPOINTS } from "../lib/api-docs";

type Spec = { paths: Record<string, { get?: { parameters?: Array<{ name: string; in: string }> } }> };

const spec = async () => (await openapiGet(new Request("http://app.test/api/v1/openapi.json")).json()) as Spec;
const paramsOf = (s: Spec, path: string) => (s.paths[path]?.get?.parameters ?? []).map((p) => p.name);

test("every documented endpoint is a GET in the OpenAPI document", async () => {
  const s = await spec();
  for (const e of API_ENDPOINTS) expect(s.paths[e.path]?.get, e.path).toBeDefined();
});

test("every documented parameter is one the endpoint takes", async () => {
  const s = await spec();
  for (const e of API_ENDPOINTS) {
    const known = paramsOf(s, e.path);
    for (const [names] of e.params) {
      for (const name of names.split(", ")) expect(known, `${e.path} ${name}`).toContain(name);
    }
  }
});

test("each copyable request calls its own endpoint on the page's origin, with parameters the endpoint takes", async () => {
  const s = await spec();
  const origin = "https://funding.example";
  for (const e of API_ENDPOINTS) {
    const urls = [...e.example(origin).matchAll(/curl "([^"]+)"/g)].map((m) => new URL(m[1] as string));
    expect(urls.length, e.path).toBeGreaterThan(0);
    const pattern = new RegExp(`^${e.path.replace(/\{id\}/, "[^/]+")}$`);
    for (const url of urls) {
      expect(url.origin).toBe(origin);
      expect(url.pathname, e.path).toMatch(pattern);
      for (const key of url.searchParams.keys()) expect(paramsOf(s, e.path), `${e.path} ${key}`).toContain(key);
    }
  }
});
