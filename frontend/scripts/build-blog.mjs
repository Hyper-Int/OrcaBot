#!/usr/bin/env node
// Generates src/data/blog-posts.json from content/blog/*.md at build time.
// This is required because Cloudflare Workers have no filesystem at runtime.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = path.join(__dirname, "../content/blog");
const OUTPUT = path.join(__dirname, "../src/data/blog-posts.json");

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw };

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(": ");
    if (colonIdx > 0) {
      frontmatter[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 2).trim();
    }
  }
  return { frontmatter, content: match[2] };
}

if (!fs.existsSync(BLOG_DIR)) {
  console.log("[build-blog] No content/blog directory found, writing empty posts.");
  fs.writeFileSync(OUTPUT, JSON.stringify([]));
  process.exit(0);
}

const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md")).sort().reverse();

const posts = files.map((file) => {
  const slug = file.replace(/\.md$/, "");
  const raw = fs.readFileSync(path.join(BLOG_DIR, file), "utf-8");
  const { frontmatter, content } = parseFrontmatter(raw);
  return {
    slug,
    title: frontmatter.title || slug,
    date: frontmatter.date || "",
    description: frontmatter.description || "",
    author: frontmatter.author || null,
    coverImage: frontmatter.coverImage || null,
    content,
  };
});

fs.writeFileSync(OUTPUT, JSON.stringify(posts, null, 2));
console.log(`[build-blog] Wrote ${posts.length} post(s) to src/data/blog-posts.json`);
