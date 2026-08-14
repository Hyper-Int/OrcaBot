// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: benchmark-tabs-v1
// Switches between benchmarks. The tabs are real links to each benchmark's own
// URL rather than client-side state, so every benchmark stays deep-linkable,
// keeps its own social card, and renders exactly one post per page (which is
// also what keeps heading ids unique).

import Link from "next/link";

const MODULE_REVISION = "benchmark-tabs-v1";
console.log(`[benchmark-tabs] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/** Display order and labels. Slugs match content/benchmarks/<slug>.md. */
export const BENCHMARK_TABS = [
  { slug: "agent-skills", label: "Agent Skills" },
  { slug: "open-weight-tts", label: "Open Weight TTS" },
] as const;

/** The benchmark shown at /benchmarks. */
export const DEFAULT_BENCHMARK = BENCHMARK_TABS[0].slug;

export function BenchmarkTabs({ active }: { active: string }) {
  return (
    <nav
      aria-label="Benchmarks"
      style={{
        display: "flex",
        gap: "0.4rem",
        flexWrap: "wrap",
        marginBottom: "2rem",
        borderBottom: "1px solid var(--border)",
        paddingBottom: "0.75rem",
      }}
    >
      {BENCHMARK_TABS.map((t) => {
        const isActive = t.slug === active;
        return (
          <Link
            key={t.slug}
            href={`/benchmarks/${t.slug}`}
            aria-current={isActive ? "page" : undefined}
            style={{
              padding: "0.4rem 0.9rem",
              borderRadius: 999,
              fontSize: "0.9rem",
              fontWeight: isActive ? 600 : 500,
              textDecoration: "none",
              color: isActive ? "var(--foreground)" : "var(--foreground-muted)",
              background: isActive ? "var(--background-elevated)" : "transparent",
              border: `1px solid ${isActive ? "var(--border-strong)" : "transparent"}`,
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
