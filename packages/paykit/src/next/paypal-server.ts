import { fromDecimalString, toDecimalString } from "../money";
import { mapPayPalRestError, mapPayPalStatus } from "../mapping";
import {
  type ConfirmResponse,
  type Money,
  PayKitError,
  type PayPalSession,
} from "../types";

export type PayPalServerConfig = {
  clientId: string;
  clientSecret: string;
  environment: "sandbox" | "live";
  /** Override for testing. Defaults to PayPal's own hosts. */
  baseUrl?: string;
};

export { mapPayPalRestError };

const HOSTS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

function baseUrl(config: PayPalServerConfig): string {
  return config.baseUrl ?? HOSTS[config.environment];
}

/** Works on the Node and Edge runtimes alike; client ids are ASCII. */
function toBase64(input: string): string {
  if (typeof btoa === "function") return btoa(input);
  return Buffer.from(input, "utf8").toString("base64");
}

type TokenCacheEntry = { token: string; expiresAt: number };
const tokenCache = new Map<string, TokenCacheEntry>();

/** Test-only: clear the memoised OAuth tokens. */
export function __resetPayPalTokenCache(): void {
  tokenCache.clear();
}

async function accessToken(config: PayPalServerConfig): Promise<string> {
  const key = `${baseUrl(config)}:${config.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const credentials = toBase64(`${config.clientId}:${config.clientSecret}`);
  let response: Response;
  try {
    response = await fetch(`${baseUrl(config)}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
  } catch (cause) {
    throw new PayKitError("paypal", "network", "Could not reach PayPal to authenticate", cause);
  }

  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;

  if (!response.ok || !body?.access_token) {
    throw new PayKitError(
      "paypal",
      mapPayPalRestError(response.status, body),
      "PayPal rejected the client credentials — check PAYPAL_CLIENT_ID / PAYPAL_SECRET and the environment.",
      body,
    );
  }

  tokenCache.set(key, {
    token: body.access_token,
    // Refresh a minute early rather than racing the expiry.
    expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 600) - 60) * 1000,
  });
  return body.access_token;
}

async function call(
  config: PayPalServerConfig,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const token = await accessToken(config);
  let response: Response;
  try {
    response = await fetch(`${baseUrl(config)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new PayKitError("paypal", "network", `Could not reach PayPal (${path})`, cause);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const payload = (body ?? {}) as { message?: string; details?: Array<{ description?: string }> };
    throw new PayKitError(
      "paypal",
      mapPayPalRestError(response.status, body),
      payload.details?.[0]?.description ?? payload.message ?? `PayPal responded ${response.status}`,
      body,
    );
  }
  return body;
}

export async function createPayPalOrder(
  config: PayPalServerConfig,
  amount: Money,
  metadata?: Record<string, string>,
): Promise<PayPalSession> {
  const order = (await call(config, "/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: amount.currency.toUpperCase(),
            value: toDecimalString(amount),
          },
          ...(metadata?.["reference"] ? { custom_id: metadata["reference"] } : {}),
        },
      ],
    }),
  })) as { id?: string };

  if (!order.id) {
    throw new PayKitError("paypal", "unknown", "PayPal created an order without an id", order);
  }
  return { orderId: order.id, amount };
}

type CaptureResponse = {
  id?: string;
  status?: string;
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id?: string;
        status?: string;
        amount?: { currency_code?: string; value?: string };
      }>;
    };
  }>;
};

export async function capturePayPalOrder(
  config: PayPalServerConfig,
  orderId: string,
  fallbackAmount: Money,
): Promise<ConfirmResponse> {
  if (!orderId) {
    throw new PayKitError("paypal", "config", "A PayPal order id is required to capture");
  }
  const body = (await call(config, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    body: "{}",
  })) as CaptureResponse;

  const capture = body.purchase_units?.[0]?.payments?.captures?.[0];
  // The capture's own status is the truthful one. The order says COMPLETED as
  // soon as the call succeeds, even when the capture inside it is PENDING.
  const status = mapPayPalStatus(capture?.status ?? body.status ?? "");

  const amount =
    capture?.amount?.value && capture.amount.currency_code
      ? fromDecimalString(capture.amount.value, capture.amount.currency_code)
      : fallbackAmount;

  return {
    status,
    reference: body.id ?? orderId,
    amount,
    raw: body,
  };
}
