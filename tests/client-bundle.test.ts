import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Modules a browser bundle must not reach: Zod and the core's root barrel, which re-exports every
 * extractor schema behind it. Client components take constants and pure helpers from
 * "@fireround/core/client" instead; a type-only import of the root is erased and stays allowed.
 */
const SERVER_ONLY = new Set(["zod", "@fireround/core"]);

/** The admin coverage panel validates plans with the same schemas the settings action stores, on an admin-only page. */
const ALLOWED = new Set(["components/settings/coverage-panel.tsx"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The specifiers a module imports or re-exports at runtime, type-only imports left out. */
function valueImports(file: string): string[] {
  const source = readFileSync(join(root, file), "utf8");
  const specifiers: string[] = [];
  for (const [, typeOnly, names, specifier] of source.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g,
  )) {
    if (typeOnly || /^\{(\s*type\s+\w+\s*,?)+\s*\}$/.test(names)) continue;
    specifiers.push(specifier);
  }
  for (const [, specifier] of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) specifiers.push(specifier);
  return specifiers;
}

function resolveLocal(specifier: string, from: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(root, specifier.slice(2))
    : specifier === "@fireround/core/client"
      ? join(root, "packages/core/src/client.ts")
      : specifier.startsWith(".")
        ? resolve(root, dirname(from), specifier)
        : null;
  if (!base) return null;
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const path = base + suffix;
    if (existsSync(path) && statSync(path).isFile()) return relative(root, path);
  }
  return null;
}

test("client components reach neither Zod nor the core's root barrel", () => {
  const isClient = (file: string) => /^["']use client["']/.test(readFileSync(join(root, file), "utf8"));
  const isServerAction = (file: string) => /^["']use server["']/.test(readFileSync(join(root, file), "utf8"));
  const clients = ["app", "components", "lib"].flatMap(sourceFiles).filter((file) => isClient(file) && !ALLOWED.has(file));
  expect(clients.length).toBeGreaterThan(20);

  const leaks: string[] = [];
  for (const client of clients) {
    const parent = new Map<string, string | null>([[client, null]]);
    const queue = [client];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (file !== client && isServerAction(file)) continue;
      for (const specifier of valueImports(file)) {
        if (SERVER_ONLY.has(specifier)) {
          const chain = [file];
          for (let at = parent.get(file); at; at = parent.get(at)) chain.unshift(at);
          leaks.push(`${chain.join(" -> ")} -> ${specifier}`);
          continue;
        }
        const next = resolveLocal(specifier, file);
        if (next && !parent.has(next)) {
          parent.set(next, file);
          queue.push(next);
        }
      }
    }
  }
  expect(leaks).toEqual([]);
});
