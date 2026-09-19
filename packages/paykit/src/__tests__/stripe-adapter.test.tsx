import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayButton } from "../pay-button";
import { PayKitProvider } from "../provider";
import type { PayKitError, PaymentResult } from "../types";

const sdk = vi.hoisted(() => {
  const confirmPayment = vi.fn();
  const elementMount = vi.fn();
  const elementsCreate = vi.fn(() => ({ mount: elementMount }));
  const elements = vi.fn(() => ({ create: elementsCreate }));
  const loadStripe = vi.fn(async () => ({ elements, confirmPayment }));
  return { confirmPayment, elementMount, elementsCreate, elements, loadStripe };
});

vi.mock("@stripe/stripe-js", () => ({ loadStripe: sdk.loadStripe }));

const AMOUNT = { value: 2499, currency: "USD" } as const;

function setup(
  overrides: Partial<Parameters<typeof PayKitProvider>[0]> = {},
  buttonProps: Partial<Parameters<typeof PayButton>[0]> = {},
) {
  const onSuccess = vi.fn<(r: PaymentResult) => void>();
  const onError = vi.fn<(e: PayKitError) => void>();
  const onCancel = vi.fn<(r: PaymentResult) => void>();
  const createSession = vi.fn(async () => ({ clientSecret: "pi_123_secret_abc" }));

  render(
    <PayKitProvider
      providers={{ stripe: { publishableKey: "pk_test_123" } }}
      amount={AMOUNT}
      createSession={createSession}
      onSuccess={onSuccess}
      onError={onError}
      onCancel={onCancel}
      {...overrides}
    >
      <PayButton provider="stripe" {...buttonProps} />
    </PayKitProvider>,
  );

  return { onSuccess, onError, onCancel, createSession };
}

const submitButton = () => document.querySelector<HTMLButtonElement>(".paykit-submit");
const modalError = () => document.querySelector<HTMLElement>(".paykit-error");

async function openCheckout(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole("button", { name: /Pay with card/ });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await waitFor(() => expect(submitButton()).not.toBeNull());
}

describe("stripe adapter", () => {
  beforeEach(() => {
    sdk.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_123", status: "succeeded", amount: 2499, currency: "usd" },
    });
  });

  it("loads Stripe.js once and lands on ready", async () => {
    setup();
    const button = await screen.findByRole("button", { name: /Pay with card/ });
    await waitFor(() => expect(button).toBeEnabled());
    expect(sdk.loadStripe).toHaveBeenCalledWith("pk_test_123", undefined);
    expect(button.dataset["paykitStatus"]).toBe("ready");
  });

  it("creates the session only when the customer commits, not on load", async () => {
    const user = userEvent.setup();
    const { createSession } = setup();
    await screen.findByRole("button", { name: /Pay with card/ });
    expect(createSession).not.toHaveBeenCalled();

    await openCheckout(user);
    expect(createSession).toHaveBeenCalledWith("stripe");
  });

  it("normalises a succeeded PaymentIntent into a PaymentResult", async () => {
    const user = userEvent.setup();
    const { onSuccess, onError } = setup();
    await openCheckout(user);
    await user.click(submitButton()!);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess.mock.calls[0]![0]).toMatchObject({
      provider: "stripe",
      status: "succeeded",
      reference: "pi_123",
      amount: { value: 2499, currency: "USD" },
    });
    // The provider's own payload survives on .raw
    expect(onSuccess.mock.calls[0]![0].raw).toMatchObject({ id: "pi_123" });
    expect(onError).not.toHaveBeenCalled();
    await waitFor(() => expect(submitButton()).toBeNull());
  });

  it("maps a processing intent to requires_action, never to success", async () => {
    const user = userEvent.setup();
    const onPending = vi.fn();
    sdk.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_slow", status: "processing", amount: 2499, currency: "usd" },
    });
    const { onSuccess } = setup({ onPending });
    await openCheckout(user);
    await user.click(submitButton()!);

    await waitFor(() => expect(onPending).toHaveBeenCalledTimes(1));
    expect(onPending.mock.calls[0]![0].status).toBe("requires_action");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("keeps a declined card in the sheet so the customer can try another", async () => {
    const user = userEvent.setup();
    sdk.confirmPayment.mockResolvedValue({
      error: { type: "card_error", code: "card_declined", message: "Your card was declined." },
    });
    const { onError, onSuccess } = setup();
    await openCheckout(user);
    await user.click(submitButton()!);

    await waitFor(() => expect(modalError()?.textContent).toBe("Your card was declined."));
    // A decline is a retry, not a crash: the sheet stays open and nothing blows up.
    expect(submitButton()).not.toBeNull();
    expect(submitButton()).toBeEnabled();
    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("surfaces a connection failure as a network PayKitError", async () => {
    const user = userEvent.setup();
    sdk.confirmPayment.mockResolvedValue({
      error: { type: "api_connection_error", message: "Network error" },
    });
    const { onError } = setup();
    await openCheckout(user);
    await user.click(submitButton()!);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const error = onError.mock.calls[0]![0];
    expect(error.code).toBe("network");
    expect(error.provider).toBe("stripe");
    expect(error.retryable).toBe(true);
  });

  it("treats a dismissed sheet as cancelled and re-arms the button", async () => {
    const user = userEvent.setup();
    const { onCancel, onError } = setup();
    await openCheckout(user);
    await user.click(document.querySelector<HTMLButtonElement>(".paykit-cancel")!);

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onCancel.mock.calls[0]![0].status).toBe("cancelled");
    expect(onError).not.toHaveBeenCalled();

    // cancelled → ready: the customer can start over.
    const button = screen.getByRole("button", { name: /Pay with card/ });
    await waitFor(() => expect(button.dataset["paykitStatus"]).toBe("ready"));
  });

  it("charges the server's amount, not the amount prop", async () => {
    const user = userEvent.setup();
    const createSession = vi.fn(async () => ({
      clientSecret: "pi_x_secret",
      amount: { value: 9900, currency: "USD" },
    }));
    const { onSuccess } = setup({ createSession });
    sdk.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_x", status: "succeeded", amount: 9900, currency: "usd" },
    });

    await openCheckout(user);
    expect(submitButton()!.textContent).toContain("99.00");
    await user.click(submitButton()!);
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onSuccess.mock.calls[0]![0].amount).toEqual({ value: 9900, currency: "USD" });
  });

  it("gives the payment sheet the button's theme", async () => {
    const user = userEvent.setup();
    setup({}, { theme: "dark" });
    await openCheckout(user);
    // A dark checkout with a blinding white card sheet is the detail people
    // notice first.
    expect(document.querySelector(".paykit-panel")?.getAttribute("data-theme")).toBe("dark");
  });

  it("refuses a secret key in the browser", async () => {
    const { onError } = setup({
      providers: { stripe: { publishableKey: "sk_test_oops" } },
    });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const error = onError.mock.calls[0]![0];
    expect(error.code).toBe("config");
    expect(error.message).toMatch(/SECRET key/);
    expect(sdk.loadStripe).not.toHaveBeenCalled();
  });

  it("rejects a session that is not a Stripe session", async () => {
    const user = userEvent.setup();
    const { onError } = setup({
      createSession: vi.fn(async () => ({ orderId: "wrong-provider" })),
    });
    const button = await screen.findByRole("button", { name: /Pay with card/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0].code).toBe("config");
    expect(onError.mock.calls[0]![0].message).toMatch(/clientSecret/);
  });
});
