"use client";

import type { CSSProperties, ReactNode } from "react";
import type { ButtonSize, ButtonTheme } from "./adapters/types";
import { usePayKit } from "./context";
import { formatMoney } from "./money";
import type { PayButtonStatus, Provider } from "./types";
import { usePayButton, type UsePayButtonResult } from "./use-pay-button";

const PADDING: Record<ButtonSize, string> = {
  sm: "7px 14px",
  md: "10px 18px",
  lg: "14px 22px",
};
const FONT_SIZE: Record<ButtonSize, string> = { sm: "13px", md: "14px", lg: "16px" };
const MIN_HEIGHT: Record<ButtonSize, string> = { sm: "32px", md: "40px", lg: "50px" };

export type PayButtonProps = {
  provider: Provider;
  size?: ButtonSize;
  theme?: ButtonTheme;
  /** Overrides the provider's default label, where the provider allows it. */
  label?: string;
  fullWidth?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Render-prop escape hatch. Gets the same object as `usePayButton`. */
  children?: (state: UsePayButtonResult) => ReactNode;
};

function defaultText(status: PayButtonStatus, label: string, amountLabel: string): string {
  switch (status) {
    case "idle":
    case "loading_sdk":
      return "Loading…";
    case "processing":
      return "Processing…";
    case "succeeded":
      return "Paid";
    case "failed":
      return "Try again";
    default:
      return `${label} · ${amountLabel}`;
  }
}

export function PayButton({
  provider,
  size = "md",
  theme = "light",
  label,
  fullWidth,
  className,
  style,
  children,
}: PayButtonProps) {
  const state = usePayButton(provider, { size, theme, label, fullWidth });

  if (children) return <>{children(state)}</>;

  // A button that can never complete is worse than no button. Google Pay on an
  // unsupported device is the case this exists for.
  if (state.status === "unavailable") return null;

  if (state.mode === "mounted") {
    return (
      <div
        ref={state.containerRef}
        className={className}
        style={{ width: fullWidth === false ? undefined : "100%", ...style }}
        data-paykit-provider={provider}
        data-paykit-status={state.status}
      />
    );
  }

  const disabled = state.status !== "ready" && state.status !== "failed" && state.status !== "cancelled";
  const dark = theme === "dark";

  return (
    <button
      type="button"
      className={className}
      data-paykit-provider={provider}
      data-paykit-status={state.status}
      disabled={disabled}
      aria-busy={state.status === "processing"}
      onClick={() => {
        // Errors are delivered through onError; an unhandled rejection here
        // would just be noise in the console.
        void state.pay().catch(() => {});
      }}
      style={{
        width: fullWidth === false ? undefined : "100%",
        minHeight: MIN_HEIGHT[size],
        padding: PADDING[size],
        fontSize: FONT_SIZE[size],
        fontWeight: 600,
        fontFamily: "inherit",
        lineHeight: 1.2,
        border: 0,
        borderRadius: "8px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        background: dark ? "#f2f2f4" : "#1a1a1e",
        color: dark ? "#1a1a1e" : "#ffffff",
        transition: "opacity .12s ease",
        ...style,
      }}
    >
      {defaultText(state.status, state.label, formatMoney(state.amount))}
    </button>
  );
}

export type PayButtonsProps = {
  size?: ButtonSize;
  theme?: ButtonTheme;
  fullWidth?: boolean;
  /** Gap between buttons. Any CSS length. */
  gap?: string;
  className?: string;
  style?: CSSProperties;
  /** Render a subset, in your own order. Defaults to every configured provider. */
  only?: Provider[];
};

/** Every configured provider, stacked. The 90% case. */
export function PayButtons({
  size = "md",
  theme = "light",
  fullWidth,
  gap = "10px",
  className,
  style,
  only,
}: PayButtonsProps) {
  const { configured } = usePayKit();
  const list = only ? only.filter((p) => configured.includes(p)) : configured;

  return (
    <div
      className={className}
      style={{ display: "flex", flexDirection: "column", gap, ...style }}
    >
      {list.map((provider) => (
        <PayButton
          key={provider}
          provider={provider}
          size={size}
          theme={theme}
          fullWidth={fullWidth}
        />
      ))}
    </div>
  );
}
