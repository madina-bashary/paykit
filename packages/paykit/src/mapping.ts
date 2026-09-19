import type { PayKitErrorCode, PaymentStatus } from "./types";

/**
 * Every normalisation rule in the library, in one file with no imports beyond
 * the types.
 *
 * It lives apart from the adapters for two reasons: the server half needs the
 * same rules without dragging browser code into a route handler, and a mapping
 * table you can read end to end is the difference between an abstraction you
 * trust and one you work around.
 */

/* --------------------------------- Stripe -------------------------------- */

/**
 * PaymentIntent.status → PaymentStatus.
 *
 * The interesting row is `processing`: it is not a success and not a failure.
 * Bank debits sit there for days. It lands on `requires_action` because that
 * is our "not final, wait for the webhook" status — do not ship on it.
 */
export function mapStripeIntentStatus(status: string): PaymentStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "processing":
    case "requires_action":
    case "requires_confirmation":
    // Authorised but not captured. Money is held, not taken.
    case "requires_capture":
      return "requires_action";
    case "canceled":
      return "cancelled";
    case "requires_payment_method":
      // Reached *after* a confirm attempt, this means the payment was rejected
      // and Stripe has detached the method so the customer can try another.
      return "failed";
    default:
      return "failed";
  }
}

/** Stripe.js `StripeError.type` (and the Node SDK's `rawType`) → our codes. */
export function mapStripeErrorCode(type: string | undefined): PayKitErrorCode {
  switch (type) {
    case "card_error":
      return "declined";
    case "api_connection_error":
      return "network";
    case "invalid_request_error":
    case "authentication_error":
      return "config";
    case "api_error":
    case "rate_limit_error":
    case "idempotency_error":
      return "sdk";
    case "validation_error":
      // Incomplete or malformed input in the Element. The customer fixes this
      // in place; it never becomes a terminal PayKitError.
      return "declined";
    default:
      return "unknown";
  }
}

/** The Node SDK's class-shaped errors, for when `rawType` is absent. */
export function mapStripeServerError(error: unknown): PayKitErrorCode {
  const e = (error ?? {}) as { type?: string; rawType?: string };
  if (e.rawType) return mapStripeErrorCode(e.rawType);
  switch (e.type) {
    case "StripeCardError":
      return "declined";
    case "StripeConnectionError":
      return "network";
    case "StripeInvalidRequestError":
    case "StripeAuthenticationError":
    case "StripePermissionError":
      return "config";
    case "StripeAPIError":
    case "StripeRateLimitError":
    case "StripeIdempotencyError":
      return "sdk";
    default:
      return "unknown";
  }
}

/* --------------------------------- PayPal -------------------------------- */

/**
 * PayPal reports status in two places — the Order and the Capture inside it —
 * using overlapping but not identical vocabularies. Both funnel through here.
 *
 * `APPROVED` is the trap: the customer finished in the PayPal window, but the
 * money has not moved until you capture. It is not a success.
 */
export function mapPayPalStatus(status: string): PaymentStatus {
  switch (status.toUpperCase()) {
    case "COMPLETED":
    // Refunds are out of scope for v1, but the capture did succeed, and
    // reporting a refunded payment as "failed" would be a lie.
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return "succeeded";
    case "CREATED":
    case "SAVED":
    case "APPROVED":
    case "PENDING":
    case "PAYER_ACTION_REQUIRED":
      return "requires_action";
    case "VOIDED":
      return "cancelled";
    case "DECLINED":
    case "FAILED":
      return "failed";
    default:
      return "failed";
  }
}

/**
 * The client SDK reports failures as plain `Error`s with prose messages, so
 * this is substring matching. It is not elegant; it is what PayPal gives us.
 */
export function mapPayPalErrorCode(message: string): PayKitErrorCode {
  const m = message.toUpperCase();
  if (m.includes("INSTRUMENT_DECLINED") || m.includes("PAYER_ACTION_REQUIRED")) return "declined";
  if (m.includes("WINDOW CLOSED") || m.includes("POPUP CLOSE") || m.includes("DETECTED POPUP CLOSE")) {
    return "cancelled";
  }
  if (m.includes("FAILED TO FETCH") || m.includes("NETWORK") || m.includes("TIMEOUT")) return "network";
  if (
    m.includes("INVALID_CLIENT") ||
    m.includes("CLIENT-ID") ||
    m.includes("CURRENCY_NOT_SUPPORTED") ||
    m.includes("EXPECTED AN ORDER ID")
  ) {
    return "config";
  }
  return "sdk";
}

/** PayPal's REST error envelope → our codes. */
export function mapPayPalRestError(status: number, body: unknown): PayKitErrorCode {
  const payload = (body ?? {}) as { name?: string; details?: Array<{ issue?: string }> };
  const issue = payload.details?.[0]?.issue?.toUpperCase() ?? "";

  if (issue === "INSTRUMENT_DECLINED" || issue === "PAYER_ACTION_REQUIRED") return "declined";
  if (issue === "ORDER_ALREADY_CAPTURED") return "unknown";
  if (status === 401 || status === 403) return "config";
  if (status === 400 || status === 422) {
    return payload.name === "UNPROCESSABLE_ENTITY" && issue ? "declined" : "config";
  }
  if (status >= 500) return "sdk";
  return "unknown";
}

/* ------------------------------- Google Pay ------------------------------ */

/**
 * Google Pay never tells you whether a payment succeeded — it hands you an
 * encrypted token and stops. The outcome comes from your PSP after the token
 * is processed server-side, so the only thing to map here is why the sheet
 * closed without one.
 */
export function mapGooglePayErrorCode(statusCode: string | undefined): PayKitErrorCode {
  switch (statusCode) {
    case "CANCELED":
      return "cancelled";
    case "DEVELOPER_ERROR":
    case "MERCHANT_ACCOUNT_ERROR":
      return "config";
    case "BUYER_ACCOUNT_ERROR":
      return "declined";
    case "INTERNAL_ERROR":
      return "sdk";
    default:
      return "unknown";
  }
}
