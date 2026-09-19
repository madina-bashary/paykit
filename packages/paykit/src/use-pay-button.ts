"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getAdapter } from "./adapters";
import type {
  AdapterMode,
  ButtonSize,
  ButtonStyle,
  ButtonTheme,
} from "./adapters/types";
import { usePayKit } from "./context";
import type { Money, PayButtonStatus, PayKitError, PaymentResult, Provider } from "./types";

export type UsePayButtonOptions = {
  size?: ButtonSize;
  theme?: ButtonTheme;
  label?: string;
  fullWidth?: boolean;
};

export type UsePayButtonResult = {
  status: PayButtonStatus;
  error: PayKitError | null;
  /** The last terminal result, whatever its status. */
  result: PaymentResult | null;
  /**
   * `imperative` — wire `pay` to your own button.
   * `mounted`    — render `<div ref={containerRef} />` and the provider draws
   *                its own button there. PayPal and Google Pay require this.
   */
  mode: AdapterMode;
  pay: () => Promise<void>;
  containerRef: (el: HTMLElement | null) => void;
  /** Back to `ready`, clearing the last error and result. */
  reset: () => void;
  amount: Money;
  /** The provider's default button text, for imperative rendering. */
  label: string;
  /** False once we know this device can never pay with this provider. */
  isAvailable: boolean;
};

/**
 * The whole library, minus the markup.
 *
 * Everything `<PayButton />` does happens here — it is a thin renderer over
 * this hook, which is the point: a component library whose design system does
 * not match yours is a component library you cannot use.
 *
 * Call it as many times as you like for the same provider. State is shared per
 * provider, so a status indicator in your header and the button in your cart
 * always agree, and the SDK loads once.
 */
export function usePayButton(
  provider: Provider,
  options: UsePayButtonOptions = {},
): UsePayButtonResult {
  const { stores, amount } = usePayKit();
  const store = stores[provider];
  const definition = getAdapter(provider);

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const style: ButtonStyle = useMemo(
    () => ({
      size: options.size ?? "md",
      theme: options.theme ?? "light",
      ...(options.label !== undefined ? { label: options.label } : {}),
      ...(options.fullWidth !== undefined ? { fullWidth: options.fullWidth } : {}),
    }),
    [options.size, options.theme, options.label, options.fullWidth],
  );

  useEffect(() => {
    void store.ensureLoaded();
  }, [store]);

  // Mounted providers draw themselves as soon as we have both an SDK and a
  // container. Status is intentionally not a dependency — remounting PayPal's
  // iframe every time the state machine ticks would flicker the button.
  const styleKey = `${style.size}:${style.theme}:${style.label ?? ""}:${style.fullWidth ?? ""}`;
  const instance = state.instance;

  useEffect(() => {
    if (!instance || instance.mode !== "mounted" || !container) return;

    let aborted = false;
    let teardown: (() => void) | null = null;

    store
      .mount(container, style)
      .then((dispose) => {
        if (aborted) {
          dispose();
          return;
        }
        teardown = dispose;
      })
      .catch((cause: unknown) => {
        if (!aborted) store.fail(cause);
      });

    return () => {
      aborted = true;
      teardown?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, instance, container, styleKey]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pay = useCallback(() => store.pay(style), [store, styleKey]);
  const reset = useCallback(() => store.reset(), [store]);

  return {
    status: state.status,
    error: state.error,
    result: state.result,
    mode: definition.mode,
    pay,
    containerRef: setContainer,
    reset,
    amount,
    label: options.label ?? definition.label,
    isAvailable: state.status !== "unavailable",
  };
}
