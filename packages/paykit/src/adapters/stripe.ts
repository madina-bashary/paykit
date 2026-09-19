import { assertMoney, formatMoney, normalizeMoney } from "../money";
import {
  isStripeSession,
  type Money,
  PayKitError,
  type PaymentResult,
  type StripeClientConfig,
} from "../types";
import { mapStripeErrorCode, mapStripeIntentStatus } from "../mapping";
import { openModal } from "./modal";
import type { AdapterDefinition, AdapterInstance } from "./types";

export { mapStripeErrorCode, mapStripeIntentStatus };

type StripeLikeError = {
  type?: string;
  message?: string;
  code?: string;
  decline_code?: string;
  payment_intent?: { id?: string; status?: string; amount?: number; currency?: string };
};

export function toPayKitError(raw: unknown): PayKitError {
  if (raw instanceof PayKitError) return raw;
  const err = (raw ?? {}) as StripeLikeError;
  if (typeof err.type === "string") {
    return new PayKitError(
      "stripe",
      mapStripeErrorCode(err.type),
      err.message ?? `Stripe ${err.type}`,
      raw,
    );
  }
  return PayKitError.from("stripe", raw);
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

type StripeJs = typeof import("@stripe/stripe-js");
type StripeInstance = Awaited<ReturnType<StripeJs["loadStripe"]>>;

async function importStripeJs(): Promise<StripeJs> {
  try {
    return await import("@stripe/stripe-js");
  } catch (cause) {
    throw new PayKitError(
      "stripe",
      "config",
      "Stripe is configured but @stripe/stripe-js is not installed. Run: npm i @stripe/stripe-js",
      cause,
    );
  }
}

export const stripeAdapter: AdapterDefinition<StripeClientConfig> = {
  id: "stripe",
  label: "Pay with card",
  mode: "imperative",

  async create(config, ctx): Promise<AdapterInstance> {
    if (!config.publishableKey) {
      throw new PayKitError("stripe", "config", "stripe.publishableKey is required");
    }
    if (config.publishableKey.startsWith("sk_")) {
      // Loud, because the alternative is a secret key in a JS bundle.
      throw new PayKitError(
        "stripe",
        "config",
        "stripe.publishableKey looks like a SECRET key (sk_…). Secret keys must never reach the browser — use the pk_… key here.",
      );
    }

    const { loadStripe } = await importStripeJs();
    let stripe: StripeInstance;
    try {
      stripe = await loadStripe(config.publishableKey, config.locale ? { locale: config.locale as never } : undefined);
    } catch (cause) {
      throw new PayKitError("stripe", "sdk", "Stripe.js failed to load", cause);
    }
    if (!stripe) {
      throw new PayKitError(
        "stripe",
        "sdk",
        "Stripe.js loaded but returned no instance (usually a blocked script or an invalid publishable key)",
      );
    }
    const sdk = stripe;

    return {
      mode: "imperative",
      async isAvailable() {
        return true;
      },

      async pay(events, style) {
        let modal: ReturnType<typeof openModal> | null = null;
        try {
          const session = await ctx.createSession("stripe");
          if (!isStripeSession(session)) {
            throw new PayKitError(
              "stripe",
              "config",
              "createSession('stripe') must resolve to { clientSecret }",
              session,
            );
          }

          // The server's amount wins. The prop is a display value only.
          const amount: Money = normalizeMoney(session.amount ?? ctx.amount);
          assertMoney(amount, "stripe");

          const elements = sdk.elements({
            clientSecret: session.clientSecret,
            ...(config.appearance ? { appearance: config.appearance as never } : {}),
          });
          const paymentElement = elements.create("payment");

          modal = openModal({
            title: "Pay with card",
            amountLabel: formatMoney(amount, config.locale),
            submitLabel: `Pay ${formatMoney(amount, config.locale)}`,
            theme: style.theme,
          });
          const view = modal;
          paymentElement.mount(view.slot);

          const settled = await new Promise<PaymentResult>((resolve, reject) => {
            view.onDismiss(() => {
              resolve({
                provider: "stripe",
                status: "cancelled",
                reference: "",
                amount,
                raw: { reason: "dismissed" },
              });
            });

            view.onSubmit(() => {
              view.setError(null);
              view.setBusy(true);
              events.onProcessing();

              sdk
                .confirmPayment({ elements, redirect: "if_required" })
                .then((raw: unknown) => {
                  const outcome = raw as {
                    error?: StripeLikeError;
                    paymentIntent?: Record<string, unknown>;
                  };
                  const error = outcome.error;
                  if (error) {
                    const code = mapStripeErrorCode(error.type);
                    // A validation error means the form is incomplete — the
                    // customer can fix it without losing the session.
                    if (error.type === "validation_error") {
                      view.setBusy(false);
                      view.setError(error.message ?? "Check your card details.");
                      return;
                    }
                    if (code === "declined") {
                      // A decline is a real outcome, not a crash: surface it in
                      // place and let them try another card.
                      view.setBusy(false);
                      view.setError(error.message ?? "Your card was declined.");
                      return;
                    }
                    reject(toPayKitError(error));
                    return;
                  }

                  const intent = outcome.paymentIntent;
                  if (!intent) {
                    reject(
                      new PayKitError("stripe", "unknown", "Stripe returned neither an error nor a PaymentIntent", outcome),
                    );
                    return;
                  }
                  resolve({
                    provider: "stripe",
                    status: mapStripeIntentStatus(String(intent["status"])),
                    reference: String(intent["id"] ?? ""),
                    amount:
                      typeof intent["amount"] === "number" && typeof intent["currency"] === "string"
                        ? { value: intent["amount"], currency: (intent["currency"] as string).toUpperCase() }
                        : amount,
                    raw: intent,
                  });
                })
                .catch((cause: unknown) => reject(toPayKitError(cause)));
            });
          });

          view.close();
          modal = null;
          events.onResult(settled);
        } catch (cause) {
          modal?.close();
          events.onError(toPayKitError(cause));
        }
      },
    };
  },
};
