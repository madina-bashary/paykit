# paykit — build spec

One React component API for Stripe, PayPal and Google Pay. Framework-agnostic
core, first-class Next.js adapter, Next.js demo app.

**npm name:** `paykit` (verified available)
**Repo:** `madina-bashary/paykit`
**License:** MIT

---

## 1. The problem it solves

Wiring up three payment providers means three SDKs, three loading lifecycles,
three error shapes, three success payloads, and three ways of being told the
user cancelled. Every team rebuilds the same adapter layer badly.

`paykit` gives you one provider config, one `<PayButton />`, one result type
and one error type — while still letting you drop to the raw SDK when needed.

**Non-goal:** replacing the provider SDKs. This wraps them, it doesn't reimplement
them. Subscriptions, saved cards and refunds are explicitly out of scope for v1.

---

## 2. Architecture

```
paykit/
├── packages/
│   └── paykit/
│       ├── src/
│       │   ├── index.ts              # client entry — "use client"
│       │   ├── provider.tsx          # <PayKitProvider>
│       │   ├── pay-button.tsx        # <PayButton> / <PayButtons>
│       │   ├── use-pay-button.ts     # headless hook
│       │   ├── types.ts              # PaymentResult, PayKitError, Money
│       │   ├── adapters/
│       │   │   ├── stripe.ts
│       │   │   ├── paypal.ts
│       │   │   └── google-pay.ts
│       │   └── next/
│       │       └── server.ts         # createPayKitHandler — server only
│       ├── package.json
│       └── tsup.config.ts
├── apps/
│   └── demo/                         # Next.js 16 App Router → Vercel
└── .github/workflows/ci.yml
```

Two export paths:

| Import | Environment | Contents |
| --- | --- | --- |
| `paykit` | client | Provider, components, hooks, types |
| `paykit/next/server` | server only | `createPayKitHandler` |

The split is what keeps secret keys out of the bundle. Enforce it with the
`server-only` package in `next/server.ts`, so a client import fails at build
time rather than leaking a key at runtime.

---

## 3. Public API

### Provider setup

```tsx
"use client";

import { PayKitProvider, PayButtons } from "paykit";

<PayKitProvider
  providers={{
    stripe:    { publishableKey: process.env.NEXT_PUBLIC_STRIPE_PK! },
    paypal:    { clientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID! },
    googlePay: { merchantId: "TEST_MERCHANT", environment: "TEST" },
  }}
  amount={{ value: 2499, currency: "USD" }}   // minor units, always
  createSession={async (provider) => {
    const res = await fetch(`/api/paykit/${provider}`, { method: "POST" });
    return res.json();                         // { clientSecret } | { orderId }
  }}
  onSuccess={(r) => router.push(`/orders/${r.reference}`)}
  onError={(e) => toast.error(e.message)}
  onCancel={() => toast("Payment cancelled")}
>
  <PayButtons />        {/* renders every configured provider */}
</PayKitProvider>
```

Individual placement when the layout demands it:

```tsx
<PayButton provider="stripe" />
<PayButton provider="paypal" size="lg" theme="dark" />
```

### The types that carry the whole value

```ts
export type Provider = "stripe" | "paypal" | "googlePay";

export type Money = {
  value: number;      // minor units — 2499 = $24.99. Never floats.
  currency: string;   // ISO 4217
};

export type PaymentResult = {
  provider: Provider;
  status: "succeeded" | "requires_action" | "failed" | "cancelled";
  reference: string;  // normalised id — PaymentIntent / Order / token ref
  amount: Money;
  raw: unknown;       // escape hatch to the provider's own payload
};

export class PayKitError extends Error {
  provider: Provider;
  code: "declined" | "network" | "cancelled" | "config" | "sdk" | "unknown";
  raw?: unknown;
}
```

Normalising `status` and `code` across three providers is the actual work of
this library. Document the mapping table in the README — it is the single most
useful page you can write, and it is what proves you have really shipped this.

### State machine

Every button moves through exactly one of these, exposed via `usePayment()`:

```
idle → loading_sdk → ready → processing → succeeded
                                        ↘ failed
                                        ↘ cancelled  (→ back to ready)
```

### Headless variant

```tsx
const { status, pay, error } = usePayButton("stripe");

<button onClick={pay} disabled={status !== "ready"}>
  {status === "processing" ? "Processing…" : "Pay with card"}
</button>
```

Ship this from day one. Headless is what makes a component library usable by
people whose design system does not match yours.

---

## 4. The Next.js server half

```ts
// apps/demo/app/api/paykit/[provider]/route.ts
import { createPayKitHandler } from "paykit/next/server";

export const { POST } = createPayKitHandler({
  stripe: { secretKey: process.env.STRIPE_SECRET_KEY! },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_SECRET!,
    environment: "sandbox",
  },
  // Amount resolved on the SERVER. Never trust a client-sent price.
  resolveAmount: async (req) => {
    const { cartId } = await req.json();
    return getCartTotal(cartId);
  },
});
```

`resolveAmount` is not optional and not a convenience — it is the security
model. Make that explicit in the docs.

---

## 5. Security rules (non-negotiable)

1. **Secret keys only in `paykit/next/server`.** Guard with `server-only`.
2. **The client never sets the price.** `resolveAmount` recomputes it server-side
   from a cart or product id. A client-supplied amount is a $0.01 checkout bug.
3. **Test/sandbox mode only** in the demo and the docs. No live keys, anywhere.
4. **Minor units everywhere.** No floats touching money.
5. **`.env.example` committed, `.env*` gitignored.** Verify before first push.
6. Webhooks are v2. Say so in the README rather than half-implementing them.

---

## 6. Tooling

| Concern | Choice |
| --- | --- |
| Monorepo | pnpm workspaces |
| Build | tsup 8.5 → ESM + CJS + `.d.ts` |
| Types | TypeScript (7.0.2 current) — `strict: true` |
| Tests | Vitest 5 + Testing Library, SDKs mocked |
| Versioning | Changesets |
| CI | GitHub Actions: typecheck, test, build on PR |
| Demo host | Vercel |

**Gotcha:** tsup strips the `"use client"` directive by default. Re-add it with
a banner or the directive is lost and the package breaks in the App Router —
exactly the bug your users would hit first.

Peer deps, not dependencies: `react >=18`, plus each provider SDK as an
**optional** peer so installing `paykit` doesn't drag in all three.

---

## 7. Build plan — four weekends

**Weekend 1 — one provider, end to end**
Monorepo scaffold. Stripe only. `PayKitProvider`, `PayButton`, the types,
the Next route handler. Demo deployed to Vercel and taking a sandbox payment.
*Done = a stranger can pay with a test card on a public URL.*

**Weekend 2 — the abstraction earns its name**
Add PayPal. This is where the unified `PaymentResult` and `PayKitError` get
tested for real — two providers is the minimum to prove an abstraction.
Write the status-mapping table.

**Weekend 3 — third provider + headless**
Google Pay. `usePayButton`. Vitest suite over the adapters with SDKs mocked.
CI green on every PR.

**Weekend 4 — ship it**
README with GIF, API reference, the mapping table, `.env.example`,
Changesets release, `npm publish`. Add repo topics:
`payments` `stripe` `paypal` `google-pay` `nextjs` `react` `typescript`.

Resist adding a fourth provider. Three proves the pattern; four is procrastination.

---

## 8. README outline

1. **GIF** — three buttons, a sandbox payment completing. First thing on the page.
2. One-sentence pitch + `npm i paykit`
3. **Live demo** link (above the fold)
4. 15-line quickstart — the Provider snippet above
5. The Next.js server handler
6. **Status & error mapping table** across the three providers
7. Headless usage
8. Security notes — `resolveAmount`, key placement
9. Scope: what this is not (no subscriptions, no refunds, webhooks in v2)
10. License

---

## 9. What "done" looks like

- `npm i paykit` works from a clean machine
- Live Vercel demo takes a sandbox payment on all three providers
- CI badge green
- README opens with a GIF and a demo link
- Topics set, description written
- Pinned on the profile
