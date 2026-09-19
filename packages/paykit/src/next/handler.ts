import { assertMoney, normalizeMoney } from "../money";
import {
  type ConfirmResponse,
  type GooglePayGateway,
  type Money,
  PayKitError,
  type PayKitErrorCode,
  type PaySession,
  PROVIDERS,
  type Provider,
} from "../types";
import { capturePayPalOrder, createPayPalOrder, type PayPalServerConfig } from "./paypal-server";
import {
  chargeGooglePayToken,
  createStripeIntent,
  retrieveStripeIntent,
  type StripeServerConfig,
} from "./stripe-server";

export type GooglePayServerConfig = {
  merchantId: string;
  merchantName?: string;
  /**
   * The `tokenizationSpecification.parameters` handed to the browser. With
   * Stripe as the gateway this is:
   *   { gateway: "stripe", "stripe:version": "2024-06-20",
   *     "stripe:publishableKey": process.env.NEXT_PUBLIC_STRIPE_PK! }
   */
  gateway: GooglePayGateway;
  /**
   * Turn a Google Pay token into a charge. Defaults to charging it through
   * the Stripe config above, which is the only gateway paykit wires by hand.
   */
  process?: (token: string, amount: Money, request: Request) => Promise<ConfirmResponse>;
};

export type PayKitHandlerConfig = {
  stripe?: StripeServerConfig;
  paypal?: PayPalServerConfig;
  googlePay?: GooglePayServerConfig;

  /**
   * Recompute the price from your own data — a cart id, a product id, a
   * subscription — and return it in minor units.
   *
   * This is not a convenience hook. It is the security model: the browser
   * tells you *what* it wants to buy, never *how much* it costs. A handler
   * that trusts a client-sent amount is a $0.01 checkout waiting to happen.
   */
  resolveAmount: (request: Request) => Money | Promise<Money>;

  /** Extra metadata attached to the provider record. Values must be strings. */
  metadata?: (request: Request) => Record<string, string> | Promise<Record<string, string>>;

  /** Server-side observability. Never runs for client input errors. */
  onError?: (error: PayKitError) => void;
};

type Action = "create" | "confirm";

type RouteContext = {
  params?: { provider?: string } | Promise<{ provider?: string }>;
};

const STATUS: Record<PayKitErrorCode, number> = {
  declined: 402,
  cancelled: 409,
  network: 502,
  sdk: 502,
  config: 500,
  unknown: 500,
};

/** Decline and network messages are customer-safe. The rest are not. */
function publicMessage(error: PayKitError): string {
  if (error.code === "declined" || error.code === "cancelled" || error.code === "network") {
    return error.message;
  }
  return process.env.NODE_ENV === "production"
    ? "The payment provider could not be reached. Please try again."
    : error.message;
}

function errorResponse(error: PayKitError): Response {
  return Response.json(
    { error: { code: error.code, provider: error.provider, message: publicMessage(error) } },
    { status: STATUS[error.code] },
  );
}

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

async function resolveProvider(request: Request, context?: RouteContext): Promise<Provider> {
  const params = await context?.params;
  const fromParams = params?.provider;
  if (isProvider(fromParams)) return fromParams;

  // Fall back to the URL so the handler also works when it is not mounted at
  // a [provider] segment.
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (isProvider(last)) return last;

  throw new PayKitError(
    "stripe",
    "config",
    `Unknown provider "${String(fromParams ?? last)}". Expected one of: ${PROVIDERS.join(", ")}.`,
  );
}

/**
 * Builds the `POST` export for `app/api/paykit/[provider]/route.ts`.
 *
 * Two actions on one route:
 *   { action: "create" }  → a session the browser can pay against
 *   { action: "confirm" } → capture / process, and report the real outcome
 */
export function createPayKitHandler(config: PayKitHandlerConfig) {
  if (typeof config.resolveAmount !== "function") {
    throw new Error(
      "paykit: createPayKitHandler requires `resolveAmount`. The client must never set the price.",
    );
  }

  const POST = async (request: Request, context?: RouteContext): Promise<Response> => {
    let provider: Provider;
    try {
      provider = await resolveProvider(request, context);
    } catch (cause) {
      return errorResponse(PayKitError.from("stripe", cause));
    }

    try {
      // Clone before reading: `resolveAmount` is documented to call
      // `request.json()` itself, and a body can only be consumed once.
      const forResolver = request.clone();
      const body = (await request.json().catch(() => ({}))) as {
        action?: Action;
        reference?: string;
        token?: string;
      };
      const action: Action = body.action === "confirm" ? "confirm" : "create";

      const amount = normalizeMoney(await config.resolveAmount(forResolver));
      assertMoney(amount, provider);

      const metadata = config.metadata ? await config.metadata(request.clone()) : undefined;

      const payload =
        action === "create"
          ? await create(config, provider, amount, metadata)
          : await confirm(config, provider, amount, body, request, metadata);

      return Response.json(payload);
    } catch (cause) {
      const error = PayKitError.from(provider, cause);
      config.onError?.(error);
      if (error.code === "config" || error.code === "sdk" || error.code === "unknown") {
        // These are our bugs, not the customer's. Make them visible in logs
        // even when the response body stays vague.
        console.error(`[paykit] ${provider} ${error.code}: ${error.message}`, error.raw ?? "");
      }
      return errorResponse(error);
    }
  };

  return { POST };
}

function missing(provider: Provider): PayKitError {
  return new PayKitError(
    provider,
    "config",
    `"${provider}" is not configured on createPayKitHandler().`,
  );
}

async function create(
  config: PayKitHandlerConfig,
  provider: Provider,
  amount: Money,
  metadata: Record<string, string> | undefined,
): Promise<PaySession> {
  switch (provider) {
    case "stripe": {
      if (!config.stripe) throw missing("stripe");
      return createStripeIntent(config.stripe, amount, metadata);
    }
    case "paypal": {
      if (!config.paypal) throw missing("paypal");
      return createPayPalOrder(config.paypal, amount, metadata);
    }
    case "googlePay": {
      if (!config.googlePay) throw missing("googlePay");
      // Nothing is created yet — Google Pay only needs to know where to send
      // the token and what the server says the price is.
      return {
        gateway: config.googlePay.gateway,
        merchantId: config.googlePay.merchantId,
        ...(config.googlePay.merchantName ? { merchantName: config.googlePay.merchantName } : {}),
        amount,
      };
    }
  }
}

async function confirm(
  config: PayKitHandlerConfig,
  provider: Provider,
  amount: Money,
  body: { reference?: string; token?: string },
  request: Request,
  metadata: Record<string, string> | undefined,
): Promise<ConfirmResponse> {
  switch (provider) {
    case "stripe": {
      if (!config.stripe) throw missing("stripe");
      return retrieveStripeIntent(config.stripe, body.reference ?? "", amount);
    }
    case "paypal": {
      if (!config.paypal) throw missing("paypal");
      return capturePayPalOrder(config.paypal, body.reference ?? "", amount);
    }
    case "googlePay": {
      if (!config.googlePay) throw missing("googlePay");
      if (!body.token) {
        throw new PayKitError("googlePay", "config", "No Google Pay token in the request");
      }
      if (config.googlePay.process) {
        return config.googlePay.process(body.token, amount, request);
      }
      if (!config.stripe) {
        throw new PayKitError(
          "googlePay",
          "config",
          "Google Pay needs either a `process` function or a Stripe config to charge the token against.",
        );
      }
      return chargeGooglePayToken(config.stripe, body.token, amount, metadata);
    }
  }
}
