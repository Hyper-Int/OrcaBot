// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: labs-v1-post

import { getPost, getAllPosts } from "@/lib/labs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ScrollVideo } from "@/components/ScrollVideo";
import { LabsToc } from "@/components/LabsToc";

const MODULE_REVISION = "labs-v1-post";
console.log(`[labs-post] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

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
    title: `${post.title} - OrcaBot Labs`,
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

export default async function LabsPostPage({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  // Lead the side menu with the article title, then its headings.
  const tocItems = [
    { text: post.title, slug: post.slug, depth: 1 },
    ...(post.headings ?? []).map((h) => ({ text: h.text, slug: h.slug, depth: h.depth })),
  ];

  return (
    <div style={{ maxWidth: "76rem", margin: "0 auto", display: "flex", gap: "2.5rem" }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `@media (max-width: 1023px) { .labs-toc-aside { display: none !important; } }`,
        }}
      />
      <aside
        className="labs-toc-aside"
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
        <LabsToc items={tocItems} />
      </aside>

      <div style={{ flex: 1, minWidth: 0, maxWidth: "44rem" }} className="px-6 py-12 pb-24">
      {/* Back link */}
      <div style={{ marginBottom: "2rem" }}>
        <Link
          href="/labs"
          style={{
            fontSize: "0.85rem",
            color: "var(--foreground-muted)",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
          }}
        >
          ← All Labs
        </Link>
      </div>

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

      {/* Post body */}
      <article className="legal-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>{post.content}</ReactMarkdown>
      </article>
      </div>
    </div>
  );
}
