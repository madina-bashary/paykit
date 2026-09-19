import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";

// Files tagged `@vitest-environment node` share this setup file, so everything
// DOM-shaped has to be guarded.
const hasDom = typeof document !== "undefined";

afterEach(async () => {
  if (hasDom) {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  }
  vi.clearAllMocks();
});

if (hasDom && typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame;
}
