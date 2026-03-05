// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: blog-v3-json-bundle
// Blog posts are bundled into src/data/blog-posts.json at build time by
// scripts/build-blog.mjs (runs via prebuild). This avoids fs at runtime,
// which is unavailable in Cloudflare Workers.

import postsData from "@/data/blog-posts.json";

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  description: string;
  author?: string | null;
  coverImage?: string | null;
  content: string;
}

export type BlogPostMeta = Omit<BlogPost, "content">;

const posts = postsData as BlogPost[];

export function getAllPosts(): BlogPostMeta[] {
  return posts.map(({ slug, title, date, description, author, coverImage }) => ({
    slug,
    title,
    date,
    description,
    author,
    coverImage,
  }));
}

export function getPost(slug: string): BlogPost | null {
  return posts.find((p) => p.slug === slug) ?? null;
}
