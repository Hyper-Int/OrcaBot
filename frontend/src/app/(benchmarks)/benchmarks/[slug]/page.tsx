// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: benchmarks-v1-post

import { getPost, getAllPosts } from "@/lib/benchmarks";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ScrollVideo } from "@/components/ScrollVideo";
import { BenchmarkToc } from "@/components/BenchmarkToc";
import { BenchmarkTabs } from "@/components/BenchmarkTabs";
import { MarkdownChart } from "@/components/charts/MarkdownChart";
import { SortableTable } from "@/components/SortableTable";

/** True when a markdown code fence is a chart directive (```chart). Defined here,
 *  in the server component, because a helper exported from the "use client"
 *  chart module would be a client reference and cannot be called during SSR. */
function isChartFence(className?: string): boolean {
  return typeof className === "string" && className.split(" ").includes("language-chart");
}

/** The fence language of a <pre>'s <code> child, as a class string. hast keeps
 *  className as an array, which isChartFence does not accept. */
function fenceLanguageOf(node: unknown): string {
  const kids = (node as { children?: unknown[] } | undefined)?.children;
  const first = kids?.[0] as
    | { tagName?: string; properties?: { className?: unknown } }
    | undefined;
  if (first?.tagName !== "code") return "";
  const cls = first.properties?.className;
  return Array.isArray(cls) ? cls.join(" ") : typeof cls === "string" ? cls : "";
}

const MODULE_REVISION = "benchmarks-v1-post";
console.log(`[benchmarks-post] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  // Social preview image: prefer the dedicated ogImage (a 1200×630 card), fall
  // back to coverImage. LinkedIn/Twitter only render raster images, so ogImage
  // must be a PNG/JPG, never an SVG.
  const images = post.ogImage
    ? [{ url: post.ogImage, width: 1200, height: 630, alt: post.title }]
    : post.coverImage
      ? [{ url: post.coverImage, alt: post.title }]
      : undefined;
  return {
    title: `${post.title} - OrcaBot Benchmarks`,
    description: post.description,
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      images,
    },
    twitter: {
      card: images ? "summary_large_image" : "summary",
      title: post.title,
      description: post.description,
      images: images?.map((i) => i.url),
    },
  };
}

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

export default async function BenchmarkPage({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  // Lead the side menu with the article title, then its headings.
  const tocItems = [
    { text: post.title, slug: post.slug, depth: 1 },
    ...(post.headings ?? []).map((h) => ({ text: h.text, slug: h.slug, depth: h.depth })),
  ];

  return (
    <div style={{ maxWidth: "80rem", margin: "0 auto", display: "flex", gap: "2.5rem" }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `@media (max-width: 1023px) { .benchmarks-toc-aside { display: none !important; } }`,
        }}
      />
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

      <div style={{ flex: 1, minWidth: 0, maxWidth: "60rem" }} className="px-6 py-12 pb-24">
      {/* Back link */}
      <div style={{ marginBottom: "2rem" }}>
        <Link
          href="/benchmarks"
          style={{
            fontSize: "0.85rem",
            color: "var(--foreground-muted)",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
          }}
        >
          ← All benchmarks
        </Link>
      </div>

      <BenchmarkTabs active={slug} />

      {/* Cover image/video */}
      {post.coverVideo ? (
        <div style={{ marginBottom: "2rem" }}>
          <ScrollVideo
            src={post.coverVideo}
            poster={post.coverImage ?? undefined}
            alt={post.title}
            style={{ maxHeight: "400px" }}
          />
        </div>
      ) : post.coverImage ? (
        <img
          src={post.coverImage}
          alt={post.title}
          style={{
            width: "100%",
            maxHeight: "400px",
            objectFit: "cover",
            borderRadius: "12px",
            display: "block",
            marginBottom: "2rem",
          }}
        />
      ) : null}

      {/* Post header */}
      <header style={{ marginBottom: "2.5rem" }}>
        {post.date && (
          <time
            dateTime={post.date}
            style={{
              fontSize: "0.75rem",
              color: "var(--foreground-subtle)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontWeight: 500,
              display: "block",
              marginBottom: "0.75rem",
            }}
          >
            {formatDate(post.date)}
          </time>
        )}
        <h1
          id={post.slug}
          style={{
            fontSize: "2rem",
            fontWeight: 700,
            color: "var(--foreground)",
            letterSpacing: "-0.02em",
            lineHeight: 1.2,
            marginBottom: "0.75rem",
            scrollMarginTop: "96px",
          }}
        >
          {post.title}
        </h1>
        {post.description && (
          <p
            style={{
              fontSize: "1.05rem",
              color: "var(--foreground-muted)",
              lineHeight: 1.6,
              marginBottom: "0.75rem",
            }}
          >
            {post.description}
          </p>
        )}
        {post.author && (
          <p
            style={{
              fontSize: "0.85rem",
              color: "var(--foreground-subtle)",
              margin: 0,
            }}
          >
            By {post.author}
          </p>
        )}
      </header>

      {/* Post body. A ```chart fence renders an interactive chart in place; every
          other fence falls through to normal code rendering. */}
      <article className="legal-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug]}
          components={{
            // Column headers sort the rows; see SortableTable.
            table: ({ node }) => <SortableTable node={node as never} />,
            // A chart fence is a React component, not code, so it must not stay
            // wrapped in <pre>: `white-space: pre` inherits into the chart and
            // stops captions and labels wrapping, running them off the page.
            pre({ node, children, ...props }) {
              if (isChartFence(fenceLanguageOf(node))) return <>{children}</>;
              return <pre {...props}>{children}</pre>;
            },
            // `node` is react-markdown's hast node; strip it so it never lands
            // on the DOM element as an unknown attribute.
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
          {post.content}
        </ReactMarkdown>
      </article>
      </div>
    </div>
  );
}
