"use client";

import { useEffect, useState } from "react";

/**
 * TypedNames — a typewriter that cycles a list of .null names in the hero, the
 * sanctioned marketing-section motion (DESIGN_SYSTEM §6). Mono, accent, with the
 * blinking caret. Snaps to the first name and stops under reduced-motion.
 */
const NAMES = ["parad0x", "vault", "agent47", "shop", "yourname"];

const TYPE_MS = 90;
const DELETE_MS = 45;
const HOLD_MS = 1300;

export function TypedNames() {
  const [text, setText] = useState("");
  const [i, setI] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setText(NAMES[0]);
      return;
    }

    const full = NAMES[i];
    let delay = deleting ? DELETE_MS : TYPE_MS;

    if (!deleting && text === full) {
      delay = HOLD_MS;
    } else if (deleting && text === "") {
      setDeleting(false);
      setI((p) => (p + 1) % NAMES.length);
      return;
    }

    const t = setTimeout(() => {
      if (!deleting && text === full) {
        setDeleting(true);
        return;
      }
      const next = deleting
        ? full.slice(0, text.length - 1)
        : full.slice(0, text.length + 1);
      setText(next);
    }, delay);

    return () => clearTimeout(t);
  }, [text, deleting, i]);

  return (
    <span className="text-acc">
      {text}
      <span className="caret" />
    </span>
  );
}
