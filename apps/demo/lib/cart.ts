import type { Money } from "paykit";

/**
 * Stands in for your database.
 *
 * The only thing that matters here: the price lives on the server, keyed by an
 * id the browser is allowed to know. The browser sends "demo-cart", not 2499.
 */
const CATALOG = {
  "demo-cart": {
    name: "paykit tee",
    detail: "Heavyweight cotton · ships worldwide",
    total: { value: 2499, currency: "USD" } as Money,
  },
} as const;

export type CartId = keyof typeof CATALOG;
export const DEFAULT_CART: CartId = "demo-cart";

export function getCart(cartId: string) {
  return CATALOG[cartId as CartId] ?? CATALOG[DEFAULT_CART];
}

export function getCartTotal(cartId: string): Money {
  return getCart(cartId).total;
}
