import type {
  AdapterContext,
  AdapterDefinition,
  AdapterEvents,
  AdapterInstance,
  ButtonStyle,
} from "./adapters/types";
import type { PayKitCallbacks } from "./context";
import {
  type PayButtonStatus,
  PayKitError,
  type PaymentResult,
  type Provider,
} from "./types";

export type ProviderState = {
  status: PayButtonStatus;
  error: PayKitError | null;
  result: PaymentResult | null;
  /** Null until the SDK has loaded. Lives in state so subscribers react to it. */
  instance: AdapterInstance | null;
};

const IDLE: ProviderState = { status: "idle", error: null, result: null, instance: null };

/**
 * One state machine per provider, per `<PayKitProvider>`.
 *
 * It lives outside React because two components asking about the same provider
 * must get the same answer. Giving each `usePayButton("stripe")` call its own
 * state loads Stripe.js twice and lets a status indicator disagree with the
 * button next to it — which is exactly the kind of quiet wrongness that makes
 * people stop trusting an abstraction.
 *
 * Owning the callbacks here also means a result fires `onSuccess` once, no
 * matter how many components are subscribed.
 */
export class ProviderStore {
  #state: ProviderState = IDLE;
  #listeners = new Set<() => void>();
  #loading: Promise<void> | null = null;

  constructor(
    readonly provider: Provider,
    private readonly definition: AdapterDefinition<unknown>,
    private readonly config: unknown,
    private readonly context: AdapterContext,
    private readonly callbacks: { current: PayKitCallbacks },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): ProviderState => this.#state;

  #set(next: Partial<ProviderState>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }

  /** Loads the SDK at most once, however many components ask. */
  ensureLoaded(): Promise<void> {
    if (this.#loading) return this.#loading;

    this.#loading = (async () => {
      if (this.config == null) {
        this.#set({
          status: "unavailable",
          error: new PayKitError(
            this.provider,
            "config",
            `"${this.provider}" is not configured on <PayKitProvider providers={{…}}>.`,
          ),
        });
        return;
      }

      this.#set({ status: "loading_sdk", error: null, result: null });
      try {
        const instance = await this.definition.create(this.config, this.context);
        const available = await instance.isAvailable();
        this.#set({
          status: available ? "ready" : "unavailable",
          error: null,
          result: null,
          instance,
        });
      } catch (cause) {
        // Let a later retry try again rather than wedging on a transient
        // script-load failure.
        this.#loading = null;
        this.fail(cause);
      }
    })();

    return this.#loading;
  }

  fail(cause: unknown): void {
    const error = PayKitError.from(this.provider, cause);
    this.#set({ status: "failed", error });
    this.callbacks.current.onError?.(error);
  }

  reset(): void {
    if (this.#state.status === "unavailable") return;
    this.#set({
      status: this.#state.instance ? "ready" : "idle",
      error: null,
      result: null,
    });
  }

  readonly events: AdapterEvents = {
    onProcessing: () => this.#set({ status: "processing", error: null }),
    onResult: (result) => this.#route(result),
    onError: (error) => this.fail(error),
  };

  #route(result: PaymentResult): void {
    const cb = this.callbacks.current;
    cb.onResult?.(result);

    switch (result.status) {
      case "succeeded":
        this.#set({ status: "succeeded", error: null, result });
        cb.onSuccess?.(result);
        return;

      case "requires_action":
        // Deliberately stays in `processing`: the money is neither taken nor
        // refused, and a button that says "Paid" here would be lying.
        this.#set({ status: "processing", error: null, result });
        if (cb.onPending) cb.onPending(result);
        else if (process.env.NODE_ENV !== "production") {
          console.warn(
            `paykit: ${this.provider} returned "requires_action" and no onPending handler is set. ` +
              "This payment is not complete — resolve it with a webhook.",
          );
        }
        return;

      case "cancelled":
        this.#set({ status: "cancelled", error: null, result });
        cb.onCancel?.(result);
        // `cancelled → ready`: the customer may well try again, and leaving the
        // button disabled after a cancel is the bug every integration ships at
        // least once.
        setTimeout(() => {
          if (this.#state.status === "cancelled") this.#set({ status: "ready" });
        }, 0);
        return;

      case "failed": {
        const error = new PayKitError(
          result.provider,
          "declined",
          "The payment was not completed.",
          result.raw,
        );
        this.#set({ status: "failed", error, result });
        cb.onError?.(error);
        return;
      }
    }
  }

  async pay(style: ButtonStyle): Promise<void> {
    const { instance, status } = this.#state;
    if (!instance) {
      throw new PayKitError(
        this.provider,
        "sdk",
        `${this.provider} is not ready yet (status: ${status}).`,
      );
    }
    if (instance.mode !== "imperative" || !instance.pay) {
      throw new PayKitError(
        this.provider,
        "config",
        `${this.provider} renders its own button. Attach \`containerRef\` to a <div> instead of calling pay().`,
      );
    }
    if (status === "processing") return;
    this.#set({ error: null });
    await instance.pay(this.events, style);
  }

  async mount(el: HTMLElement, style: ButtonStyle): Promise<() => void> {
    const { instance } = this.#state;
    if (!instance?.mount) return () => {};
    return instance.mount(el, this.events, style);
  }
}
