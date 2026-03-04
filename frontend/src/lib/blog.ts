// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: blog-v2-full-content

import fs from "fs";
import path from "path";

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  description: string;
  author?: string;
  coverImage?: string;
  content: string;
}

export type BlogPostMeta = Omit<BlogPost, "content">;

const BLOG_DIR = path.join(process.cwd(), "content/blog");

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  content: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(": ");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 2).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, content: match[2] };
}

export function getAllPosts(): BlogPostMeta[] {
  if (!fs.existsSync(BLOG_DIR)) return [];

  const files = fs
    .readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();

  return files.map((file) => {
    const slug = file.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(BLOG_DIR, file), "utf-8");
    const { frontmatter } = parseFrontmatter(raw);
    return {
      slug,
      title: frontmatter.title || slug,
      date: frontmatter.date || "",
      description: frontmatter.description || "",
      author: frontmatter.author,
      coverImage: frontmatter.coverImage,
    };
  });
}

export function getPost(slug: string): BlogPost | null {
  const filePath = path.join(BLOG_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, content } = parseFrontmatter(raw);

  return {
    slug,
    title: frontmatter.title || slug,
    date: frontmatter.date || "",
    description: frontmatter.description || "",
    author: frontmatter.author,
    coverImage: frontmatter.coverImage,
    content,
  };
}
