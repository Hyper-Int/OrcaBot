// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: labs-v1-json-bundle
// Labs posts are bundled into src/data/labs-posts.json at build time by
// scripts/build-content.mjs (runs via prebuild). This avoids fs at runtime,
// which is unavailable in Cloudflare Workers.

import postsData from "@/data/labs-posts.json";

export interface TocHeading {
  depth: number; // 2 = h2, 3 = h3
  text: string;
  slug: string;
}

export interface LabsPost {
  slug: string;
  title: string;
  date: string;
  description: string;
  author?: string | null;
  coverImage?: string | null;
  coverVideo?: string | null;
  ogImage?: string | null;
  headings: TocHeading[];
  content: string;
}

export type LabsPostMeta = Omit<LabsPost, "content">;

const posts = postsData as LabsPost[];

export function getAllPosts(): LabsPostMeta[] {
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

export function getPost(slug: string): LabsPost | null {
  return posts.find((p) => p.slug === slug) ?? null;
}
