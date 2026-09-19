import {
  type ConfirmRequest,
  type ConfirmResponse,
  PayKitError,
  type PayKitErrorCode,
  type PaySession,
  type Provider,
} from "./types";

const CODES: readonly PayKitErrorCode[] = [
  "declined",
  "network",
  "cancelled",
  "config",
  "sdk",
  "unknown",
];

function codeFrom(value: unknown): PayKitErrorCode {
  return CODES.includes(value as PayKitErrorCode) ? (value as PayKitErrorCode) : "unknown";
}

async function post(
  url: string,
  provider: Provider,
  body: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new PayKitError(provider, "network", `Could not reach ${url}`, cause);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // createPayKitHandler answers with { error: { code, message } }, so the
    // normalised code survives the network hop instead of collapsing to a 500.
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new PayKitError(
      provider,
      codeFrom(error?.code),
      error?.message ?? `${url} responded ${response.status}`,
      payload,
    );
  }
  return payload;
}

/**
 * The default wire format, and the other half of `createPayKitHandler`.
 *
 * Pass `endpoint` to `<PayKitProvider>` instead of writing `createSession` by
 * hand when your routes follow the `/api/paykit/[provider]` convention.
 */
export function createFetchTransport(endpoint: string, metadata?: Record<string, unknown>) {
  const base = endpoint.replace(/\/$/, "");
  return {
    createSession: async (provider: Provider): Promise<PaySession> =>
      (await post(`${base}/${provider}`, provider, {
        action: "create",
        ...metadata,
      })) as PaySession,

    confirmSession: async (request: ConfirmRequest): Promise<ConfirmResponse> =>
      (await post(`${base}/${request.provider}`, request.provider, {
        action: "confirm",
        reference: request.reference,
        token: request.token,
        ...metadata,
      })) as ConfirmResponse,
  };
}
