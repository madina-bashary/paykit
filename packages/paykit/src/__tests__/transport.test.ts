// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchTransport } from "../transport";
import { PayKitError } from "../types";

afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("createFetchTransport", () => {
  it("posts create to /endpoint/provider with the metadata merged in", async () => {
    const fetchMock = stub(200, { clientSecret: "cs_1" });
    const transport = createFetchTransport("/api/paykit/", { cartId: "cart_1" });

    await expect(transport.createSession("stripe")).resolves.toEqual({ clientSecret: "cs_1" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/paykit/stripe");
    expect(JSON.parse(init.body as string)).toEqual({ action: "create", cartId: "cart_1" });
  });

  it("posts confirm with the reference and token", async () => {
    const fetchMock = stub(200, { status: "succeeded", reference: "o_1" });
    const transport = createFetchTransport("/api/paykit");

    await transport.confirmSession({ provider: "paypal", reference: "o_1" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "confirm", reference: "o_1" });
  });

  it("carries the server's error code across the wire", async () => {
    // The point of the { error: { code } } envelope: a decline stays a decline
    // instead of collapsing into "HTTP 402".
    stub(402, { error: { code: "declined", message: "Your card was declined." } });
    const transport = createFetchTransport("/api/paykit");

    await expect(transport.createSession("stripe")).rejects.toMatchObject({
      code: "declined",
      provider: "stripe",
      message: "Your card was declined.",
    });
  });

  it("falls back to unknown for an unrecognised code", async () => {
    stub(500, { error: { code: "banana", message: "?" } });
    const transport = createFetchTransport("/api/paykit");
    await expect(transport.createSession("stripe")).rejects.toMatchObject({ code: "unknown" });
  });

  it("maps an unreachable endpoint to a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const transport = createFetchTransport("/api/paykit");

    const error = await transport.createSession("paypal").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayKitError);
    expect((error as PayKitError).code).toBe("network");
    expect((error as PayKitError).retryable).toBe(true);
  });
});
