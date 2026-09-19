import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "paykit — one button, three providers",
  description:
    "Stripe, PayPal and Google Pay behind one React component, one result type and one error type.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
