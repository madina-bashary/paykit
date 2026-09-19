"use client";

import { useState, useSyncExternalStore } from "react";
import {
  PayButtons,
  PayKitError,
  PayKitProvider,
  usePayButton,
  type Money,
  type PaymentResult,
  type Provider,
} from "paykit";

const PROVIDERS: Provider[] = ["stripe", "paypal", "googlePay"];

const DARK = "(prefers-color-scheme: dark)";

/** Feeds `<PayButtons theme>` so the buttons have contrast in either scheme. */
function useColorScheme(): "light" | "dark" {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(DARK);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => (window.matchMedia(DARK).matches ? "dark" : "light"),
    () => "light",
  );
}

/** Renders the live state machine for one provider — the thing worth seeing. */
function StatePill({ provider }: { provider: Provider }) {
  const { status } = usePayButton(provider);
  return (
    <span className="state">
      <span className="dot" data-s={status} />
      {provider} · {status}
    </span>
  );
}

function Panel({
  result,
  error,
}: {
  result: PaymentResult | null;
  error: PayKitError | null;
}) {
  if (error) {
    return (
      <div className="result">
        <header>
          <span>PayKitError</span>
          <span className="tag" data-k="error">
            {error.code}
          </span>
        </header>
        <pre>
          {JSON.stringify(
            { provider: error.provider, code: error.code, message: error.message },
            null,
            2,
          )}
        </pre>
      </div>
    );
  }
  if (!result) return null;
  return (
    <div className="result">
      <header>
        <span>PaymentResult</span>
        <span className="tag" data-k={result.status}>
          {result.status}
        </span>
      </header>
      <pre>
        {JSON.stringify(
          {
            provider: result.provider,
            status: result.status,
            reference: result.reference,
            amount: result.amount,
          },
          null,
          2,
        )}
      </pre>
      {result.status === "succeeded" && (
        <p className="note" style={{ padding: "0 12px 12px" }}>
          <a href={`/orders/${encodeURIComponent(result.reference)}`}>View order →</a>
        </p>
      )}
    </div>
  );
}

export function Checkout({ cartId, amount }: { cartId: string; amount: Money }) {
  const theme = useColorScheme();
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [error, setError] = useState<PayKitError | null>(null);

  return (
    <PayKitProvider
      providers={{
        stripe: { publishableKey: process.env.NEXT_PUBLIC_STRIPE_PK! },
        paypal: { clientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID! },
        googlePay: {
          merchantId: process.env.NEXT_PUBLIC_GOOGLE_PAY_MERCHANT_ID ?? "TEST_MERCHANT",
          merchantName: process.env.NEXT_PUBLIC_GOOGLE_PAY_MERCHANT_NAME ?? "paykit demo",
          environment: "TEST",
        },
      }}
      amount={amount}
      endpoint="/api/paykit"
      metadata={{ cartId }}
      onSuccess={(r) => {
        setError(null);
        setResult(r);
      }}
      onPending={(r) => {
        setError(null);
        setResult(r);
      }}
      onCancel={(r) => {
        setError(null);
        setResult(r);
      }}
      onError={(e) => {
        setResult(null);
        setError(e);
      }}
    >
      <PayButtons theme={theme} />

      <div className="states">
        {PROVIDERS.map((p) => (
          <StatePill key={p} provider={p} />
        ))}
      </div>

      <Panel result={result} error={error} />

      <p className="note">
        Test card <code>4242 4242 4242 4242</code>, any future expiry and CVC. Declines:{" "}
        <code>4000 0000 0000 0002</code>. PayPal uses a sandbox buyer account. Google Pay only
        appears on devices that support it.
      </p>
    </PayKitProvider>
  );
}
