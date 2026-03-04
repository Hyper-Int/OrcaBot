// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: blog-v1-post

import { getPost, getAllPosts } from "@/lib/blog";
import ReactMarkdown from "react-markdown";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return {
    title: `${post.title} - OrcaBot Blog`,
    description: post.description,
    openGraph: post.coverImage
      ? { images: [{ url: post.coverImage }] }
      : undefined,
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

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 pb-24">
      {/* Back link */}
      <div style={{ marginBottom: "2rem" }}>
        <Link
          href="/blog"
          style={{
            fontSize: "0.85rem",
            color: "var(--foreground-muted)",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
          }}
        >
          ← All posts
        </Link>
      </div>

      {/* Cover image */}
      {post.coverImage && (
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
      )}

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
          style={{
            fontSize: "2rem",
            fontWeight: 700,
            color: "var(--foreground)",
            letterSpacing: "-0.02em",
            lineHeight: 1.2,
            marginBottom: "0.75rem",
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
        <ReactMarkdown>{post.content}</ReactMarkdown>
      </article>
    </div>
  );
}
