import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayButton } from "../pay-button";
import { PayKitProvider } from "../provider";
import type { ConfirmRequest, PayKitError, PaymentResult } from "../types";

const sdk = vi.hoisted(() => {
  const state: { options: Record<string, any> | null } = { options: null };
  const close = vi.fn();
  const renderButton = vi.fn(async (el: HTMLElement) => {
    el.innerHTML = "<button type='button'>PayPal</button>";
  });
  const Buttons = vi.fn((options: Record<string, any>) => {
    // isAvailable() probes with an empty options object; don't let it clobber
    // the real mount options.
    if (Object.keys(options).length > 0) state.options = options;
    return { render: renderButton, close, isEligible: () => true };
  });
  const loadScript = vi.fn(async () => ({ Buttons }));
  return { state, loadScript, Buttons, renderButton, close };
});

vi.mock("@paypal/paypal-js", () => ({ loadScript: sdk.loadScript }));

const AMOUNT = { value: 2499, currency: "USD" } as const;

function setup(overrides: Partial<Parameters<typeof PayKitProvider>[0]> = {}) {
  const onSuccess = vi.fn<(r: PaymentResult) => void>();
  const onError = vi.fn<(e: PayKitError) => void>();
  const onCancel = vi.fn<(r: PaymentResult) => void>();
  const onPending = vi.fn<(r: PaymentResult) => void>();
  const createSession = vi.fn(async () => ({ orderId: "5O190127TN364715T" }));
  const confirmSession = vi.fn(async (_req: ConfirmRequest) => ({
    status: "succeeded" as const,
    reference: "5O190127TN364715T",
    amount: AMOUNT,
    raw: { id: "5O190127TN364715T", status: "COMPLETED" },
  }));

  const view = render(
    <PayKitProvider
      providers={{ paypal: { clientId: "test-client-id" } }}
      amount={AMOUNT}
      createSession={createSession}
      confirmSession={confirmSession}
      onSuccess={onSuccess}
      onError={onError}
      onCancel={onCancel}
      onPending={onPending}
      {...overrides}
    >
      <PayButton provider="paypal" />
    </PayKitProvider>,
  );

  return { view, onSuccess, onError, onCancel, onPending, createSession, confirmSession };
}

async function mountedOptions() {
  await waitFor(() => expect(sdk.state.options).not.toBeNull());
  return sdk.state.options!;
}

describe("paypal adapter", () => {
  beforeEach(() => {
    sdk.state.options = null;
  });

  it("loads the SDK with the transaction currency and renders PayPal's own button", async () => {
    setup();
    await mountedOptions();

    expect(sdk.loadScript).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "test-client-id", currency: "USD", intent: "capture" }),
    );
    // PayPal's brand rules mean we give them a container, not a <button>.
    const container = document.querySelector('[data-paykit-provider="paypal"]');
    expect(container).not.toBeNull();
    expect(sdk.renderButton).toHaveBeenCalledWith(container);
  });

  it("asks the server for an order id in createOrder", async () => {
    const { createSession } = setup();
    const options = await mountedOptions();

    await expect(options["createOrder"]()).resolves.toBe("5O190127TN364715T");
    expect(createSession).toHaveBeenCalledWith("paypal");
  });

  it("captures on the server in onApprove and reports a normalised result", async () => {
    const { confirmSession, onSuccess } = setup();
    const options = await mountedOptions();

    await options["onApprove"]({ orderID: "5O190127TN364715T" });

    expect(confirmSession).toHaveBeenCalledWith({
      provider: "paypal",
      reference: "5O190127TN364715T",
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess.mock.calls[0]![0]).toMatchObject({
      provider: "paypal",
      status: "succeeded",
      reference: "5O190127TN364715T",
      amount: { value: 2499, currency: "USD" },
    });
  });

  it("does not report success when the capture comes back PENDING", async () => {
    const confirmSession = vi.fn(async () => ({
      status: "requires_action" as const,
      reference: "order_1",
      amount: AMOUNT,
    }));
    const { onSuccess, onPending } = setup({ confirmSession });
    const options = await mountedOptions();

    await options["onApprove"]({ orderID: "order_1" });

    await waitFor(() => expect(onPending).toHaveBeenCalledTimes(1));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("routes onCancel to a cancelled result", async () => {
    const { onCancel, onError } = setup();
    const options = await mountedOptions();

    options["onCancel"]({ orderID: "order_1" });

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onCancel.mock.calls[0]![0]).toMatchObject({
      provider: "paypal",
      status: "cancelled",
      reference: "order_1",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("re-routes a closed popup out of onError and into onCancel", async () => {
    // PayPal reports a dismissed window through onError. Passing that through
    // as an error trains people to ignore error toasts.
    const { onCancel, onError } = setup();
    const options = await mountedOptions();

    options["onError"](new Error("Detected popup close"));

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
  });

  it("maps an instrument decline to a declined PayKitError", async () => {
    const { onError } = setup();
    const options = await mountedOptions();

    options["onError"](new Error("INSTRUMENT_DECLINED"));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0].code).toBe("declined");
    expect(onError.mock.calls[0]![0].provider).toBe("paypal");
  });

  it("surfaces a capture failure as an error, not a silent success", async () => {
    const confirmSession = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    const { onError, onSuccess } = setup({ confirmSession });
    const options = await mountedOptions();

    await options["onApprove"]({ orderID: "order_1" });

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0].code).toBe("network");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("tears the button down on unmount", async () => {
    const { view } = setup();
    await mountedOptions();
    view.unmount();
    await waitFor(() => expect(sdk.close).toHaveBeenCalled());
  });
});
