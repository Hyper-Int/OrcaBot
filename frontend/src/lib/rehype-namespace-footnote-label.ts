// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: rehype-namespace-footnote-label-v1
// Namespaces the footnotes section label so several markdown documents can be
// rendered on one page without colliding.
//
// remark-rehype's `clobberPrefix` namespaces footnote references and definitions
// but NOT the section label: mdast-util-to-hast hardcodes `id: 'footnote-label'`
// AFTER spreading `footnoteLabelProperties`, so no option can override it, and
// every reference points at it with `aria-describedby="footnote-label"`. Two
// documents on a page therefore emit a duplicate id and nine references aiming
// at whichever one wins.
//
// Both halves must move together: renaming the id alone would leave every
// aria-describedby dangling, which is worse than the duplicate for a screen
// reader.

const LABEL_ID = "footnote-label";

interface HastLike {
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

/** Usage: rehypePlugins={[[rehypeNamespaceFootnoteLabel, { prefix: "slug--" }]]} */
export function rehypeNamespaceFootnoteLabel(options?: { prefix?: string }) {
  const prefix = options?.prefix ?? "";
  return (tree: HastLike): void => {
    if (!prefix) return;
    const walk = (node: HastLike): void => {
      const p = node.properties;
      if (p) {
        if (p.id === LABEL_ID) p.id = prefix + LABEL_ID;
        // hast uses the camelCased name, and mdast-util-to-hast writes it as a
        // LIST (`ariaDescribedBy: ['footnote-label']`) because aria-describedby
        // takes space-separated ids. Handle both shapes: an equality check
        // against the string silently matches nothing and leaves every
        // reference pointing at an id that no longer exists.
        const a = p.ariaDescribedBy;
        if (Array.isArray(a)) {
          p.ariaDescribedBy = a.map((v) => (v === LABEL_ID ? prefix + LABEL_ID : v));
        } else if (a === LABEL_ID) {
          p.ariaDescribedBy = prefix + LABEL_ID;
        }
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(tree);
  };
}
