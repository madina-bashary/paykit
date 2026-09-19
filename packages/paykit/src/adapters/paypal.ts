import { mapPayPalErrorCode, mapPayPalStatus } from "../mapping";
import { normalizeMoney } from "../money";
import {
  isPayPalSession,
  type Money,
  PayKitError,
  type PayPalClientConfig,
} from "../types";
import type { AdapterDefinition, AdapterInstance, ButtonSize, ButtonStyle } from "./types";

export { mapPayPalErrorCode, mapPayPalStatus };

export function toPayKitError(raw: unknown): PayKitError {
  if (raw instanceof PayKitError) return raw;
  const message = raw instanceof Error ? raw.message : String(raw);
  return new PayKitError("paypal", mapPayPalErrorCode(message), message, raw);
}

/* -------------------------------------------------------------------------- */
/* SDK surface we actually use                                                 */
/* -------------------------------------------------------------------------- */

type PayPalButtonsInstance = {
  render: (el: HTMLElement) => Promise<void>;
  close: () => void;
  isEligible?: () => boolean;
};

type PayPalNamespace = {
  Buttons?: (options: Record<string, unknown>) => PayPalButtonsInstance;
};

const HEIGHTS: Record<ButtonSize, number> = { sm: 32, md: 40, lg: 50 };

async function importPayPalJs(): Promise<typeof import("@paypal/paypal-js")> {
  try {
    return await import("@paypal/paypal-js");
  } catch (cause) {
    throw new PayKitError(
      "paypal",
      "config",
      "PayPal is configured but @paypal/paypal-js is not installed. Run: npm i @paypal/paypal-js",
      cause,
    );
  }
}

export const paypalAdapter: AdapterDefinition<PayPalClientConfig> = {
  id: "paypal",
  label: "PayPal",
  // PayPal's brand rules require their button. We give it a container and
  // stay out of the way.
  mode: "mounted",

  async create(config, ctx): Promise<AdapterInstance> {
    if (!config.clientId) {
      throw new PayKitError("paypal", "config", "paypal.clientId is required");
    }

    const currency = (config.currency ?? ctx.amount.currency).toUpperCase();
    const { loadScript } = await importPayPalJs();

    let namespace: PayPalNamespace | null;
    try {
      namespace = (await loadScript({
        clientId: config.clientId,
        currency,
        components: "buttons",
        intent: "capture",
      })) as PayPalNamespace | null;
    } catch (cause) {
      throw new PayKitError("paypal", "sdk", "The PayPal SDK failed to load", cause);
    }
    if (!namespace?.Buttons) {
      throw new PayKitError(
        "paypal",
        "sdk",
        "The PayPal SDK loaded without a Buttons component (usually a blocked script or an invalid client id)",
      );
    }
    const Buttons = namespace.Buttons;

    return {
      mode: "mounted",

      async isAvailable() {
        try {
          const probe = Buttons({});
          return probe.isEligible ? probe.isEligible() : true;
        } catch {
          return false;
        }
      },

      async mount(el, events, style: ButtonStyle) {
        let closed = false;

        const buttons = Buttons({
          style: {
            layout: config.style?.layout ?? "horizontal",
            // Gold is PayPal's recommended default on any background.
            color: config.style?.color ?? "gold",
            shape: config.style?.shape ?? "rect",
            label: config.style?.label ?? "paypal",
            height: config.style?.height ?? HEIGHTS[style.size],
          },

          createOrder: async () => {
            const session = await ctx.createSession("paypal");
            if (!isPayPalSession(session)) {
              throw new PayKitError(
                "paypal",
                "config",
                "createSession('paypal') must resolve to { orderId }",
                session,
              );
            }
            return session.orderId;
          },

          onApprove: async (data: { orderID?: string }) => {
            events.onProcessing();
            const reference = data.orderID ?? "";
            try {
              // Capture happens on the server. Capturing from the browser
              // means trusting the browser about whether you got paid.
              const confirmed = await ctx.confirmSession({ provider: "paypal", reference });
              events.onResult({
                provider: "paypal",
                status: confirmed.status,
                reference: confirmed.reference || reference,
                amount: normalizeMoney(confirmed.amount ?? ctx.amount),
                raw: confirmed.raw ?? confirmed,
              });
            } catch (cause) {
              events.onError(toPayKitError(cause));
            }
          },

          onCancel: (data: { orderID?: string }) => {
            const amount: Money = normalizeMoney(ctx.amount);
            events.onResult({
              provider: "paypal",
              status: "cancelled",
              reference: data?.orderID ?? "",
              amount,
              raw: data,
            });
          },

          onError: (cause: unknown) => {
            const error = toPayKitError(cause);
            // PayPal routes a closed window through onError. That is a
            // cancellation, and surfacing it as an error trains people to
            // ignore your error toasts.
            if (error.code === "cancelled") {
              events.onResult({
                provider: "paypal",
                status: "cancelled",
                reference: "",
                amount: normalizeMoney(ctx.amount),
                raw: cause,
              });
              return;
            }
            events.onError(error);
          },
        });

        if (buttons.isEligible && !buttons.isEligible()) {
          throw new PayKitError(
            "paypal",
            "config",
            `PayPal reported no eligible funding source for ${currency}`,
          );
        }

        await buttons.render(el);

        return () => {
          if (closed) return;
          closed = true;
          try {
            buttons.close();
          } catch {
            // close() throws if PayPal already tore down its own iframe.
          }
        };
      },
    };
  },
};
