// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: labs-toc-v1
"use client";

import { useEffect, useState } from "react";

const MODULE_REVISION = "labs-toc-v1";
console.log(`[LabsToc] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

export interface TocItem {
  text: string;
  slug: string;
  depth: number; // 1 = post title, 2 = h2, 3 = h3
}

/**
 * Sticky "On this page" heading menu for the Labs pages. Anchors line up with the
 * ids rehype-slug stamps on the rendered headings; the active item is highlighted
 * as you scroll via an IntersectionObserver watching those headings.
 */
export function LabsToc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    if (!items.length) return;
    const els = items
      .map((i) => document.getElementById(i.slug))
      .filter((e): e is HTMLElement => Boolean(e));
    if (!els.length) return;

    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // Activate a heading as it nears the top; keep the last one active while the
      // reader is deep in a section (nothing else is intersecting the top band).
      { rootMargin: "-72px 0px -70% 0px", threshold: 0 }
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [items]);

  if (!items.length) return null;

  return (
    <nav aria-label="On this page" style={{ fontSize: "0.8125rem", lineHeight: 1.4 }}>
      <p
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontSize: "0.7rem",
          fontWeight: 600,
          color: "var(--foreground-subtle)",
          margin: "0 0 0.75rem 0",
          paddingLeft: "0.85rem",
        }}
      >
        On this page
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {items.map((i) => {
          const isActive = active === i.slug;
          return (
            <li key={i.slug}>
              <a
                href={`#${i.slug}`}
                style={{
                  display: "block",
                  padding: "0.28rem 0",
                  paddingLeft:
                    i.depth >= 3 ? "1.75rem" : i.depth === 2 ? "0.85rem" : "0.85rem",
                  marginLeft: "-1px",
                  borderLeft: `2px solid ${isActive ? "var(--accent-primary, #fbbf24)" : "transparent"}`,
                  color: isActive
                    ? "var(--foreground)"
                    : "var(--foreground-subtle)",
                  fontWeight: i.depth === 1 ? 600 : 400,
                  textDecoration: "none",
                  transition: "color 0.12s ease",
                }}
              >
                {i.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
