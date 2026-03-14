// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: docs-slug-v1-initial

import { notFound } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import type { Metadata } from "next";
import { allDocs, getDoc, getDocsByCategory } from "@/docs";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return Object.keys(allDocs).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) return {};
  return {
    title: `${doc.title} - OrcaBot Docs`,
    description: doc.summary,
  };
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) notFound();

  // Find prev/next in same category
  const siblings = getDocsByCategory(doc.category);
  const idx = siblings.findIndex((d) => d.slug === doc.slug);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx < siblings.length - 1 ? siblings[idx + 1] : null;

  return (
    <div>
      {/* Breadcrumb */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: "0.75rem",
          color: "rgba(255,255,255,0.4)",
          marginBottom: "1.25rem",
        }}
      >
        <Link
          href="/docs"
          style={{ color: "rgba(255,255,255,0.5)", textDecoration: "none" }}
        >
          Docs
        </Link>
        <span>›</span>
        <span style={{ textTransform: "capitalize" }}>
          {doc.category.replace("-", " ")}
        </span>
        <span>›</span>
        <span style={{ color: "rgba(255,255,255,0.7)" }}>{doc.title}</span>
      </div>

      {/* Title */}
      <h1
        style={{
          fontSize: "1.5rem",
          fontWeight: 700,
          lineHeight: 1.2,
          marginBottom: "0.5rem",
        }}
      >
        {doc.title}
      </h1>
      <p
        style={{
          fontSize: "0.9rem",
          color: "rgba(255,255,255,0.55)",
          lineHeight: 1.5,
          marginBottom: "1.5rem",
        }}
      >
        {doc.summary}
      </p>

      {/* Quick setup card */}
      <div
        style={{
          padding: "1rem 1.25rem",
          borderRadius: 10,
          border: "1px solid rgba(59,130,246,0.2)",
          backgroundColor: "rgba(59,130,246,0.05)",
          marginBottom: "2rem",
        }}
      >
        <p
          style={{
            fontSize: "0.7rem",
            fontWeight: 600,
            color: "#3b82f6",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: 8,
          }}
        >
          Quick Setup
        </p>
        <ol
          style={{
            margin: 0,
            paddingLeft: "1.25rem",
            listStyleType: "decimal",
          }}
        >
          {doc.quickHelp.map((step, i) => (
            <li
              key={i}
              style={{
                fontSize: "0.82rem",
                color: "rgba(255,255,255,0.8)",
                lineHeight: 1.5,
                marginBottom: 4,
              }}
            >
              {step}
            </li>
          ))}
        </ol>
      </div>

      {/* Full body */}
      <div className="docs-content">
        <style
          dangerouslySetInnerHTML={{
            __html: `
          .docs-content h2 {
            font-size: 1.15rem;
            font-weight: 600;
            color: #ffffff;
            margin-top: 2rem;
            margin-bottom: 0.75rem;
            padding-bottom: 0.4rem;
            border-bottom: 1px solid rgba(255,255,255,0.08);
          }
          .docs-content h3 {
            font-size: 0.95rem;
            font-weight: 600;
            color: rgba(255,255,255,0.9);
            margin-top: 1.5rem;
            margin-bottom: 0.5rem;
          }
          .docs-content p {
            font-size: 0.85rem;
            color: rgba(255,255,255,0.65);
            line-height: 1.6;
            margin-bottom: 0.75rem;
          }
          .docs-content ul, .docs-content ol {
            font-size: 0.85rem;
            color: rgba(255,255,255,0.65);
            line-height: 1.6;
            margin-bottom: 0.75rem;
            padding-left: 1.5rem;
          }
          .docs-content li {
            margin-bottom: 0.25rem;
          }
          .docs-content strong {
            color: rgba(255,255,255,0.85);
            font-weight: 600;
          }
          .docs-content code {
            font-size: 0.78rem;
            background: rgba(255,255,255,0.06);
            padding: 2px 6px;
            border-radius: 4px;
            color: #e2e8f0;
          }
          .docs-content a {
            color: #3b82f6;
            text-decoration: none;
          }
          .docs-content a:hover {
            text-decoration: underline;
          }
          .docs-content blockquote {
            border-left: 3px solid rgba(59,130,246,0.4);
            padding-left: 1rem;
            margin: 1rem 0;
            color: rgba(255,255,255,0.55);
          }
        `,
          }}
        />
        <ReactMarkdown>{doc.body}</ReactMarkdown>
      </div>

      {/* Prev / Next navigation */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: "3rem",
          paddingTop: "1.5rem",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          gap: "1rem",
        }}
      >
        {prev ? (
          <Link
            href={`/docs/${prev.slug}`}
            style={{
              display: "block",
              padding: "0.75rem 1rem",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.1)",
              textDecoration: "none",
              flex: 1,
            }}
          >
            <span
              style={{
                fontSize: "0.7rem",
                color: "rgba(255,255,255,0.4)",
                display: "block",
                marginBottom: 2,
              }}
            >
              ← Previous
            </span>
            <span
              style={{
                fontSize: "0.82rem",
                color: "rgba(255,255,255,0.8)",
                fontWeight: 500,
              }}
            >
              {prev.title}
            </span>
          </Link>
        ) : (
          <div />
        )}
        {next ? (
          <Link
            href={`/docs/${next.slug}`}
            style={{
              display: "block",
              padding: "0.75rem 1rem",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.1)",
              textDecoration: "none",
              flex: 1,
              textAlign: "right",
            }}
          >
            <span
              style={{
                fontSize: "0.7rem",
                color: "rgba(255,255,255,0.4)",
                display: "block",
                marginBottom: 2,
              }}
            >
              Next →
            </span>
            <span
              style={{
                fontSize: "0.82rem",
                color: "rgba(255,255,255,0.8)",
                fontWeight: 500,
              }}
            >
              {next.title}
            </span>
          </Link>
        ) : (
          <div />
        )}
      </div>
    </div>
  );
}
