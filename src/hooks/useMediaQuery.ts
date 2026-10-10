import { useSyncExternalStore } from "react";

/** Live CSS media query. Where `matchMedia` does not exist (tests), `fallback` is used. */
export function useMediaQuery(query: string, fallback = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}
