import { describe, expect, it } from "vitest";
import { PayKitError } from "../types";

describe("PayKitError", () => {
  it("is a real Error with the provider and code attached", () => {
    const error = new PayKitError("stripe", "declined", "Your card was declined.", { a: 1 });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PayKitError);
    expect(error.name).toBe("PayKitError");
    expect(error.provider).toBe("stripe");
    expect(error.code).toBe("declined");
    expect(error.raw).toEqual({ a: 1 });
  });

  it("knows which failures are worth retrying", () => {
    expect(new PayKitError("stripe", "network", "x").retryable).toBe(true);
    expect(new PayKitError("stripe", "declined", "x").retryable).toBe(true);
    expect(new PayKitError("stripe", "config", "x").retryable).toBe(false);
    expect(new PayKitError("stripe", "cancelled", "x").retryable).toBe(false);
  });

  it("passes an existing PayKitError through untouched", () => {
    const original = new PayKitError("paypal", "config", "nope");
    expect(PayKitError.from("stripe", original)).toBe(original);
  });

  it("wraps anything else as unknown, keeping the original on .raw", () => {
    const cause = new TypeError("boom");
    const wrapped = PayKitError.from("googlePay", cause);
    expect(wrapped.code).toBe("unknown");
    expect(wrapped.provider).toBe("googlePay");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.raw).toBe(cause);

    expect(PayKitError.from("stripe", "just a string").message).toBe("just a string");
  });
});
