import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readPublicText } from "@fireround/core/web/transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractWithScrapling } from "../lib/scrapling-extract";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("@fireround/core/web/transport", () => ({ readPublicText: vi.fn() }));

function worker() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}
async function reply(body: unknown) {
  const child = worker();
  const pending = extractWithScrapling("https://example.com", "h1", 2);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  child.stdout.write(typeof body === "string" ? body : JSON.stringify(body));
  child.emit("close", 0);
  return pending;
}

describe("offline Scrapling extraction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("SCRAPLING_PYTHON", "/opt/parser/bin/python");
    vi.mocked(readPublicText).mockResolvedValue({
      text: "<h1>Hello</h1>",
      url: "https://example.com/final",
      status: 200,
      contentType: "text/html; charset=utf-8",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("uses pinned fetch, isolated fixed worker, no environment secrets, and Node provenance", async () => {
    const result = await reply({ ok: true, items: ["Hello"], truncated: false, url: "https://forged.test" });
    expect(readPublicText).toHaveBeenCalledWith("https://example.com", { maxBytes: 2_000_000, timeoutMs: 15_000 });
    expect(spawn).toHaveBeenCalledWith("/opt/parser/bin/python", ["-I", expect.stringContaining("scripts/scrapling-extract.py")], {
      shell: false,
      env: { LANG: "C.UTF-8", NODE_ENV: "production" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(result).toMatchObject({ provider: "scrapling-local", url: "https://example.com/final", items: ["Hello"] });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["", "relative/python"])("requires an operator absolute Python path (%s)", async (path) => {
    vi.stubEnv("SCRAPLING_PYTHON", path);
    await expect(extractWithScrapling("https://example.com", "h1")).rejects.toThrow("absolute");
    expect(readPublicText).not.toHaveBeenCalled();
  });
  it.each([0, 26, 1.5, Number.NaN])("rejects invalid limit %s before fetch", async (limit) => {
    await expect(extractWithScrapling("https://example.com", "h1", limit)).rejects.toThrow("Limit");
    expect(readPublicText).not.toHaveBeenCalled();
  });
  it.each(["", " ", "x".repeat(501)])("rejects invalid selector before fetch", async (selector) => {
    await expect(extractWithScrapling("https://example.com", selector)).rejects.toThrow("selector");
    expect(readPublicText).not.toHaveBeenCalled();
  });
  it("preserves transport rejection without starting worker", async () => {
    vi.mocked(readPublicText).mockRejectedValue(new Error("Private or reserved address is not allowed"));
    await expect(extractWithScrapling("http://127.0.0.1", "h1")).rejects.toThrow("Private");
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([{ status: 403 }, { contentType: "application/json" }, { text: "x".repeat(2_000_001) }])(
    "rejects unsuitable responses",
    async (overrides) => {
      vi.mocked(readPublicText).mockResolvedValue({
        text: "hi",
        url: "https://example.com",
        status: 200,
        contentType: "text/html",
        ...overrides,
      });
      await expect(extractWithScrapling("https://example.com", "h1")).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it("reports missing package with setup instruction", async () => {
    await expect(reply({ ok: false, code: "missing_package" })).rejects.toThrow("requirements-scrapling.txt");
  });
  it("reports invalid CSS", async () => {
    await expect(reply({ ok: false, code: "invalid_selector" })).rejects.toThrow("CSS selector");
  });
  it.each([
    "not json",
    "null",
    { ok: true, items: [1], truncated: false },
    { ok: true, items: ["x".repeat(4001)], truncated: false },
    { ok: true, items: ["1", "2", "3"], truncated: false },
  ])("rejects malformed worker result", async (body) => {
    await expect(reply(body)).rejects.toThrow();
  });
  it("kills a hung worker at its deadline", async () => {
    vi.useFakeTimers();
    const child = worker();
    const pending = extractWithScrapling("https://example.com", "h1");
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("kills an overproducing worker", async () => {
    const child = worker();
    const pending = extractWithScrapling("https://example.com", "h1");
    const assertion = expect(pending).rejects.toThrow("output limit");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.write(Buffer.alloc(650_001));
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it.each(["error", "close", "stdin"])("reports worker %s failures safely", async (failure) => {
    const child = worker();
    const pending = extractWithScrapling("https://example.com", "h1");
    const assertion = expect(pending).rejects.toThrow(/Cannot start|worker failed|input failed/);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    if (failure === "error") child.emit("error", new Error("private diagnostics"));
    else if (failure === "close") child.emit("close", 1);
    else child.stdin.emit("error", new Error("private diagnostics"));
    await assertion;
  });
});
