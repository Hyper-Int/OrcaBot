// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: benchmarks-v1-json-bundle
// Benchmark pages are bundled into src/data/benchmarks-posts.json at build time
// by scripts/build-content.mjs (runs via prebuild). This avoids fs at runtime,
// which is unavailable in Cloudflare Workers.
//
// One markdown file == one BENCHMARK (not one run). Each file holds every
// monthly run as a section, newest first, so a benchmark has a single permanent
// URL whose history grows over time.

import postsData from "@/data/benchmarks-posts.json";

export interface TocHeading {
  depth: number; // 2 = h2, 3 = h3
  text: string;
  slug: string;
}

export interface Benchmark {
  slug: string;
  title: string;
  /** Date of the most recent run (drives "last updated"). */
  date: string;
  description: string;
  author?: string | null;
  coverImage?: string | null;
  coverVideo?: string | null;
  ogImage?: string | null;
  headings: TocHeading[];
  content: string;
}

export type BenchmarkMeta = Omit<Benchmark, "content">;

const posts = postsData as Benchmark[];

export function getAllPosts(): BenchmarkMeta[] {
  return posts.map(({ slug, title, date, description, author, coverImage, coverVideo, ogImage, headings }) => ({
    slug,
    title,
    date,
    description,
    author,
    coverImage,
    coverVideo,
    ogImage,
    headings: headings ?? [],
  }));
}

export function getPost(slug: string): Benchmark | null {
  return posts.find((p) => p.slug === slug) ?? null;
}
