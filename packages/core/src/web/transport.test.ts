import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));

import { isPublicAddress, readPublicText, resolvePublicUrl } from "./transport.ts";

const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
function response(body: string | Buffer, headers: Record<string, string> = {}, status = 200) {
  mocks.request.mockImplementationOnce((_options: unknown, callback: (response: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const res = Object.assign(new PassThrough(), { headers, statusCode: status });
      callback(res);
      res.end(body);
    };
    return req;
  });
}
beforeEach(() => mocks.request.mockReset());

describe("public HTTP transport", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.1.2",
    "::1",
    "::ffff:7f00:1",
    "2001:db8::1",
    "2002:7f00:1::",
    "2001::1",
    "2001:0000:1234::1",
  ])("rejects private/reserved address %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
  test("rejects credentials, ports and mixed public/private DNS answers", async () => {
    await expect(resolvePublicUrl("http://user:pass@example.org/", resolver)).rejects.toThrow();
    await expect(resolvePublicUrl("http://example.org:8000/", resolver)).rejects.toThrow();
    await expect(
      resolvePublicUrl("http://example.org/", async () => [...(await resolver()), { address: "127.0.0.1", family: 4 }]),
    ).rejects.toThrow("Private");
    await expect(resolvePublicUrl("http://2130706433/", resolver)).rejects.toThrow("Private");
  });
  test("pins the checked address while preserving Host and TLS identity", async () => {
    response("<html>Source</html>", { "content-type": "text/html" });
    const result = await readPublicText("https://example.org/source?q=1", { resolve: resolver });
    expect(result.text).toContain("Source");
    expect(mocks.request.mock.calls[0]?.[0]).toMatchObject({
      hostname: "93.184.216.34",
      servername: "example.org",
      path: "/source?q=1",
      headers: { host: "example.org", "accept-encoding": "identity" },
    });
  });
  test("validates redirect destinations before opening another socket", async () => {
    response("", { location: "http://169.254.169.254/latest/meta-data/" }, 302);
    await expect(readPublicText("https://example.org/", { resolve: resolver })).rejects.toThrow("Private");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  test("enforces the byte limit on streaming and decompressed bodies", async () => {
    response("too much content");
    await expect(readPublicText("https://example.org/", { resolve: resolver, maxBytes: 4 })).rejects.toThrow("exceeds");
    response(gzipSync("a".repeat(10000)), { "content-encoding": "gzip" });
    await expect(readPublicText("https://example.org/", { resolve: resolver, maxBytes: 100 })).rejects.toThrow("exceeds");
  });
  test("private service allowance is confined to an explicitly configured origin", async () => {
    const local = async () => [{ address: "127.0.0.1", family: 4 }];
    expect((await resolvePublicUrl("http://localhost:8080/search", local, "http://localhost:8080")).address).toBe("127.0.0.1");
    await expect(resolvePublicUrl("http://localhost:9000/secret", local, "http://localhost:8080")).rejects.toThrow();
    await expect(resolvePublicUrl("http://internal.example/secret", local, "http://localhost:8080")).rejects.toThrow();
  });
});
