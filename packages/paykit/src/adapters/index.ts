import type { Provider } from "../types";
import { googlePayAdapter } from "./google-pay";
import { paypalAdapter } from "./paypal";
import { stripeAdapter } from "./stripe";
import type { AdapterDefinition } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ADAPTERS: Record<Provider, AdapterDefinition<any>> = {
  stripe: stripeAdapter,
  paypal: paypalAdapter,
  googlePay: googlePayAdapter,
};

export function getAdapter(provider: Provider): AdapterDefinition<any> {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`paykit: unknown provider "${String(provider)}"`);
  }
  return adapter;
}

export { googlePayAdapter, paypalAdapter, stripeAdapter };
export type * from "./types";
