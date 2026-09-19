import type {
  ConfirmRequest,
  ConfirmResponse,
  Money,
  PayKitError,
  PaymentResult,
  PaySession,
  Provider,
} from "../types";

export type ButtonSize = "sm" | "md" | "lg";
export type ButtonTheme = "light" | "dark";

export type ButtonStyle = {
  size: ButtonSize;
  theme: ButtonTheme;
  /** Overrides the adapter's default label where the provider allows it. */
  label?: string;
  /** Provider button is drawn to fill this width when it supports it. */
  fullWidth?: boolean;
};

/**
 * Everything an adapter is allowed to reach for. Deliberately small: an
 * adapter cannot read the price from anywhere except `amount` (display) and
 * the session the server returned (authoritative).
 */
export type AdapterContext = {
  /** Display amount from `<PayKitProvider amount>`. The server may override it. */
  amount: Money;
  createSession: (provider: Provider) => Promise<PaySession>;
  confirmSession: (req: ConfirmRequest) => Promise<ConfirmResponse>;
};

export type AdapterEvents = {
  /** The customer committed — money is now moving. Drives `processing`. */
  onProcessing: () => void;
  onResult: (result: PaymentResult) => void;
  onError: (error: PayKitError) => void;
};

/**
 * Two shapes of provider, and pretending otherwise is the lie that would break
 * this abstraction:
 *
 * - `imperative` — we own the button, `pay()` runs on click. (Stripe)
 * - `mounted`    — the provider draws its own button into a container we give
 *                  it, because their brand rules require it. (PayPal, Google Pay)
 *
 * `<PayButton />` handles both. The headless hook exposes which one you got so
 * you can render the right thing.
 */
export type AdapterMode = "imperative" | "mounted";

export type AdapterInstance = {
  readonly mode: AdapterMode;
  /**
   * False when this browser/device can never complete a payment here — an
   * unsupported Google Pay device, for example. A button that cannot work
   * should not be drawn.
   */
  isAvailable: () => Promise<boolean>;
  /** `imperative` mode. Rejects only on programmer error; outcomes go to events. */
  pay?: (events: AdapterEvents, style: ButtonStyle) => Promise<void>;
  /** `mounted` mode. Returns a teardown function. */
  mount?: (
    el: HTMLElement,
    events: AdapterEvents,
    style: ButtonStyle,
  ) => Promise<() => void>;
};

export type AdapterDefinition<TConfig> = {
  id: Provider;
  /** Human label for the fallback button and for error messages. */
  label: string;
  mode: AdapterMode;
  /**
   * Loads the provider SDK and returns a live instance. Everything slow or
   * network-bound belongs here — this call is what `loading_sdk` covers.
   */
  create: (config: TConfig, ctx: AdapterContext) => Promise<AdapterInstance>;
};
