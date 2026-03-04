// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: blog-v3-anchors

import { getPost, getAllPosts } from "@/lib/blog";
import ReactMarkdown from "react-markdown";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blog - OrcaBot",
  description:
    "Updates, insights, and behind-the-scenes from the OrcaBot team.",
};

// Strip leading date prefix (YYYY-MM-DD-) from slug for clean anchors
function slugToAnchor(slug: string): string {
  return slug.replace(/^\d{4}-\d{2}-\d{2}-/, "");
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

export default function BlogIndexPage() {
  const metas = getAllPosts();
  const posts = metas.map((m) => getPost(m.slug)).filter(Boolean);

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 pb-24">
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
          Blog
        </h1>
        <p className="text-[var(--foreground-muted)]" style={{ fontSize: "1rem" }}>
          Updates, insights, and behind-the-scenes from the OrcaBot team.
        </p>
      </div>

      {posts.length === 0 ? (
        <p className="text-[var(--foreground-muted)]" style={{ fontSize: "0.95rem" }}>
          No posts yet — check back soon.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "5rem" }}>
          {posts.map((post) => (
            <article key={post!.slug} id={slugToAnchor(post!.slug)}>
              {post!.coverImage && (
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
              )}

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
                    href={`#${slugToAnchor(post!.slug)}`}
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
                <ReactMarkdown>{post!.content}</ReactMarkdown>
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
    </div>
  );
}
