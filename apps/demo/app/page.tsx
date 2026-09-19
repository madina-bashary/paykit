import { Checkout } from "./checkout";
import { DEFAULT_CART, getCart } from "@/lib/cart";

export default function Home() {
  const cart = getCart(DEFAULT_CART);

  return (
    <main className="page">
      <div className="card">
        <div className="brand">
          <h1>paykit</h1>
          <span className="badge">sandbox</span>
        </div>

        <div className="line">
          <div>
            <div className="name">{cart.name}</div>
            <div className="detail">{cart.detail}</div>
          </div>
          <div className="price">
            {(cart.total.value / 100).toFixed(2)} {cart.total.currency}
          </div>
        </div>

        {/*
          The amount below is for display. The server recomputes it from the
          cart id in `resolveAmount` before it charges anything.
        */}
        <Checkout cartId={DEFAULT_CART} amount={cart.total} />
      </div>
    </main>
  );
}
