<!--
  TODO before publishing: record the three buttons taking a sandbox payment,
  save it as docs/demo.gif, and uncomment the line below. It belongs here — the
  first thing on the page, above everything else.

  ![paykit](docs/demo.gif)
-->

# paykit

**One React component API for Stripe, PayPal and Google Pay.** One provider
config, one `<PayButton />`, one result type, one error type — and the raw SDK
still there when you need it.

[![CI](https://github.com/madina-bashary/paykit/actions/workflows/ci.yml/badge.svg)](https://github.com/madina-bashary/paykit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/paykit.svg)](https://www.npmjs.com/package/paykit)
[![license](https://img.shields.io/npm/l/paykit.svg)](./LICENSE)

```bash
npm i paykit
```

**[Live demo →](https://paykit-demo.vercel.app)** · sandbox keys, real test cards.

---

## Why

Wiring up three payment providers means three SDKs, three loading lifecycles,
three error shapes, three success payloads, and three different ways of being
told the customer changed their mind. Every team rebuilds that adapter layer,
and every team gets the edge cases slightly wrong — usually the one where
Stripe says `processing` and the app ships the order anyway.

`paykit` is that layer, written once.

**What it is not:** a reimplementation of the provider SDKs. It wraps them.
Subscriptions, saved cards, refunds and webhooks are out of scope for v1.

---

## Quickstart

```tsx
"use client";

import { PayKitProvider, PayButtons } from "paykit";

export function Checkout({ cartId }: { cartId: string }) {
  const router = useRouter();

  return (
    <PayKitProvider
      providers={{
        stripe:    { publishableKey: process.env.NEXT_PUBLIC_STRIPE_PK! },
        paypal:    { clientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID! },
        googlePay: { merchantId: "TEST_MERCHANT", environment: "TEST" },
      }}
      amount={{ value: 2499, currency: "USD" }}   // minor units, always
      endpoint="/api/paykit"                      // pairs with the handler below
      metadata={{ cartId }}                       // the server prices this id
      onSuccess={(r) => router.push(`/orders/${r.reference}`)}
      onError={(e) => toast.error(e.message)}
      onCancel={() => toast("Payment cancelled")}
    >
      <PayButtons />   {/* every configured provider */}
    </PayKitProvider>
  );
}
```

Individual placement when the layout demands it:

```tsx
<PayButton provider="stripe" />
<PayButton provider="paypal" size="lg" theme="dark" />
```

Prefer to call your own endpoints? Replace `endpoint` with `createSession` and
`confirmSession`:

```tsx
createSession={async (provider) => {
  const res = await fetch(`/api/paykit/${provider}`, { method: "POST" });
  return res.json();            // { clientSecret } | { orderId } | { gateway }
}}
```

---

## The server half

```ts
// app/api/paykit/[provider]/route.ts
import { createPayKitHandler } from "paykit/next/server";

export const { POST } = createPayKitHandler({
  stripe: { secretKey: process.env.STRIPE_SECRET_KEY! },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_SECRET!,
    environment: "sandbox",
  },
  googlePay: {
    merchantId: "TEST_MERCHANT",
    // Google Pay tokens are processed through the Stripe account above.
    gateway: {
      gateway: "stripe",
      "stripe:version": "2024-06-20",
      "stripe:publishableKey": process.env.NEXT_PUBLIC_STRIPE_PK!,
    },
  },

  // Amount resolved on the SERVER. Never trust a client-sent price.
  resolveAmount: async (req) => {
    const { cartId } = await req.json();
    return getCartTotal(cartId);
  },
});
```

One route, two actions:

| Body | Does |
| --- | --- |
| `{ action: "create" }` | Creates the PaymentIntent / PayPal Order, or returns the Google Pay gateway parameters. |
| `{ action: "confirm", reference?, token? }` | Captures the PayPal order, processes the Google Pay token, or re-reads the PaymentIntent. |

`resolveAmount` is **not optional and not a convenience**. It is the security
model: the browser tells you *what* the customer is buying, the server decides
*what it costs*. A handler that trusts a client-sent amount is a $0.01 checkout
waiting to be found.

---

## Status & error mapping

This table is the library. Everything else is plumbing.

### `PaymentResult.status`

| paykit | Stripe `PaymentIntent.status` | PayPal Order / Capture status | Google Pay |
| --- | --- | --- | --- |
| `succeeded` | `succeeded` | `COMPLETED`, `REFUNDED`, `PARTIALLY_REFUNDED` | whatever the PSP returns for the token |
| `requires_action` | `processing`, `requires_action`, `requires_confirmation`, `requires_capture` | `CREATED`, `SAVED`, `APPROVED`, `PENDING`, `PAYER_ACTION_REQUIRED` | ″ |
| `failed` | `requires_payment_method` (after a confirm attempt), anything unmapped | `DECLINED`, `FAILED`, anything unmapped | ″ |
| `cancelled` | `canceled`, or the sheet dismissed | `VOIDED`, `onCancel` | sheet dismissed |

Two rows worth staring at:

- **Stripe `processing` is not success.** Bank debits sit there for days. It
  maps to `requires_action`, which is paykit's "not final — resolve this with a
  webhook" status. Do not ship the order on it.
- **PayPal `APPROVED` is not success either.** The customer finished in the
  PayPal window, but no money moves until you capture. That is what
  `{ action: "confirm" }` does, on your server.

Google Pay has no status of its own. It hands you an encrypted token and stops;
the outcome comes from the PSP that processes it. With the default Stripe
gateway, the Stripe column applies.

### `PayKitError.code`

| paykit | Stripe | PayPal | Google Pay |
| --- | --- | --- | --- |
| `declined` | `card_error`, `validation_error` | `INSTRUMENT_DECLINED`, `422` with an issue | `BUYER_ACCOUNT_ERROR` |
| `network` | `api_connection_error`, failed fetch | failed fetch, `Failed to fetch`, timeouts | — |
| `cancelled` | modal dismissed | `Detected popup close`, `Window closed` | `CANCELED` |
| `config` | `invalid_request_error`, `authentication_error` | `invalid client-id`, `CURRENCY_NOT_SUPPORTED`, `401`/`403`, `400` | `DEVELOPER_ERROR`, `MERCHANT_ACCOUNT_ERROR` |
| `sdk` | `api_error`, `rate_limit_error`, `idempotency_error` | script load failure, `5xx` | `INTERNAL_ERROR`, `pay.js` load failure |
| `unknown` | anything unmapped | anything unmapped | anything unmapped |

`error.retryable` is `true` for `network` and `declined`.

Two normalisations you get for free, because both providers report a
cancellation through their error channel and passing that through as an error
teaches people to ignore your error toasts:

- PayPal's closed popup arrives in `onError` → paykit reports `onCancel`.
- Google Pay's `CANCELED` rejects `loadPaymentData` → paykit reports `onCancel`.

---

## The state machine

Every button moves through exactly one of these, exposed by `usePayButton()`:

```
idle → loading_sdk → ready → processing → succeeded
                                        ↘ failed
                                        ↘ cancelled  (→ back to ready)
```

Plus one state outside that line: **`unavailable`**, for a provider this device
can never use — Google Pay on an unsupported browser, or a provider you did not
configure. `<PayButton />` renders `null` for it, because a button that cannot
work is worse than no button at all.

A `requires_action` result holds the button in `processing`. The money is
neither taken nor refused, and a button that says "Paid" there would be lying.

---

## Headless

```tsx
const { status, pay, error } = usePayButton("stripe");

<button onClick={pay} disabled={status !== "ready"}>
  {status === "processing" ? "Processing…" : "Pay with card"}
</button>
```

One thing to get right: `failed` and `cancelled` are both retryable — calling
`pay()` again from either works. `disabled={status !== "ready"}` leaves the
button dead after a decline, so gate on the states that actually block instead:

```tsx
const blocked = status === "idle" || status === "loading_sdk" || status === "processing";

<button onClick={pay} disabled={blocked}>
  {status === "failed" ? "Try again" : "Pay with card"}
</button>
```

`reset()` clears the last error and result and returns the button to `ready`.

**One honest caveat.** Providers come in two shapes, and pretending otherwise
is the lie that would break this abstraction:

| `mode` | Providers | You render |
| --- | --- | --- |
| `imperative` | Stripe | your own button, wired to `pay()` |
| `mounted` | PayPal, Google Pay | `<div ref={containerRef} />` — the provider draws its own button, because their brand rules require it |

```tsx
const { mode, containerRef, pay, status } = usePayButton("paypal");

return mode === "mounted"
  ? <div ref={containerRef} />
  : <button onClick={pay} disabled={status !== "ready"}>Pay</button>;
```

`<PayButton />` handles both for you. It is a thin renderer over this hook —
that is the point: a component library whose design system does not match
yours is a component library you cannot use.

---

## Security notes

1. **Secret keys only in `paykit/next/server`.** That entry imports
   `server-only`, so pulling it into a Client Component fails the build instead
   of leaking a key at runtime.
2. **The client never sets the price.** `resolveAmount` recomputes it from your
   own data. paykit also refuses a publishable key that starts with `sk_`, and
   a secret key that starts with `pk_`.
3. **Minor units everywhere.** `2499` is `$24.99`. Floats are rejected at the
   boundary with an error that tells you what you probably meant. Currencies
   with a non-2 exponent (JPY, KWD) are handled — `2499 JPY` is ¥2499, and
   getting that wrong is a 100× charge.
4. **Error messages are filtered.** Declines and network failures reach the
   browser verbatim; config and SDK errors are logged server-side and replaced
   with a generic message in production.
5. **`.env.example` is committed; `.env*` is gitignored.**

---

## Scope

| | |
| --- | --- |
| **In v1** | One-off payments across Stripe, PayPal and Google Pay. Unified result, error and state machine. Headless hook. Next.js route handler. |
| **Not in v1** | Subscriptions, saved cards, refunds, Apple Pay. |
| **v2** | Webhooks. They are the correct way to resolve `requires_action`, and half-implementing them would be worse than saying this out loud. |

Until then: treat `requires_action` as "not paid", and reconcile from your
provider dashboard or your own webhook route.

---

## Running it locally

This is a **pnpm workspace**. `npm install` and `yarn` will not work here — the
demo depends on `paykit` through the `workspace:*` protocol, and the lockfile is
pnpm's. If you do not have pnpm, Node ships with corepack, which installs the
exact pinned version:

```bash
corepack enable pnpm
```

Then, in order:

```bash
pnpm install
pnpm --filter paykit build     # REQUIRED before the demo — it imports dist/
pnpm --filter demo dev         # http://localhost:3000
```

The build step is not optional. The demo imports `paykit` the way any consumer
would, so without `dist/` the dev server fails to resolve it. If you are editing
the library, run `pnpm --filter paykit dev` in a second terminal to rebuild on
save.

For a demo that can actually take a payment, copy the env file and fill in
**test** credentials:

```bash
cp apps/demo/.env.example apps/demo/.env.local
```

Stripe test keys are at
[dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys);
PayPal sandbox credentials at
[developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox).
Without them the buttons still render and the state machine still works — the
request just fails when it reaches the provider.

Other scripts:

```bash
pnpm --filter paykit test      # vitest, SDKs mocked
pnpm -r typecheck
pnpm --filter demo build
```

## License

MIT © Madina Bashary
