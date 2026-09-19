import { describe, expect, it } from "vitest";
import {
  assertMoney,
  currencyExponent,
  formatMoney,
  fromDecimalString,
  toDecimalString,
} from "../money";
import { PayKitError } from "../types";

describe("currencyExponent", () => {
  it("defaults to 2", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("gbp")).toBe(2);
    expect(currencyExponent("XYZ")).toBe(2);
  });

  it("knows the zero- and three-decimal currencies", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KRW")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
  });
});

describe("toDecimalString", () => {
  it("converts minor units for PayPal and Google Pay", () => {
    expect(toDecimalString({ value: 2499, currency: "USD" })).toBe("24.99");
    expect(toDecimalString({ value: 5, currency: "USD" })).toBe("0.05");
    expect(toDecimalString({ value: 50, currency: "USD" })).toBe("0.50");
    expect(toDecimalString({ value: 0, currency: "USD" })).toBe("0.00");
    expect(toDecimalString({ value: 100000, currency: "USD" })).toBe("1000.00");
  });

  it("does not insert a decimal point into a zero-decimal currency", () => {
    // ¥2499, not ¥24.99. Getting this wrong is a 100x charge.
    expect(toDecimalString({ value: 2499, currency: "JPY" })).toBe("2499");
  });

  it("handles three-decimal currencies", () => {
    expect(toDecimalString({ value: 2499, currency: "KWD" })).toBe("2.499");
    expect(toDecimalString({ value: 5, currency: "BHD" })).toBe("0.005");
  });

  it("round-trips through fromDecimalString", () => {
    for (const [value, currency] of [
      [2499, "USD"],
      [1, "USD"],
      [2499, "JPY"],
      [123456, "KWD"],
    ] as const) {
      expect(fromDecimalString(toDecimalString({ value, currency }), currency)).toEqual({
        value,
        currency,
      });
    }
  });
});

describe("assertMoney", () => {
  it("accepts integers in minor units", () => {
    expect(() => assertMoney({ value: 2499, currency: "USD" }, "stripe")).not.toThrow();
    expect(() => assertMoney({ value: 0, currency: "usd" }, "stripe")).not.toThrow();
  });

  it("rejects floats, and says what the caller probably meant", () => {
    // The single most common integration bug: passing dollars.
    expect(() => assertMoney({ value: 24.99, currency: "USD" }, "stripe")).toThrow(/2499/);
  });

  it("rejects negatives, non-numbers and bad currency codes", () => {
    expect(() => assertMoney({ value: -1, currency: "USD" }, "stripe")).toThrow(PayKitError);
    expect(() => assertMoney({ value: NaN, currency: "USD" }, "stripe")).toThrow(PayKitError);
    expect(() => assertMoney({ value: 100, currency: "DOLLARS" }, "stripe")).toThrow(/ISO 4217/);
    expect(() => assertMoney(null, "stripe")).toThrow(PayKitError);
  });

  it("tags the error with the provider and a config code", () => {
    try {
      assertMoney({ value: 1.5, currency: "USD" }, "paypal");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PayKitError);
      expect((error as PayKitError).provider).toBe("paypal");
      expect((error as PayKitError).code).toBe("config");
    }
  });
});

describe("formatMoney", () => {
  it("formats for display", () => {
    expect(formatMoney({ value: 2499, currency: "USD" }, "en-US")).toBe("$24.99");
    expect(formatMoney({ value: 2499, currency: "JPY" }, "en-US")).toBe("¥2,499");
  });

  it("uses the code itself as the symbol for a currency Intl does not know", () => {
    // Intl accepts any well-formed 3-letter code and prints it verbatim.
    expect(formatMoney({ value: 2499, currency: "ZZZ" }, "en-US")).toContain("24.99");
  });

  it("falls back rather than throwing on a malformed code", () => {
    // Intl throws a RangeError here; display code must never take down a
    // checkout page.
    expect(formatMoney({ value: 2499, currency: "US" }, "en-US")).toBe("24.99 US");
  });
});
