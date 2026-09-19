import { type Money, PayKitError, type Provider } from "./types";

/**
 * Currencies whose minor-unit exponent is not 2.
 *
 * This matters more than it looks. Stripe takes minor units, but PayPal and
 * Google Pay take decimal strings — so "2499 JPY" is ¥2499, not ¥24.99, and
 * getting it wrong is a 100x charge. Anything not listed here is exponent 2.
 */
const EXPONENTS: Record<string, number> = {
  // Zero-decimal
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, JPY: 0, KMF: 0, KRW: 0, MGA: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/**
 * Throws unless `amount` is a clean integer count of minor units in a
 * plausible ISO 4217 currency. Called at the boundary of every adapter so a
 * bad amount fails before it reaches a provider, not after.
 */
export function assertMoney(amount: unknown, provider: Provider): asserts amount is Money {
  const bad = (why: string) =>
    new PayKitError(provider, "config", `Invalid amount: ${why}`, amount);

  if (typeof amount !== "object" || amount === null) throw bad("expected a Money object");
  const { value, currency } = amount as Partial<Money>;

  if (typeof value !== "number" || !Number.isFinite(value)) throw bad("value must be a finite number");
  if (!Number.isInteger(value)) {
    throw bad(`value must be an integer in minor units (got ${value} — did you mean ${Math.round(value * 100)}?)`);
  }
  if (value < 0) throw bad("value must not be negative");
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    throw bad(`currency must be a 3-letter ISO 4217 code (got ${String(currency)})`);
  }
}

/** 2499 USD → "24.99". 2499 JPY → "2499". For PayPal and Google Pay. */
export function toDecimalString(amount: Money): string {
  const exp = currencyExponent(amount.currency);
  if (exp === 0) return String(amount.value);
  const sign = amount.value < 0 ? "-" : "";
  const digits = String(Math.abs(amount.value)).padStart(exp + 1, "0");
  return `${sign}${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

/** "24.99" USD → 2499. The inverse, for reading amounts back off a provider. */
export function fromDecimalString(value: string, currency: string): Money {
  const exp = currencyExponent(currency);
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new PayKitError("paypal", "unknown", `Unparseable amount "${value}"`, value);
  }
  return { value: Math.round(n * 10 ** exp), currency: currency.toUpperCase() };
}

/** Display only. Never feed the output of this back into a charge. */
export function formatMoney(amount: Money, locale?: string): string {
  const exp = currencyExponent(amount.currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: amount.currency.toUpperCase(),
    }).format(amount.value / 10 ** exp);
  } catch {
    return `${toDecimalString(amount)} ${amount.currency.toUpperCase()}`;
  }
}

export function normalizeMoney(amount: Money): Money {
  return { value: amount.value, currency: amount.currency.toUpperCase() };
}
