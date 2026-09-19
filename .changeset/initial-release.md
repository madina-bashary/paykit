---
"paykit": minor
---

First release. Stripe, PayPal and Google Pay behind one `<PayButton />`, one
`PaymentResult`, one `PayKitError` and one state machine, plus a headless
`usePayButton` hook and a Next.js route handler that keeps secret keys and
price resolution on the server.
