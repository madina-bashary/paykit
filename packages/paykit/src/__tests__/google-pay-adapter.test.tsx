import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetGooglePayScriptCache } from "../adapters/google-pay";
import { PayButton } from "../pay-button";
import { PayKitProvider } from "../provider";
import type { ConfirmRequest, PayKitError, PaymentResult } from "../types";

const TOKEN = JSON.stringify({ id: "tok_1N3T00LkdIwHu7ix0s", object: "token" });
const AMOUNT = { value: 2499, currency: "USD" } as const;

const api = {
  ready: true,
  loadPaymentData: vi.fn(async () => ({
    paymentMethodData: { tokenizationData: { token: TOKEN } },
  })),
  lastRequest: null as Record<string, any> | null,
  lastButtonOptions: null as Record<string, any> | null,
};

class FakePaymentsClient {
  constructor(public options: { environment: string }) {}
  async isReadyToPay() {
    return { result: api.ready };
  }
  async loadPaymentData(request: Record<string, any>) {
    api.lastRequest = request;
    return api.loadPaymentData();
  }
  createButton(options: Record<string, any>) {
    api.lastButtonOptions = options;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Google Pay";
    button.addEventListener("click", () => void options["onClick"]());
    return button;
  }
}

function setup(overrides: Partial<Parameters<typeof PayKitProvider>[0]> = {}) {
  const onSuccess = vi.fn<(r: PaymentResult) => void>();
  const onError = vi.fn<(e: PayKitError) => void>();
  const onCancel = vi.fn<(r: PaymentResult) => void>();
  const createSession = vi.fn(async () => ({
    gateway: { gateway: "stripe", "stripe:publishableKey": "pk_test_1" },
    merchantId: "TEST_MERCHANT",
    amount: AMOUNT,
  }));
  const confirmSession = vi.fn(async (_req: ConfirmRequest) => ({
    status: "succeeded" as const,
    reference: "pi_from_google_pay",
    amount: AMOUNT,
  }));

  render(
    <PayKitProvider
      providers={{
        googlePay: { merchantId: "TEST_MERCHANT", environment: "TEST" },
      }}
      amount={AMOUNT}
      createSession={createSession}
      confirmSession={confirmSession}
      onSuccess={onSuccess}
      onError={onError}
      onCancel={onCancel}
      {...overrides}
    >
      <PayButton provider="googlePay" />
    </PayKitProvider>,
  );

  return { onSuccess, onError, onCancel, createSession, confirmSession };
}

const googleButton = () =>
  document.querySelector<HTMLButtonElement>('[data-paykit-provider="googlePay"] button');

describe("google pay adapter", () => {
  beforeEach(() => {
    __resetGooglePayScriptCache();
    api.ready = true;
    api.lastRequest = null;
    api.lastButtonOptions = null;
    api.loadPaymentData.mockResolvedValue({
      paymentMethodData: { tokenizationData: { token: TOKEN } },
    });
    (globalThis as any).google = { payments: { api: { PaymentsClient: FakePaymentsClient } } };
  });

  it("renders Google's own button once the API says the device can pay", async () => {
    setup();
    await waitFor(() => expect(googleButton()).not.toBeNull());
    expect(api.lastButtonOptions?.["buttonSizeMode"]).toBe("fill");
  });

  it("renders nothing at all when the device cannot pay", async () => {
    // A Google Pay button that can never work is worse than no button.
    api.ready = false;
    setup();
    await waitFor(() =>
      expect(document.querySelector('[data-paykit-provider="googlePay"]')).toBeNull(),
    );
  });

  it("shows the server's amount in the sheet and sends the token back to be charged", async () => {
    const { confirmSession, onSuccess } = setup();
    await waitFor(() => expect(googleButton()).not.toBeNull());
    googleButton()!.click();

    await waitFor(() => expect(api.lastRequest).not.toBeNull());
    expect(api.lastRequest!["transactionInfo"]).toMatchObject({
      totalPrice: "24.99",
      currencyCode: "USD",
      totalPriceStatus: "FINAL",
    });
    expect(api.lastRequest!["allowedPaymentMethods"][0].tokenizationSpecification).toEqual({
      type: "PAYMENT_GATEWAY",
      parameters: { gateway: "stripe", "stripe:publishableKey": "pk_test_1" },
    });

    await waitFor(() => expect(confirmSession).toHaveBeenCalled());
    expect(confirmSession).toHaveBeenCalledWith({ provider: "googlePay", token: TOKEN });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess.mock.calls[0]![0]).toMatchObject({
      provider: "googlePay",
      status: "succeeded",
      reference: "pi_from_google_pay",
    });
  });

  it("treats a dismissed sheet as cancelled, not as an error", async () => {
    api.loadPaymentData.mockRejectedValue({ statusCode: "CANCELED", statusMessage: "" });
    const { onCancel, onError } = setup();
    await waitFor(() => expect(googleButton()).not.toBeNull());
    googleButton()!.click();

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onCancel.mock.calls[0]![0].status).toBe("cancelled");
    expect(onError).not.toHaveBeenCalled();
  });

  it("maps a developer error to config", async () => {
    api.loadPaymentData.mockRejectedValue({
      statusCode: "DEVELOPER_ERROR",
      statusMessage: "merchantId missing",
    });
    const { onError } = setup();
    await waitFor(() => expect(googleButton()).not.toBeNull());
    googleButton()!.click();

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0].code).toBe("config");
  });

  it("errors rather than reporting success when no token comes back", async () => {
    api.loadPaymentData.mockResolvedValue({ paymentMethodData: {} } as any);
    const { onError, onSuccess } = setup();
    await waitFor(() => expect(googleButton()).not.toBeNull());
    googleButton()!.click();

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0].message).toMatch(/no payment token/i);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("rejects a bad environment value up front", async () => {
    const { onError } = setup({
      providers: { googlePay: { merchantId: "M", environment: "test" as never } },
    });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0].code).toBe("config");
  });
});
