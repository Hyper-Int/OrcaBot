// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: sortable-table-v1
// Makes markdown tables sortable by clicking a column header.
//
// It renders from the hast node rather than re-using react-markdown's rendered
// children: the children arrive across the server/client boundary as opaque
// nodes, so the row order cannot be rearranged. The hast node is plain
// serialisable data, so the client can reorder rows AND still render the inline
// formatting the cells contain (bold, italic, code, links).

import * as React from "react";

const MODULE_REVISION = "sortable-table-v1";
if (typeof window !== "undefined") {
  console.log(`[sortable-table] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const els = (n: HastNode | undefined, tag?: string) =>
  (n?.children ?? []).filter((c) => c.type === "element" && (!tag || c.tagName === tag));

/** Flatten a cell to plain text, for deriving its sort key. */
function textOf(n: HastNode): string {
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(textOf).join("");
}

/**
 * Sort key for a cell. Returns null for "no data" so those rows always sink to
 * the bottom whichever direction is active.
 *
 * Handles the notation these tables actually use: percentages, dollar amounts,
 * a unicode minus (−, not a hyphen), M/K magnitude suffixes, and "12.2 ± 0.4"
 * where only the leading figure should sort.
 */
function sortKey(raw: string): number | string | null {
  const t = raw.trim();
  if (!t || /^n\/a$/i.test(t)) return null;
  // A cell counts as numeric only when it STARTS with a number, not when it
  // merely contains one. "54.99%", "$0.54", "2.09M", "12.2 ± 0.4" and
  // "57.06% (v6)" are measurements; "baseline Codex 5.5" is a label that
  // happens to carry a version, and must sort as text.
  const norm = t.replace(/−/g, "-").replace(/,/g, "").replace(/^[$+]\s*/, "");
  const m = /^(-?\d+(?:\.\d+)?)\s*([MK])?/.exec(norm);
  if (!m) return t.toLowerCase();
  let v = parseFloat(m[1]);
  if (m[2] === "M") v *= 1e6;
  else if (m[2] === "K") v *= 1e3;
  return v;
}

/** Render the small inline vocabulary these tables use. */
function Inline({ nodes }: { nodes: HastNode[] }): React.ReactNode {
  return nodes.map((n, i) => {
    if (n.type === "text") return <React.Fragment key={i}>{n.value}</React.Fragment>;
    if (n.type !== "element") return null;
    const kids = <Inline nodes={n.children ?? []} />;
    switch (n.tagName) {
      case "strong": return <strong key={i}>{kids}</strong>;
      case "em": return <em key={i}>{kids}</em>;
      case "code": return <code key={i}>{kids}</code>;
      case "del": return <del key={i}>{kids}</del>;
      case "br": return <br key={i} />;
      case "a":
        return (
          <a key={i} href={String(n.properties?.href ?? "")} target="_blank" rel="noopener noreferrer">
            {kids}
          </a>
        );
      default: return <React.Fragment key={i}>{kids}</React.Fragment>;
    }
  });
}

const alignOf = (n: HastNode): React.CSSProperties => {
  const a = n.properties?.align;
  return a ? { textAlign: a as React.CSSProperties["textAlign"] } : {};
};

export function SortableTable({ node }: { node: HastNode }) {
  const thead = els(node, "thead")[0];
  const tbody = els(node, "tbody")[0];
  const headCells = els(els(thead, "tr")[0], "th");
  const bodyRows = els(tbody, "tr");

  const [sort, setSort] = React.useState<{ col: number; dir: "asc" | "desc" } | null>(null);

  const rows = React.useMemo(() => {
    const indexed = bodyRows.map((r, i) => ({ r, i }));
    if (!sort) return indexed;
    const keyed = indexed.map((x) => ({ ...x, k: sortKey(textOf(els(x.r, "td")[sort.col] ?? { type: "text", value: "" })) }));
    keyed.sort((a, b) => {
      // "no data" sinks in both directions rather than pretending to be zero.
      if (a.k === null && b.k === null) return a.i - b.i;
      if (a.k === null) return 1;
      if (b.k === null) return -1;
      const cmp =
        typeof a.k === "number" && typeof b.k === "number"
          ? a.k - b.k
          : String(a.k).localeCompare(String(b.k));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return keyed;
  }, [bodyRows, sort]);

  const onHeader = (col: number) => {
    // Numeric columns open descending (best first, which is how these tables
    // already read); text columns open ascending. Third click clears the sort.
    const firstBodyCell = els(bodyRows[0], "td")[col];
    const numeric = firstBodyCell ? typeof sortKey(textOf(firstBodyCell)) === "number" : false;
    setSort((s) => {
      if (!s || s.col !== col) return { col, dir: numeric ? "desc" : "asc" };
      if (s.dir === (numeric ? "desc" : "asc")) return { col, dir: numeric ? "asc" : "desc" };
      return null;
    });
  };

  return (
    <table>
      <thead>
        <tr>
          {headCells.map((th, i) => {
            const active = sort?.col === i;
            return (
              <th
                key={i}
                style={{ ...alignOf(th), whiteSpace: "nowrap", padding: 0 }}
                aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
              >
                {/* A real button, not a click handler on the <th>: a th is not
                    focusable, so keyboard users could not sort at all. */}
                <button
                  type="button"
                  onClick={() => onHeader(i)}
                  title="Sort by this column"
                  style={{
                    font: "inherit",
                    color: "inherit",
                    background: "none",
                    border: "none",
                    // Matches .legal-content th padding, which is moved onto the
                    // button so the whole cell stays a hit target.
                    padding: "0.625rem 0.75rem",
                    margin: 0,
                    width: "100%",
                    textAlign: "inherit",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <Inline nodes={th.children ?? []} />
                  <span aria-hidden="true" style={{ opacity: active ? 0.95 : 0.32, marginLeft: "0.3rem", fontSize: "0.8em" }}>
                    {active ? (sort!.dir === "asc" ? "▲" : "▼") : "⇅"}
                  </span>
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ r, i }) => (
          <tr key={i}>
            {els(r, "td").map((td, j) => (
              <td key={j} style={alignOf(td)}>
                <Inline nodes={td.children ?? []} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
