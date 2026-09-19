import { describe, expect, it } from "vitest";
import { mapStripeErrorCode, mapStripeIntentStatus } from "../adapters/stripe";
import { mapPayPalErrorCode, mapPayPalStatus } from "../adapters/paypal";
import { mapGooglePayErrorCode } from "../adapters/google-pay";
import { mapStripeServerError } from "../next/stripe-server";
import { mapPayPalRestError } from "../next/paypal-server";
import type { PaymentStatus, PayKitErrorCode } from "../types";

/**
 * This file is the mapping table from the README, executable.
 *
 * Normalising three vocabularies into one is the actual work of this library,
 * so the table is a test, not a comment that drifts.
 */

describe("Stripe → PaymentStatus", () => {
  const cases: Array<[string, PaymentStatus]> = [
    ["succeeded", "succeeded"],
    ["processing", "requires_action"],
    ["requires_action", "requires_action"],
    ["requires_confirmation", "requires_action"],
    ["requires_capture", "requires_action"],
    ["canceled", "cancelled"],
    ["requires_payment_method", "failed"],
    ["something_new_stripe_invented", "failed"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(mapStripeIntentStatus(input)).toBe(expected);
  });

  it("never reports an unsettled payment as succeeded", () => {
    // `processing` is the dangerous one: bank debits sit there for days.
    for (const s of ["processing", "requires_action", "requires_capture"]) {
      expect(mapStripeIntentStatus(s)).not.toBe("succeeded");
    }
  });
});

describe("Stripe → PayKitErrorCode", () => {
  const cases: Array<[string, PayKitErrorCode]> = [
    ["card_error", "declined"],
    ["validation_error", "declined"],
    ["api_connection_error", "network"],
    ["invalid_request_error", "config"],
    ["authentication_error", "config"],
    ["api_error", "sdk"],
    ["rate_limit_error", "sdk"],
    ["idempotency_error", "sdk"],
    ["a_type_that_does_not_exist", "unknown"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(mapStripeErrorCode(input)).toBe(expected);
  });

  it("maps the Node SDK's class-shaped errors too", () => {
    expect(mapStripeServerError({ type: "StripeCardError" })).toBe("declined");
    expect(mapStripeServerError({ type: "StripeConnectionError" })).toBe("network");
    expect(mapStripeServerError({ type: "StripeAuthenticationError" })).toBe("config");
    expect(mapStripeServerError({ type: "StripeAPIError" })).toBe("sdk");
    // rawType wins when both are present.
    expect(mapStripeServerError({ type: "StripeAPIError", rawType: "card_error" })).toBe("declined");
  });
});

describe("PayPal → PaymentStatus", () => {
  const cases: Array<[string, PaymentStatus]> = [
    ["COMPLETED", "succeeded"],
    ["REFUNDED", "succeeded"],
    ["PARTIALLY_REFUNDED", "succeeded"],
    ["CREATED", "requires_action"],
    ["SAVED", "requires_action"],
    ["APPROVED", "requires_action"],
    ["PENDING", "requires_action"],
    ["PAYER_ACTION_REQUIRED", "requires_action"],
    ["VOIDED", "cancelled"],
    ["DECLINED", "failed"],
    ["FAILED", "failed"],
    ["", "failed"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(mapPayPalStatus(input)).toBe(expected);
  });

  it("does not treat APPROVED as paid", () => {
    // The customer finished in the PayPal window, but nothing is captured.
    expect(mapPayPalStatus("APPROVED")).toBe("requires_action");
  });

  it("is case-insensitive", () => {
    expect(mapPayPalStatus("completed")).toBe("succeeded");
  });
});

describe("PayPal → PayKitErrorCode", () => {
  const cases: Array<[string, PayKitErrorCode]> = [
    ["INSTRUMENT_DECLINED", "declined"],
    ["Detected popup close", "cancelled"],
    ["Window closed before response", "cancelled"],
    ["Failed to fetch", "network"],
    ["Request timeout", "network"],
    ["Invalid client-id", "config"],
    ["CURRENCY_NOT_SUPPORTED", "config"],
    ["Expected an order id to be passed", "config"],
    ["zoinks", "sdk"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(mapPayPalErrorCode(input)).toBe(expected);
  });

  it("maps REST failures by status and issue", () => {
    expect(mapPayPalRestError(401, {})).toBe("config");
    expect(mapPayPalRestError(400, { name: "INVALID_REQUEST" })).toBe("config");
    expect(
      mapPayPalRestError(422, {
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "INSTRUMENT_DECLINED" }],
      }),
    ).toBe("declined");
    expect(mapPayPalRestError(503, {})).toBe("sdk");
  });
});

describe("Google Pay → PayKitErrorCode", () => {
  const cases: Array<[string | undefined, PayKitErrorCode]> = [
    ["CANCELED", "cancelled"],
    ["DEVELOPER_ERROR", "config"],
    ["MERCHANT_ACCOUNT_ERROR", "config"],
    ["BUYER_ACCOUNT_ERROR", "declined"],
    ["INTERNAL_ERROR", "sdk"],
    [undefined, "unknown"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(mapGooglePayErrorCode(input)).toBe(expected);
  });

  it("treats a dismissed sheet as a cancellation, not an error", () => {
    // Google reports the customer closing the sheet through the error channel.
    expect(mapGooglePayErrorCode("CANCELED")).toBe("cancelled");
  });
});
