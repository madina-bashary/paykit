import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { PayButton, PayButtons } from "../pay-button";
import { PayKitProvider } from "../provider";
import { usePayButton } from "../use-pay-button";

const sdk = vi.hoisted(() => {
  const confirmPayment = vi.fn(async () => ({
    paymentIntent: { id: "pi_1", status: "succeeded", amount: 2499, currency: "usd" },
  }));
  const loadStripe = vi.fn(async () => ({
    elements: () => ({ create: () => ({ mount: vi.fn() }) }),
    confirmPayment,
  }));
  const Buttons = vi.fn(() => ({
    render: vi.fn(async (el: HTMLElement) => {
      el.innerHTML = "<span>PayPal</span>";
    }),
    close: vi.fn(),
    isEligible: () => true,
  }));
  const loadScript = vi.fn(async () => ({ Buttons }));
  return { loadStripe, loadScript, confirmPayment };
});

vi.mock("@stripe/stripe-js", () => ({ loadStripe: sdk.loadStripe }));
vi.mock("@paypal/paypal-js", () => ({ loadScript: sdk.loadScript }));

const AMOUNT = { value: 2499, currency: "USD" } as const;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <PayKitProvider
      providers={{
        stripe: { publishableKey: "pk_test_1" },
        paypal: { clientId: "client_1" },
      }}
      amount={AMOUNT}
      createSession={async () => ({ clientSecret: "cs_1" })}
    >
      {children}
    </PayKitProvider>
  );
}

describe("<PayButtons />", () => {
  it("renders one button per configured provider, in a stable order", async () => {
    render(
      <Wrapper>
        <PayButtons />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-paykit-provider="stripe"]')).not.toBeNull();
      expect(document.querySelector('[data-paykit-provider="paypal"]')).not.toBeNull();
    });
    // googlePay was never configured, so it is never rendered.
    expect(document.querySelector('[data-paykit-provider="googlePay"]')).toBeNull();

    const rendered = [...document.querySelectorAll("[data-paykit-provider]")].map(
      (el) => (el as HTMLElement).dataset["paykitProvider"],
    );
    expect(rendered).toEqual(["stripe", "paypal"]);
  });

  it("honours `only`", async () => {
    render(
      <Wrapper>
        <PayButtons only={["paypal"]} />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(document.querySelector('[data-paykit-provider="paypal"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-paykit-provider="stripe"]')).toBeNull();
  });
});

describe("<PayButton />", () => {
  it("renders a real <button> for Stripe and a container for PayPal", async () => {
    render(
      <Wrapper>
        <PayButton provider="stripe" />
        <PayButton provider="paypal" />
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Pay with card/ })).toBeEnabled(),
    );
    // PayPal draws its own button inside a div; we never fake one.
    const paypal = document.querySelector('[data-paykit-provider="paypal"]')!;
    expect(paypal.tagName).toBe("DIV");
  });

  it("stays disabled until the SDK is ready", async () => {
    render(
      <Wrapper>
        <PayButton provider="stripe" />
      </Wrapper>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("hands the whole hook to a render prop", async () => {
    render(
      <Wrapper>
        <PayButton provider="stripe">
          {({ status, mode, amount }) => (
            <output>
              {mode}:{status}:{amount.value}
            </output>
          )}
        </PayButton>
      </Wrapper>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("imperative:ready:2499"),
    );
  });
});

describe("usePayButton", () => {
  it("reports the mode so headless callers know what to render", async () => {
    function Probe() {
      const stripe = usePayButton("stripe");
      const paypal = usePayButton("paypal");
      return <output>{`${stripe.mode}/${paypal.mode}`}</output>;
    }
    render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    );
    expect(screen.getByRole("status").textContent).toBe("imperative/mounted");
  });

  it("refuses pay() on a provider that draws its own button", async () => {
    let hook: ReturnType<typeof usePayButton> | null = null;
    function Probe() {
      hook = usePayButton("paypal");
      return <output>{hook.status}</output>;
    }
    render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ready"));

    await expect(hook!.pay()).rejects.toMatchObject({
      code: "config",
      message: expect.stringContaining("containerRef"),
    });
  });

  it("marks an unconfigured provider unavailable instead of throwing", async () => {
    function Probe() {
      const { status, isAvailable } = usePayButton("googlePay");
      return <output>{`${status}:${isAvailable}`}</output>;
    }
    render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("unavailable:false"),
    );
    // …and <PayButton> renders nothing for it.
    expect(document.querySelector('[data-paykit-provider="googlePay"]')).toBeNull();
  });
});

describe("shared provider state", () => {
  it("gives every hook for the same provider one state machine", async () => {
    // Two components asking about Stripe must agree. Independent state here
    // meant a status indicator could read "ready" while the button next to it
    // read "failed".
    function Probe({ id }: { id: string }) {
      const { status } = usePayButton("stripe");
      return <output aria-label={id}>{status}</output>;
    }
    render(
      <Wrapper>
        <Probe id="a" />
        <Probe id="b" />
        <PayButton provider="stripe" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByLabelText("a").textContent).toBe("ready"));
    expect(screen.getByLabelText("b").textContent).toBe("ready");
    expect(
      (document.querySelector('button[data-paykit-provider="stripe"]') as HTMLElement).dataset[
        "paykitStatus"
      ],
    ).toBe("ready");
  });

  it("loads each SDK once no matter how many components ask", async () => {
    function Probe() {
      usePayButton("stripe");
      usePayButton("paypal");
      return null;
    }
    render(
      <Wrapper>
        <Probe />
        <Probe />
        <PayButtons />
      </Wrapper>,
    );

    await waitFor(() =>
      expect(document.querySelector('[data-paykit-provider="paypal"]')).not.toBeNull(),
    );
    expect(sdk.loadStripe).toHaveBeenCalledTimes(1);
    expect(sdk.loadScript).toHaveBeenCalledTimes(1);
  });

  it("keeps separate state per provider", async () => {
    function Probe() {
      const stripe = usePayButton("stripe");
      const googlePay = usePayButton("googlePay");
      return <output>{`${stripe.status}/${googlePay.status}`}</output>;
    }
    render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("ready/unavailable"),
    );
  });
});

describe("<PayKitProvider />", () => {
  it("fails loudly when a component is used outside it", () => {
    function Orphan() {
      usePayButton("stripe");
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow(/PayKitProvider/);
    spy.mockRestore();
  });

  it("rejects an amount in major units before anything loads", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <PayKitProvider
          providers={{ stripe: { publishableKey: "pk_test_1" } }}
          amount={{ value: 24.99, currency: "USD" }}
          createSession={async () => ({ clientSecret: "cs" })}
        >
          <PayButton provider="stripe" />
        </PayKitProvider>,
      ),
    ).toThrow(/minor units/);
    spy.mockRestore();
  });
});
