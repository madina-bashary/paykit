"use client";

import { type ReactNode, useMemo, useRef } from "react";
import { getAdapter } from "./adapters";
import type { AdapterContext } from "./adapters/types";
import { PayKitContext, type PayKitCallbacks, type PayKitContextValue } from "./context";
import { assertMoney, normalizeMoney } from "./money";
import { ProviderStore } from "./store";
import { createFetchTransport } from "./transport";
import {
  type ConfirmRequest,
  type ConfirmResponse,
  type Money,
  PayKitError,
  type PaymentResult,
  PROVIDERS,
  type PaySession,
  type Provider,
  type ProvidersConfig,
} from "./types";

export type PayKitProviderProps = {
  /** Only the providers you list here are loaded, and only they render buttons. */
  providers: ProvidersConfig;
  /**
   * Display amount, in minor units. The server's `resolveAmount` is what
   * actually gets charged — this is what the customer sees before they commit.
   */
  amount: Money;

  /**
   * Shorthand for the `createPayKitHandler` convention: POSTs to
   * `${endpoint}/${provider}`. Supply this *or* `createSession`.
   */
  endpoint?: string;
  /** Merged into every request body — this is where a cart id belongs. */
  metadata?: Record<string, unknown>;

  /** Full control over the session call. Takes precedence over `endpoint`. */
  createSession?: (provider: Provider) => Promise<PaySession>;
  /** Required by PayPal and Google Pay, which need a second server round-trip. */
  confirmSession?: (request: ConfirmRequest) => Promise<ConfirmResponse>;

  /** Every terminal outcome, before the status-specific callbacks. */
  onResult?: (result: PaymentResult) => void;
  /** `status === "succeeded"` only. Safe to fulfil the order here. */
  onSuccess?: (result: PaymentResult) => void;
  /** `status === "requires_action"`. NOT paid yet — wait for the webhook. */
  onPending?: (result: PaymentResult) => void;
  /** `status === "cancelled"`. The customer backed out; not an error. */
  onCancel?: (result: PaymentResult) => void;
  /** Thrown errors, plus `status === "failed"` mapped to a `declined` error. */
  onError?: (error: PayKitError) => void;

  children: ReactNode;
};

export function PayKitProvider({
  providers,
  amount,
  endpoint,
  metadata,
  createSession,
  confirmSession,
  onResult,
  onSuccess,
  onPending,
  onCancel,
  onError,
  children,
}: PayKitProviderProps) {
  assertMoney(amount, "stripe");

  // Callbacks change identity on every render of the host component. Reading
  // them through a ref keeps the adapter context stable, so a parent re-render
  // never tears down a loaded SDK.
  const callbacks = useRef<PayKitCallbacks>({});
  callbacks.current = { onResult, onSuccess, onPending, onCancel, onError };

  const stableAmount = useMemo(
    () => normalizeMoney(amount),
    [amount.value, amount.currency],
  );
  const amountRef = useRef(stableAmount);
  amountRef.current = stableAmount;

  const metadataRef = useRef(metadata);
  metadataRef.current = metadata;

  const createSessionRef = useRef(createSession);
  createSessionRef.current = createSession;
  const confirmSessionRef = useRef(confirmSession);
  confirmSessionRef.current = confirmSession;

  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;

  const adapter = useMemo<AdapterContext>(
    () => ({
      // A getter, not a snapshot: adapters are created once and must still see
      // the current amount if the cart changes underneath them.
      get amount() {
        return amountRef.current;
      },

      async createSession(provider: Provider): Promise<PaySession> {
        const custom = createSessionRef.current;
        if (custom) return custom(provider);
        const base = endpointRef.current;
        if (!base) {
          throw new PayKitError(
            provider,
            "config",
            "<PayKitProvider> needs either `endpoint` or `createSession`.",
          );
        }
        return createFetchTransport(base, metadataRef.current).createSession(provider);
      },

      async confirmSession(request: ConfirmRequest): Promise<ConfirmResponse> {
        const custom = confirmSessionRef.current;
        if (custom) return custom(request);
        const base = endpointRef.current;
        if (!base) {
          throw new PayKitError(
            request.provider,
            "config",
            `${request.provider} needs a server confirm step. Pass \`endpoint\` or \`confirmSession\` to <PayKitProvider>.`,
          );
        }
        return createFetchTransport(base, metadataRef.current).confirmSession(request);
      },
    }),
    [],
  );

  // `providers` is almost always an inline object literal, so its identity is
  // useless as a dependency. Key on its contents, plus the currency — PayPal
  // bakes the currency into its script URL and must reload if it moves.
  const storeKey = `${JSON.stringify(providers)}|${stableAmount.currency}`;

  const stores = useMemo(() => {
    const built = {} as Record<Provider, ProviderStore>;
    for (const provider of PROVIDERS) {
      built[provider] = new ProviderStore(
        provider,
        getAdapter(provider),
        providers[provider] ?? null,
        adapter,
        callbacks,
      );
    }
    return built;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey, adapter]);

  const configured = useMemo(
    () => PROVIDERS.filter((p) => providers[p] != null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeKey],
  );

  const value = useMemo<PayKitContextValue>(
    () => ({ providers, configured, amount: stableAmount, adapter, stores }),
    [providers, configured, stableAmount, adapter, stores],
  );

  if (process.env.NODE_ENV !== "production" && configured.length === 0) {
    console.warn("paykit: <PayKitProvider> was given no providers — nothing will render.");
  }

  return <PayKitContext.Provider value={value}>{children}</PayKitContext.Provider>;
}
