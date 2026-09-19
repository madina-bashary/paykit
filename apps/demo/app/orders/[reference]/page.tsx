import Link from "next/link";

/**
 * Where `onSuccess={(r) => router.push(`/orders/${r.reference}`)}` lands.
 *
 * `reference` is the one normalised id: a Stripe PaymentIntent, a PayPal
 * Order, or the PaymentIntent a Google Pay token became.
 */
export default async function OrderPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;

  return (
    <main className="page">
      <div className="card">
        <div className="brand">
          <h1>Order confirmed</h1>
          <span className="badge">sandbox</span>
        </div>
        <div className="line">
          <div>
            <div className="name">Reference</div>
            <div className="detail">PaymentResult.reference</div>
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: "var(--code-bg)",
            borderRadius: 10,
            fontSize: 12,
            overflowX: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}
        >
          {decodeURIComponent(reference)}
        </pre>
        <p className="note">
          One id shape regardless of which button was pressed. <Link href="/">← Back</Link>
        </p>
      </div>
    </main>
  );
}
