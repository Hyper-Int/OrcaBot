// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: mobile-nav-v2-css-no-flash

"use client";

import { useState } from "react";
import Link from "next/link";

export interface NavLink {
  href: string;
  label: string;
}

interface MobileNavProps {
  links: NavLink[];
  /** Use absolute positioning for the dropdown (needed when header is position:fixed) */
  absolute?: boolean;
  dropdownBg?: string;
}

export function MobileNav({ links, absolute = false, dropdownBg = "#0b1a2e" }: MobileNavProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const dropdownStyle: React.CSSProperties = absolute
    ? { position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50 }
    : { position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50 };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        .mn-desktop { display: flex; gap: 1.5rem; align-items: center; }
        .mn-burger  { display: none; flex-direction: column; gap: 5px; background: none; border: none; cursor: pointer; padding: 4px; }
        @media (max-width: 639px) {
          .mn-desktop { display: none; }
          .mn-burger  { display: flex; }
        }
      ` }} />

      {/* Desktop nav — hidden on mobile via CSS */}
      <nav className="mn-desktop">
        {links.map((l) => (
          <Link key={l.href} href={l.href} style={{ fontSize: "0.8rem", color: "rgba(255,255,255,0.65)", textDecoration: "none" }}>
            {l.label}
          </Link>
        ))}
      </nav>

      {/* Burger — shown on mobile via CSS */}
      <button className="mn-burger" onClick={() => setMenuOpen((o) => !o)} aria-label="Toggle menu">
        <span style={{ display: "block", width: 22, height: 2, backgroundColor: "#ffffff", borderRadius: 2, transition: "transform 0.2s", transform: menuOpen ? "rotate(45deg) translate(0px, 7px)" : "none" }} />
        <span style={{ display: "block", width: 22, height: 2, backgroundColor: "#ffffff", borderRadius: 2, transition: "opacity 0.2s", opacity: menuOpen ? 0 : 1 }} />
        <span style={{ display: "block", width: 22, height: 2, backgroundColor: "#ffffff", borderRadius: 2, transition: "transform 0.2s", transform: menuOpen ? "rotate(-45deg) translate(0px, -7px)" : "none" }} />
      </button>

      {/* Dropdown */}
      {menuOpen && (
        <nav style={{ ...dropdownStyle, backgroundColor: dropdownBg, borderBottom: "1px solid rgba(255,255,255,0.1)", display: "flex", flexDirection: "column" }}>
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMenuOpen(false)}
              style={{ padding: "0.85rem 1.5rem", color: "rgba(255,255,255,0.8)", textDecoration: "none", fontSize: "0.9rem", borderTop: "1px solid rgba(255,255,255,0.07)" }}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
