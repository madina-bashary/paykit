// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPayKitHandler } from "../next/handler";
import { __resetStripeClients } from "../next/stripe-server";
import { __resetPayPalTokenCache } from "../next/paypal-server";
import type { Money } from "../types";

const stripeMock = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class {
    paymentIntents = { create: stripeMock.create, retrieve: stripeMock.retrieve };
  },
}));

const CART_TOTAL: Money = { value: 2499, currency: "USD" };

function request(provider: string, body: Record<string, unknown> = {}) {
  return new Request(`http://localhost/api/paykit/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function handler(overrides: Record<string, unknown> = {}) {
  return createPayKitHandler({
    stripe: { secretKey: "sk_test_123" },
    paypal: {
      clientId: "id",
      clientSecret: "secret",
      environment: "sandbox",
      baseUrl: "https://paypal.test",
    },
    googlePay: {
      merchantId: "TEST_MERCHANT",
      merchantName: "paykit demo",
      gateway: { gateway: "stripe", "stripe:publishableKey": "pk_test_1" },
    },
    resolveAmount: async () => CART_TOTAL,
    ...overrides,
  } as Parameters<typeof createPayKitHandler>[0]);
}

beforeEach(() => {
  __resetStripeClients();
  __resetPayPalTokenCache();
  stripeMock.create.mockResolvedValue({
    id: "pi_1",
    client_secret: "pi_1_secret_x",
    status: "requires_payment_method",
    amount: 2499,
    currency: "usd",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPayKitHandler — wiring", () => {
  it("refuses to be constructed without resolveAmount", () => {
    expect(() =>
      createPayKitHandler({ stripe: { secretKey: "sk_test" } } as never),
    ).toThrow(/resolveAmount/);
  });

  it("reads the provider from the route params", async () => {
    const { POST } = handler();
    const response = await POST(request("stripe"), { params: Promise.resolve({ provider: "stripe" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ clientSecret: "pi_1_secret_x" });
  });

  it("falls back to the URL when there are no params", async () => {
    const { POST } = handler();
    const response = await POST(request("stripe"));
    expect(response.status).toBe(200);
  });

  it("rejects an unknown provider", async () => {
    const { POST } = handler();
    const response = await POST(request("bitcoin"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "config" } });
  });

  it("reports a provider that was never configured", async () => {
    const { POST } = handler({ paypal: undefined });
    const response = await POST(request("paypal"));
    const body = await response.json();
    expect(body.error.code).toBe("config");
    expect(body.error.message).toMatch(/not configured/);
  });
});

describe("createPayKitHandler — the client never sets the price", () => {
  it("ignores an amount in the request body", async () => {
    const { POST } = handler();
    await POST(request("stripe", { action: "create", amount: { value: 1, currency: "USD" } }));

    expect(stripeMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2499, currency: "usd" }),
    );
  });

  it("hands resolveAmount a readable copy of the request body", async () => {
    const resolveAmount = vi.fn(async (req: Request) => {
      const { cartId } = (await req.json()) as { cartId?: string };
      expect(cartId).toBe("cart_42");
      return CART_TOTAL;
    });
    const { POST } = handler({ resolveAmount });
    const response = await POST(request("stripe", { action: "create", cartId: "cart_42" }));

    expect(response.status).toBe(200);
    expect(resolveAmount).toHaveBeenCalledTimes(1);
  });

  it("refuses a resolveAmount that returns a float", async () => {
    const { POST } = handler({ resolveAmount: async () => ({ value: 24.99, currency: "USD" }) });
    const response = await POST(request("stripe"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "config" } });
    expect(stripeMock.create).not.toHaveBeenCalled();
  });
});

describe("createPayKitHandler — stripe", () => {
  it("creates a PaymentIntent and returns only the client secret", async () => {
    const { POST } = handler();
    const response = await POST(request("stripe", { action: "create" }));
    const body = await response.json();

    expect(body).toEqual({ clientSecret: "pi_1_secret_x", amount: CART_TOTAL });
    // The secret key must not appear anywhere in the response.
    expect(JSON.stringify(body)).not.toContain("sk_test");
  });

  it("maps a card decline to HTTP 402 with a declined code", async () => {
    stripeMock.create.mockRejectedValue({
      type: "StripeCardError",
      rawType: "card_error",
      message: "Your card was declined.",
    });
    const { POST } = handler();
    const response = await POST(request("stripe", { action: "create" }));

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: { code: "declined", provider: "stripe", message: "Your card was declined." },
    });
  });

  it("maps a bad key to a 500 config error", async () => {
    stripeMock.create.mockRejectedValue({
      type: "StripeAuthenticationError",
      message: "Invalid API Key provided: sk_test_***",
    });
    const { POST } = handler();
    const response = await POST(request("stripe", { action: "create" }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "config" } });
  });

  it("confirms by retrieving the intent", async () => {
    stripeMock.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 2499,
      currency: "usd",
    });
    const { POST } = handler();
    const response = await POST(request("stripe", { action: "confirm", reference: "pi_1" }));

    expect(stripeMock.retrieve).toHaveBeenCalledWith("pi_1");
    await expect(response.json()).resolves.toMatchObject({
      status: "succeeded",
      reference: "pi_1",
      amount: CART_TOTAL,
    });
  });
});

describe("createPayKitHandler — paypal", () => {
  function stubPayPal(responses: Array<[number, unknown]>) {
    const fetchMock = vi.fn(async () => {
      const next = responses.shift() ?? [500, {}];
      return new Response(JSON.stringify(next[1]), { status: next[0] as number });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("authenticates, then creates an order with a decimal amount", async () => {
    const fetchMock = stubPayPal([
      [200, { access_token: "A100", expires_in: 3600 }],
      [201, { id: "5O190127TN364715T", status: "CREATED" }],
    ]);
    const { POST } = handler();
    const response = await POST(request("paypal", { action: "create" }));

    await expect(response.json()).resolves.toEqual({
      orderId: "5O190127TN364715T",
      amount: CART_TOTAL,
    });

    const orderCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(orderCall[0]).toBe("https://paypal.test/v2/checkout/orders");
    // 2499 minor units must reach PayPal as "24.99", not 2499.
    expect(JSON.parse(orderCall[1].body as string)).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "24.99" } }],
    });
  });

  it("captures on confirm and trusts the capture's own status", async () => {
    stubPayPal([
      [200, { access_token: "A100", expires_in: 3600 }],
      [
        201,
        {
          id: "5O190127TN364715T",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  { id: "3C679366HH908993F", status: "PENDING", amount: { currency_code: "USD", value: "24.99" } },
                ],
              },
            },
          ],
        },
      ],
    ]);
    const { POST } = handler();
    const response = await POST(
      request("paypal", { action: "confirm", reference: "5O190127TN364715T" }),
    );

    // The order says COMPLETED; the capture inside it says PENDING. The
    // capture is the one telling the truth.
    await expect(response.json()).resolves.toMatchObject({
      status: "requires_action",
      reference: "5O190127TN364715T",
    });
  });

  it("maps an instrument decline to 402", async () => {
    stubPayPal([
      [200, { access_token: "A100", expires_in: 3600 }],
      [
        422,
        {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument was declined." }],
        },
      ],
    ]);
    const { POST } = handler();
    const response = await POST(request("paypal", { action: "confirm", reference: "o_1" }));

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "declined" } });
  });

  it("maps bad credentials to a config error", async () => {
    stubPayPal([[401, { error: "invalid_client" }]]);
    const { POST } = handler();
    const response = await POST(request("paypal", { action: "create" }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "config" } });
  });

  it("maps an unreachable PayPal to a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const { POST } = handler();
    const response = await POST(request("paypal", { action: "create" }));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "network" } });
  });
});

describe("createPayKitHandler — google pay", () => {
  it("returns the gateway parameters and the server's amount", async () => {
    const { POST } = handler();
    const response = await POST(request("googlePay", { action: "create" }));

    await expect(response.json()).resolves.toEqual({
      gateway: { gateway: "stripe", "stripe:publishableKey": "pk_test_1" },
      merchantId: "TEST_MERCHANT",
      merchantName: "paykit demo",
      amount: CART_TOTAL,
    });
  });

  it("charges the token through Stripe at the server's amount", async () => {
    stripeMock.create.mockResolvedValue({
      id: "pi_gp",
      status: "succeeded",
      amount: 2499,
      currency: "usd",
    });
    const { POST } = handler();
    const response = await POST(
      request("googlePay", { action: "confirm", token: JSON.stringify({ id: "tok_abc" }) }),
    );

    expect(stripeMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2499,
        confirm: true,
        payment_method_data: { type: "card", card: { token: "tok_abc" } },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      status: "succeeded",
      reference: "pi_gp",
    });
  });

  it("uses a custom process() when one is supplied", async () => {
    const process = vi.fn(async () => ({
      status: "succeeded" as const,
      reference: "adyen_1",
      amount: CART_TOTAL,
    }));
    const { POST } = handler({
      googlePay: {
        merchantId: "M",
        gateway: { gateway: "adyen" },
        process,
      },
    });
    const response = await POST(request("googlePay", { action: "confirm", token: "opaque" }));

    expect(process).toHaveBeenCalledWith("opaque", CART_TOTAL, expect.any(Request));
    await expect(response.json()).resolves.toMatchObject({ reference: "adyen_1" });
    expect(stripeMock.create).not.toHaveBeenCalled();
  });

  it("rejects a confirm with no token", async () => {
    const { POST } = handler();
    const response = await POST(request("googlePay", { action: "confirm" }));
    await expect(response.json()).resolves.toMatchObject({ error: { code: "config" } });
  });

  it("explains itself when the token is not a Stripe token", async () => {
    const { POST } = handler();
    const response = await POST(request("googlePay", { action: "confirm", token: "not-json" }));
    const body = await response.json();
    expect(body.error.provider).toBe("googlePay");
    expect(body.error.message).toMatch(/gateway/i);
  });
});
