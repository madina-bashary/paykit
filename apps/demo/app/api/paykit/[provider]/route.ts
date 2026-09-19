import { createPayKitHandler } from "paykit/next/server";
import { getCartTotal } from "@/lib/cart";

// PayPal and Stripe are both called with the Node runtime's fetch here; the
// handler itself is edge-safe if you prefer.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { POST } = createPayKitHandler({
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_SECRET!,
    environment: "sandbox",
  },
  googlePay: {
    merchantId: process.env.NEXT_PUBLIC_GOOGLE_PAY_MERCHANT_ID ?? "TEST_MERCHANT",
    merchantName: process.env.NEXT_PUBLIC_GOOGLE_PAY_MERCHANT_NAME ?? "paykit demo",
    // Google Pay tokens are processed through the Stripe account above.
    gateway: {
      gateway: "stripe",
      "stripe:version": "2024-06-20",
      "stripe:publishableKey": process.env.NEXT_PUBLIC_STRIPE_PK!,
    },
  },

  // The whole security model in five lines: the client sends a cart id, the
  // server decides what that cart costs.
  resolveAmount: async (request) => {
    const { cartId } = (await request.json().catch(() => ({}))) as { cartId?: string };
    return getCartTotal(cartId ?? "demo-cart");
  },
});
