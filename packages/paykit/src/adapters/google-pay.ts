import { mapGooglePayErrorCode } from "../mapping";
import { normalizeMoney, toDecimalString } from "../money";
import {
  type GooglePayClientConfig,
  isGooglePaySession,
  type Money,
  PayKitError,
} from "../types";
import type { AdapterDefinition, AdapterInstance, ButtonSize, ButtonStyle } from "./types";

export { mapGooglePayErrorCode };

type GooglePayLikeError = { statusCode?: string; statusMessage?: string };

export function toPayKitError(raw: unknown): PayKitError {
  if (raw instanceof PayKitError) return raw;
  const err = (raw ?? {}) as GooglePayLikeError;
  if (typeof err.statusCode === "string") {
    return new PayKitError(
      "googlePay",
      mapGooglePayErrorCode(err.statusCode),
      err.statusMessage || `Google Pay: ${err.statusCode}`,
      raw,
    );
  }
  return PayKitError.from("googlePay", raw);
}

/* -------------------------------------------------------------------------- */
/* The slice of the Google Pay JS API we use                                   */
/* -------------------------------------------------------------------------- */

type PaymentDataRequest = Record<string, unknown>;

type PaymentsClient = {
  isReadyToPay: (req: PaymentDataRequest) => Promise<{ result: boolean }>;
  loadPaymentData: (req: PaymentDataRequest) => Promise<Record<string, unknown>>;
  createButton: (opts: Record<string, unknown>) => HTMLElement;
};

type GoogleGlobal = {
  payments?: {
    api?: {
      PaymentsClient: new (opts: { environment: "TEST" | "PRODUCTION" }) => PaymentsClient;
    };
  };
};

const SCRIPT_SRC = "https://pay.google.com/gp/p/js/pay.js";
const API_VERSION = { apiVersion: 2, apiVersionMinor: 0 } as const;
const HEIGHTS: Record<ButtonSize, string> = { sm: "32px", md: "40px", lg: "48px" };

/** Loads pay.js once per document, and reuses the in-flight promise. */
let scriptPromise: Promise<GoogleGlobal> | null = null;

function loadGooglePayScript(): Promise<GoogleGlobal> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(
      new PayKitError("googlePay", "sdk", "Google Pay requires a browser environment"),
    );
  }
  const existing = (window as unknown as { google?: GoogleGlobal }).google;
  if (existing?.payments?.api) return Promise.resolve(existing);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<GoogleGlobal>((resolve, reject) => {
    const done = () => {
      const g = (window as unknown as { google?: GoogleGlobal }).google;
      if (g?.payments?.api) resolve(g);
      else reject(new PayKitError("googlePay", "sdk", "pay.js loaded but google.payments.api is missing"));
    };
    const prior = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (prior) {
      prior.addEventListener("load", done, { once: true });
      prior.addEventListener(
        "error",
        () => reject(new PayKitError("googlePay", "sdk", "Failed to load pay.js")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", () => {
      scriptPromise = null;
      reject(new PayKitError("googlePay", "sdk", "Failed to load pay.js"));
    });
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Test-only: drop the memoised script promise between cases. */
export function __resetGooglePayScriptCache(): void {
  scriptPromise = null;
}

export const googlePayAdapter: AdapterDefinition<GooglePayClientConfig> = {
  id: "googlePay",
  label: "Google Pay",
  mode: "mounted",

  async create(config, ctx): Promise<AdapterInstance> {
    if (!config.merchantId) {
      throw new PayKitError("googlePay", "config", "googlePay.merchantId is required");
    }
    if (config.environment !== "TEST" && config.environment !== "PRODUCTION") {
      throw new PayKitError(
        "googlePay",
        "config",
        `googlePay.environment must be "TEST" or "PRODUCTION" (got ${String(config.environment)})`,
      );
    }

    const google = await loadGooglePayScript();
    const client = new google.payments!.api!.PaymentsClient({ environment: config.environment });

    const allowedAuthMethods = config.allowedAuthMethods ?? ["PAN_ONLY", "CRYPTOGRAM_3DS"];
    const allowedCardNetworks = config.allowedCardNetworks ?? [
      "AMEX",
      "DISCOVER",
      "MASTERCARD",
      "VISA",
    ];

    const baseCardMethod = {
      type: "CARD",
      parameters: { allowedAuthMethods, allowedCardNetworks },
    };

    return {
      mode: "mounted",

      async isAvailable() {
        try {
          // Note: isReadyToPay does not need a tokenizationSpecification, which
          // is why we can answer this before asking the server for a session.
          const res = await client.isReadyToPay({
            ...API_VERSION,
            allowedPaymentMethods: [baseCardMethod],
          });
          return res.result === true;
        } catch {
          return false;
        }
      },

      async mount(el, events, style: ButtonStyle) {
        const onClick = async () => {
          try {
            const session = await ctx.createSession("googlePay");
            if (!isGooglePaySession(session)) {
              throw new PayKitError(
                "googlePay",
                "config",
                "createSession('googlePay') must resolve to { gateway }",
                session,
              );
            }

            // The sheet shows the server's amount, not the prop, so the
            // customer never sees a number the server would not charge.
            const amount: Money = normalizeMoney(session.amount ?? ctx.amount);

            const request: PaymentDataRequest = {
              ...API_VERSION,
              allowedPaymentMethods: [
                {
                  ...baseCardMethod,
                  tokenizationSpecification: {
                    type: "PAYMENT_GATEWAY",
                    parameters: session.gateway,
                  },
                },
              ],
              merchantInfo: {
                merchantId: session.merchantId ?? config.merchantId,
                merchantName: session.merchantName ?? config.merchantName ?? "Merchant",
              },
              transactionInfo: {
                totalPriceStatus: "FINAL",
                totalPrice: toDecimalString(amount),
                currencyCode: amount.currency,
              },
            };

            const paymentData = await client.loadPaymentData(request);
            events.onProcessing();

            const token = (
              paymentData["paymentMethodData"] as
                | { tokenizationData?: { token?: string } }
                | undefined
            )?.tokenizationData?.token;
            if (!token) {
              throw new PayKitError(
                "googlePay",
                "unknown",
                "Google Pay returned no payment token",
                paymentData,
              );
            }

            const confirmed = await ctx.confirmSession({ provider: "googlePay", token });
            events.onResult({
              provider: "googlePay",
              status: confirmed.status,
              reference: confirmed.reference,
              amount: normalizeMoney(confirmed.amount ?? amount),
              raw: confirmed.raw ?? { paymentData, confirmed },
            });
          } catch (cause) {
            const error = toPayKitError(cause);
            if (error.code === "cancelled") {
              events.onResult({
                provider: "googlePay",
                status: "cancelled",
                reference: "",
                amount: normalizeMoney(ctx.amount),
                raw: cause,
              });
              return;
            }
            events.onError(error);
          }
        };

        const button = client.createButton({
          onClick,
          buttonColor: config.buttonColor ?? (style.theme === "dark" ? "white" : "black"),
          buttonType: config.buttonType ?? "pay",
          buttonSizeMode: "fill",
          buttonLocale: "en",
        });

        el.style.height = HEIGHTS[style.size];
        if (style.fullWidth !== false) el.style.width = "100%";
        el.appendChild(button);

        return () => {
          button.remove();
        };
      },
    };
  },
};
