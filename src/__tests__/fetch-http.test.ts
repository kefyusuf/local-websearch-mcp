import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";

type FetchViaHttpResult = { html: string; buffer: Buffer } | null;
type FetchViaHttpMethod = (url: string) => Promise<FetchViaHttpResult>;

function invokeFetchViaHttp(url: string): Promise<FetchViaHttpResult> {
  const serverPrototype = WebSearchServer.prototype as unknown as { fetchViaHttp: FetchViaHttpMethod };
  return serverPrototype.fetchViaHttp.call({}, url);
}

describe("fetchViaHttp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null for non-HTML responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    await expect(invokeFetchViaHttp("https://example.com/data")).resolves.toBeNull();
  });

  it("returns null for failed responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<html><body>failure</body></html>", {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    await expect(invokeFetchViaHttp("https://example.com/failure")).resolves.toBeNull();
  });

  it("returns null for very short html responses", async () => {
    const html = `<html><body>${"a".repeat(450)}</body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    await expect(invokeFetchViaHttp("https://example.com/short")).resolves.toBeNull();
  });

  it("returns html and buffer for valid html responses", async () => {
    const html = `<html><head><title>Test</title></head><body>${"content ".repeat(80)}</body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    const result = await invokeFetchViaHttp("https://example.com/article");

    expect(result).not.toBeNull();
    expect(result?.html).toBe(html);
    expect(result?.buffer.equals(Buffer.from(html))).toBe(true);
  });
});
