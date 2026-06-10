"use client";

import { useEffect, useRef, type ElementType, type ReactNode } from "react";

/**
 * Reveal — wraps children in a scroll-reveal container that fades + lifts into
 * view once, using the brand ease (see .reveal in globals.css). Pure CSS does
 * the motion; this only toggles the `.is-in` class via IntersectionObserver and
 * is a no-op under prefers-reduced-motion (the CSS guard shows content anyway).
 */
export function Reveal({
  children,
  as: Tag = "div",
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // If the observer never fires (e.g. SSR edge), the element still shows
    // because we add is-in on intersect and the reduced-motion CSS forces it.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      className={`reveal ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
