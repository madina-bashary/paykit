# docs/

## demo.gif — still to record

The README's first line is reserved for it. Record it once the demo is
deployed with sandbox credentials:

1. `cp apps/demo/.env.example apps/demo/.env.local` and fill in test keys.
2. `pnpm --filter paykit build && pnpm --filter demo dev`
3. Record `http://localhost:3000` at roughly 900×700: the three buttons
   loading, a Stripe payment with `4242 4242 4242 4242`, and the
   `PaymentResult` panel appearing. Fifteen seconds is plenty.
4. Save it here as `demo.gif` and uncomment the image at the top of the
   root `README.md`.

Keep it under ~3 MB or GitHub will be slow to render it.
