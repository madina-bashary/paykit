import { createContext, useContext } from "react";
import type { AdapterContext } from "./adapters/types";
import type { ProviderStore } from "./store";
import type {
  Money,
  PayKitError,
  PaymentResult,
  Provider,
  ProvidersConfig,
} from "./types";

export type PayKitCallbacks = {
  onResult?: (result: PaymentResult) => void;
  onSuccess?: (result: PaymentResult) => void;
  onPending?: (result: PaymentResult) => void;
  onCancel?: (result: PaymentResult) => void;
  onError?: (error: PayKitError) => void;
};

export type PayKitContextValue = {
  providers: ProvidersConfig;
  /** Configured providers, in the canonical order. */
  configured: Provider[];
  amount: Money;
  adapter: AdapterContext;
  /** One state machine per provider, shared by every hook in the tree. */
  stores: Record<Provider, ProviderStore>;
};

export const PayKitContext = createContext<PayKitContextValue | null>(null);

export function usePayKit(): PayKitContextValue {
  const value = useContext(PayKitContext);
  if (!value) {
    throw new Error(
      "paykit: no <PayKitProvider> found above this component. Wrap your checkout in <PayKitProvider>.",
    );
  }
  return value;
}
