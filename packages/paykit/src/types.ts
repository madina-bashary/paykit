/**
 * The vocabulary every adapter is normalised into.
 *
 * Three SDKs report success four different ways and failure about fifteen.
 * Everything below exists so that calling code sees one shape. When you need
 * the provider's own payload it is always on `.raw` — this library wraps the
 * SDKs, it does not hide them.
 */

export type Provider = "stripe" | "paypal" | "googlePay";

export const PROVIDERS: readonly Provider[] = ["stripe", "paypal", "googlePay"];

/**
 * Money is always in minor units. 2499 is $24.99.
 *
 * Floats are banned here on purpose: `0.1 + 0.2` is not `0.3`, and a payments
 * library that rounds is a payments library that loses money.
 */
export type Money = {
  /** Minor units — cents, pence, yen. Integer. Never a float. */
  value: number;
  /** ISO 4217, uppercase. "USD", "EUR", "JPY". */
  currency: string;
};

/**
 * The normalised outcome of an attempt.
 *
 * - `succeeded`       — money is captured (or authorised and captured, per provider).
 * - `requires_action` — NOT final. Either the customer must do something else,
 *                       or the provider settles asynchronously. Resolve it with
 *                       a webhook; do not ship the order on this status.
 * - `failed`          — terminal. Declined, expired, rejected.
 * - `cancelled`       — the customer backed out. Not an error condition.
 */
export type PaymentStatus =
  | "succeeded"
  | "requires_action"
  | "failed"
  | "cancelled";

export type PaymentResult = {
  provider: Provider;
  status: PaymentStatus;
  /**
   * The one id worth persisting: Stripe PaymentIntent id, PayPal Order id, or
   * the PaymentIntent created from a Google Pay token.
   */
  reference: string;
  amount: Money;
  /** The provider's untouched payload. Escape hatch — typed as unknown by design. */
  raw: unknown;
};

/**
 * Error taxonomy, collapsed to six cases.
 *
 * - `declined`  — the instrument said no. Retryable by the customer.
 * - `network`   — request never completed. Retryable as-is.
 * - `cancelled` — customer dismissed the sheet/window. Not really an error.
 * - `config`    — you wired it wrong: bad key, wrong merchant id, bad currency.
 * - `sdk`       — the provider SDK failed to load or threw internally.
 * - `unknown`   — unmapped. If you see these, the mapping table needs a row.
 */
export type PayKitErrorCode =
  | "declined"
  | "network"
  | "cancelled"
  | "config"
  | "sdk"
  | "unknown";

export class PayKitError extends Error {
  readonly provider: Provider;
  readonly code: PayKitErrorCode;
  readonly raw?: unknown;

  constructor(
    provider: Provider,
    code: PayKitErrorCode,
    message: string,
    raw?: unknown,
  ) {
    super(message);
    this.name = "PayKitError";
    this.provider = provider;
    this.code = code;
    this.raw = raw;
  }

  /** True when retrying the same call could plausibly succeed. */
  get retryable(): boolean {
    return this.code === "network" || this.code === "declined";
  }

  /**
   * Last-resort wrapper for a value that escaped an adapter's own mapping.
   * Adapters should map before reaching this; anything landing here as
   * `unknown` is a missing row in the table.
   */
  static from(provider: Provider, raw: unknown): PayKitError {
    if (raw instanceof PayKitError) return raw;
    if (raw instanceof Error) {
      return new PayKitError(provider, "unknown", raw.message, raw);
    }
    return new PayKitError(provider, "unknown", String(raw), raw);
  }
}

/**
 * Button lifecycle.
 *
 *   idle → loading_sdk → ready → processing → succeeded
 *                                           ↘ failed
 *                                           ↘ cancelled → ready
 *
 * `unavailable` is the one state outside that line: Google Pay's
 * `isReadyToPay` can tell us this device will never be able to pay, and
 * rendering a dead button is worse than rendering none.
 */
export type PayButtonStatus =
  | "idle"
  | "loading_sdk"
  | "ready"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unavailable";

/* -------------------------------------------------------------------------- */
/* Sessions — what your server hands back to the client                        */
/* -------------------------------------------------------------------------- */

export type StripeSession = {
  /** PaymentIntent client secret. Safe for the browser; not a secret key. */
  clientSecret: string;
  /** Server-authoritative amount. Overrides the display amount if present. */
  amount?: Money;
};

export type PayPalSession = {
  /** PayPal Orders v2 id. */
  orderId: string;
  amount?: Money;
};

/** Passed straight into Google Pay's `tokenizationSpecification.parameters`. */
export type GooglePayGateway = {
  gateway: string;
  [param: string]: string;
};

export type GooglePaySession = {
  gateway: GooglePayGateway;
  amount?: Money;
  merchantId?: string;
  merchantName?: string;
};

export type PaySession = StripeSession | PayPalSession | GooglePaySession;

export function isStripeSession(s: PaySession): s is StripeSession {
  return typeof (s as StripeSession).clientSecret === "string";
}
export function isPayPalSession(s: PaySession): s is PayPalSession {
  return typeof (s as PayPalSession).orderId === "string";
}
export function isGooglePaySession(s: PaySession): s is GooglePaySession {
  return typeof (s as GooglePaySession).gateway === "object";
}

/* -------------------------------------------------------------------------- */
/* Confirm — the second server round-trip, where one is needed                 */
/* -------------------------------------------------------------------------- */

export type ConfirmRequest = {
  provider: Provider;
  /** PayPal order id, or the Stripe PaymentIntent id. */
  reference?: string;
  /** Google Pay's opaque `tokenizationData.token`, verbatim. */
  token?: string;
};

export type ConfirmResponse = {
  status: PaymentStatus;
  reference: string;
  amount?: Money;
  raw?: unknown;
};

/* -------------------------------------------------------------------------- */
/* Client-side provider configuration                                          */
/* -------------------------------------------------------------------------- */

export type StripeClientConfig = {
  /** pk_test_… / pk_live_… Publishable. Never the secret key. */
  publishableKey: string;
  locale?: string;
  /** Forwarded to Stripe Elements `appearance`. */
  appearance?: Record<string, unknown>;
};

export type PayPalClientConfig = {
  clientId: string;
  /** Defaults to the currency on `amount`. */
  currency?: string;
  /** PayPal's own button styling — they render their button, not ours. */
  style?: {
    layout?: "vertical" | "horizontal";
    color?: "gold" | "blue" | "silver" | "white" | "black";
    shape?: "rect" | "pill";
    label?: "paypal" | "checkout" | "buynow" | "pay";
    height?: number;
  };
};

export type GooglePayClientConfig = {
  merchantId: string;
  merchantName?: string;
  environment: "TEST" | "PRODUCTION";
  allowedCardNetworks?: string[];
  allowedAuthMethods?: string[];
  buttonColor?: "default" | "black" | "white";
  buttonType?: "book" | "buy" | "checkout" | "donate" | "order" | "pay" | "plain" | "subscribe";
};

export type ProvidersConfig = {
  stripe?: StripeClientConfig;
  paypal?: PayPalClientConfig;
  googlePay?: GooglePayClientConfig;
};

export type ProviderConfigFor<P extends Provider> = P extends "stripe"
  ? StripeClientConfig
  : P extends "paypal"
    ? PayPalClientConfig
    : GooglePayClientConfig;
