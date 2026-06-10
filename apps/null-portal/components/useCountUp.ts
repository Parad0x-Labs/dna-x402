"use client";

import { useEffect, useRef, useState } from "react";

/**
 * useCountUp — animates a numeric value from `from` → `to` once the element is
 * scrolled into view. Returns [value, ref]. Honors prefers-reduced-motion by
 * snapping straight to `to`. Used by the cost counter + stat numerals.
 */
export function useCountUp(
  to: number,
  { from = 0, duration = 1400 }: { from?: number; duration?: number } = {},
) {
  const [value, setValue] = useState(from);
  const ref = useRef<HTMLElement | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const run = () => {
      if (started.current) return;
      started.current = true;
      if (reduce) {
        setValue(to);
        return;
      }
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / duration);
        // easeOutCubic — fast then settles, reads as a real ledger tally.
        const eased = 1 - Math.pow(1 - p, 3);
        setValue(from + (to - from) * eased);
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            run();
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [to, from, duration]);

  return [value, ref] as const;
}
