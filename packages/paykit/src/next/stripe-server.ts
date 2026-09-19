import { mapStripeIntentStatus, mapStripeServerError } from "../mapping";
import {
  type ConfirmResponse,
  type Money,
  PayKitError,
  type StripeSession,
} from "../types";

export type StripeServerConfig = {
  /** sk_test_… / sk_live_… This must only ever exist on the server. */
  secretKey: string;
  apiVersion?: string;
  /**
   * Let Stripe decide which payment methods to offer from your Dashboard
   * settings. On by default — it is what makes the Payment Element useful.
   */
  automaticPaymentMethods?: boolean;
};

type StripeNodeError = {
  type?: string;
  rawType?: string;
  message?: string;
  code?: string;
  decline_code?: string;
};

export { mapStripeServerError };

export function toPayKitError(error: unknown): PayKitError {
  if (error instanceof PayKitError) return error;
  const e = (error ?? {}) as StripeNodeError;
  if (e.type || e.rawType) {
    return new PayKitError(
      "stripe",
      mapStripeServerError(error),
      e.message ?? "Stripe request failed",
      error,
    );
  }
  return PayKitError.from("stripe", error);
}

type StripeClient = {
  paymentIntents: {
    create: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    retrieve: (id: string) => Promise<Record<string, unknown>>;
  };
};

const clients = new Map<string, StripeClient>();

/** Test-only: drop memoised Stripe clients. */
export function __resetStripeClients(): void {
  clients.clear();
}

async function getClient(config: StripeServerConfig): Promise<StripeClient> {
  if (!config.secretKey) {
    throw new PayKitError("stripe", "config", "stripe.secretKey is required on the server");
  }
  if (config.secretKey.startsWith("pk_")) {
    throw new PayKitError(
      "stripe",
      "config",
      "stripe.secretKey looks like a PUBLISHABLE key (pk_…). The server needs the sk_… key.",
    );
  }
  const key = `${config.secretKey}:${config.apiVersion ?? "default"}`;
  const cached = clients.get(key);
  if (cached) return cached;

  let StripeCtor: new (key: string, opts?: Record<string, unknown>) => StripeClient;
  try {
    const mod = (await import("stripe")) as unknown as {
      default: new (key: string, opts?: Record<string, unknown>) => StripeClient;
    };
    StripeCtor = mod.default;
  } catch (cause) {
    throw new PayKitError(
      "stripe",
      "config",
      "Stripe is configured but the `stripe` package is not installed. Run: npm i stripe",
      cause,
    );
  }

  const client = new StripeCtor(
    config.secretKey,
    config.apiVersion ? { apiVersion: config.apiVersion } : undefined,
  );
  clients.set(key, client);
  return client;
}

export async function createStripeIntent(
  config: StripeServerConfig,
  amount: Money,
  metadata?: Record<string, string>,
): Promise<StripeSession> {
  const stripe = await getClient(config);
  try {
    const intent = await stripe.paymentIntents.create({
      amount: amount.value,
      currency: amount.currency.toLowerCase(),
      ...(config.automaticPaymentMethods === false
        ? {}
        : { automatic_payment_methods: { enabled: true } }),
      ...(metadata ? { metadata } : {}),
    });
    const clientSecret = intent["client_secret"];
    if (typeof clientSecret !== "string") {
      throw new PayKitError("stripe", "unknown", "Stripe returned no client_secret", intent);
    }
    return { clientSecret, amount };
  } catch (cause) {
    throw toPayKitError(cause);
  }
}

export async function retrieveStripeIntent(
  config: StripeServerConfig,
  id: string,
  fallbackAmount: Money,
): Promise<ConfirmResponse> {
  if (!id) throw new PayKitError("stripe", "config", "A PaymentIntent id is required");
  const stripe = await getClient(config);
  try {
    const intent = await stripe.paymentIntents.retrieve(id);
    return {
      status: mapStripeIntentStatus(String(intent["status"])),
      reference: String(intent["id"] ?? id),
      amount:
        typeof intent["amount"] === "number" && typeof intent["currency"] === "string"
          ? { value: intent["amount"], currency: (intent["currency"] as string).toUpperCase() }
          : fallbackAmount,
      raw: intent,
    };
  } catch (cause) {
    throw toPayKitError(cause);
  }
}

/**
 * Google Pay hands the browser an opaque token. With Stripe as the gateway
 * that token is a JSON-encoded Stripe card token, and this is where it becomes
 * an actual charge — server-side, at the server's amount.
 */
export async function chargeGooglePayToken(
  config: StripeServerConfig,
  token: string,
  amount: Money,
  metadata?: Record<string, string>,
): Promise<ConfirmResponse> {
  const stripe = await getClient(config);

  let cardToken: string;
  try {
    const parsed = JSON.parse(token) as { id?: string };
    if (!parsed.id) throw new Error("no id");
    cardToken = parsed.id;
  } catch {
    throw new PayKitError(
      "googlePay",
      "unknown",
      "The Google Pay token was not a Stripe token. Check that tokenizationSpecification.gateway is \"stripe\".",
    );
  }

  try {
    const intent = await stripe.paymentIntents.create({
      amount: amount.value,
      currency: amount.currency.toLowerCase(),
      payment_method_data: { type: "card", card: { token: cardToken } },
      confirm: true,
      // No redirects: there is no browser waiting on a return_url here.
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      ...(metadata ? { metadata } : {}),
    });
    return {
      status: mapStripeIntentStatus(String(intent["status"])),
      reference: String(intent["id"] ?? ""),
      amount:
        typeof intent["amount"] === "number" && typeof intent["currency"] === "string"
          ? { value: intent["amount"], currency: (intent["currency"] as string).toUpperCase() }
          : amount,
      raw: intent,
    };
  } catch (cause) {
    const error = toPayKitError(cause);
    // Re-badge: the customer pressed a Google Pay button, so that is the
    // provider they should see in the error.
    throw new PayKitError("googlePay", error.code, error.message, error.raw);
  }
}
