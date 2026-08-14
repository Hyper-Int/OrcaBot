// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: benchmarks-v1-index

import { getPost } from "@/lib/benchmarks";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import type { Metadata } from "next";
import { BlogSubscribe } from "@/components/BlogSubscribe";
import { ScrollVideo } from "@/components/ScrollVideo";
import { BenchmarkToc, type TocItem } from "@/components/BenchmarkToc";
import { BenchmarkTabs, DEFAULT_BENCHMARK } from "@/components/BenchmarkTabs";
import { MarkdownChart } from "@/components/charts/MarkdownChart";
import { SortableTable } from "@/components/SortableTable";
import { rehypeNamespaceFootnoteLabel } from "@/lib/rehype-namespace-footnote-label";

/** True when a markdown code fence is a chart directive (```chart). Kept in the
 *  server component; a helper exported from the "use client" chart module would
 *  be a client reference and cannot be called during SSR. */
function isChartFence(className?: string): boolean {
  return typeof className === "string" && className.split(" ").includes("language-chart");
}

const MODULE_REVISION = "benchmarks-v1-index";
console.log(`[benchmarks-index] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

export const metadata: Metadata = {
  title: "OrcaBot Benchmarks",
  description:
    "Reproducible agent benchmarks, re-run every month. Every number links to the config that produced it.",
};

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function BenchmarksIndexPage() {
  // One benchmark per page. The tab bar navigates between them, so the index
  // shows the default rather than stacking every benchmark into one document.
  const posts = [getPost(DEFAULT_BENCHMARK)].filter(Boolean);

  // Table-of-contents items for the side menu: each post's title as a top-level
  // entry, followed by its headings.
  //
  // Heading ids are namespaced per post on this page. Every benchmark is rendered
  // through its OWN ReactMarkdown/rehype-slug instance, so the de-duplication
  // counter restarts for each one: a second benchmark with a "Methodology"
  // heading would emit a duplicate id, and every duplicate anchor would resolve
  // to the first post. The same prefix is passed to rehype-slug below so the
  // menu and the rendered ids agree.
  const tocItems: TocItem[] = posts.flatMap((post) => {
    const heads = (post!.headings ?? []).map((h) => ({
      text: h.text,
      slug: `${post!.slug}--${h.slug}`,
      depth: h.depth,
    }));
    return [{ text: post!.title, slug: post!.slug, depth: 1 }, ...heads];
  });

  return (
    <div style={{ maxWidth: "80rem", margin: "0 auto", display: "flex", gap: "2.5rem" }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `@media (max-width: 1023px) { .benchmarks-toc-aside { display: none !important; } }`,
        }}
      />
      {/* Heading side menu */}
      <aside
        className="benchmarks-toc-aside"
        style={{
          width: 232,
          flexShrink: 0,
          position: "sticky",
          top: 66,
          alignSelf: "flex-start",
          height: "calc(100vh - 66px)",
          overflowY: "auto",
          padding: "3.5rem 0",
        }}
      >
        <BenchmarkToc items={tocItems} />
      </aside>

      {/* Article column */}
      <div style={{ flex: 1, minWidth: 0, maxWidth: "60rem" }} className="px-6 py-12 pb-24">
      {/* Page header */}
      <div className="mb-16">
        <h1
          className="text-[var(--foreground)]"
          style={{
            fontSize: "2rem",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            marginBottom: "0.5rem",
          }}
        >
          OrcaBot Benchmarks
        </h1>
        <p className="text-[var(--foreground-muted)]" style={{ fontSize: "1rem" }}>
          Reproducible agent benchmarks, re-run every month so you can see model
          drift and plugin updates as they happen. Every run ships its full config.
        </p>
      </div>

      <BenchmarkTabs active={DEFAULT_BENCHMARK} />

      {posts.length === 0 ? (
        <p className="text-[var(--foreground-muted)]" style={{ fontSize: "0.95rem" }}>
          Nothing published yet. Check back soon.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "5rem" }}>
          {posts.map((post) => (
            <article key={post!.slug} id={post!.slug}>
              {post!.coverVideo ? (
                <div style={{ marginBottom: "2rem" }}>
                  <ScrollVideo
                    src={post!.coverVideo}
                    poster={post!.coverImage ?? undefined}
                    alt={post!.title}
                  />
                </div>
              ) : post!.coverImage ? (
                <img
                  src={post!.coverImage}
                  alt={post!.title}
                  style={{
                    width: "100%",
                    maxHeight: "360px",
                    objectFit: "cover",
                    borderRadius: "12px",
                    display: "block",
                    marginBottom: "2rem",
                  }}
                />
              ) : null}

              {/* Post header */}
              <header style={{ marginBottom: "2rem" }}>
                {post!.date && (
                  <time
                    dateTime={post!.date}
                    className="text-[var(--foreground-subtle)]"
                    style={{
                      fontSize: "0.75rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fontWeight: 500,
                      display: "block",
                      marginBottom: "0.5rem",
                    }}
                  >
                    {formatDate(post!.date)}
                  </time>
                )}
                <h2
                  style={{
                    fontSize: "1.75rem",
                    fontWeight: 700,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.2,
                    marginBottom: "0.5rem",
                  }}
                >
                  <a
                    href={`#${post!.slug}`}
                    className="text-[var(--foreground)] blog-title-anchor"
                  >
                    {post!.title}
                  </a>
                </h2>
                {post!.author && (
                  <p
                    className="text-[var(--foreground-subtle)]"
                    style={{ fontSize: "0.85rem", margin: 0 }}
                  >
                    By {post!.author}
                  </p>
                )}
              </header>

              {/* Post body */}
              <div className="legal-content">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  // Footnote ids are namespaced too: they are numbered from 1 per
                  // render, so a second benchmark would emit its own fn-1 and
                  // collide. clobberPrefix is a remark-rehype option (not a gfm
                  // one) and rewrites both the ids and the links pointing at them,
                  // so the pair stays self-consistent.
                  remarkRehypeOptions={{ clobberPrefix: `${post!.slug}--fn-` }}
                  // Namespaced per post; see the tocItems comment above.
                  rehypePlugins={[
                    [rehypeSlug, { prefix: `${post!.slug}--` }],
                    // clobberPrefix above misses the footnotes section label;
                    // see the plugin for why it cannot be done with an option.
                    [rehypeNamespaceFootnoteLabel, { prefix: `${post!.slug}--` }],
                  ]}
                  components={{
                    // Links written in the markdown point at bare heading ids
                    // ("#methodology"). Those ids are namespaced on this page, so
                    // the hrefs must be too, or every in-article cross-reference
                    // dead-ends here while working fine on the post's own page.
                    // Footnote links already carry the prefix and are left alone.
                    a: ({ href, children, node: _n, ...rest }) => {
                      const ns = `#${post!.slug}--`;
                      const to =
                        href && href.startsWith("#") && !href.startsWith(ns)
                          ? `${ns}${href.slice(1)}`
                          : href;
                      return (
                        <a href={to} {...rest}>
                          {children}
                        </a>
                      );
                    },
                    // Column headers sort the rows; see SortableTable.
                    table: ({ node }) => <SortableTable node={node as never} />,
                    // `node` is react-markdown's hast node; strip it so it never
                    // lands on the DOM element as an unknown attribute.
                    code({ className, children, node: _node, ...props }) {
                      if (isChartFence(className)) {
                        return <MarkdownChart id={String(children).trim()} />;
                      }
                      return (
                        <code className={className} {...props}>
                          {children}
                        </code>
                      );
                    },
                  }}
                >
                  {post!.content}
                </ReactMarkdown>
              </div>

              {/* Divider between posts */}
              <hr
                style={{
                  marginTop: "5rem",
                  border: "none",
                  borderTop: "1px solid var(--border)",
                }}
              />
            </article>
          ))}
        </div>
      )}

      {/* Subscribe form */}
      <div style={{ marginTop: "4rem" }}>
        <BlogSubscribe />
      </div>
      </div>
    </div>
  );
}
