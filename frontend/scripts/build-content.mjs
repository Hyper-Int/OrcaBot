#!/usr/bin/env node
// Generates src/data/<section>-posts.json from content/<section>/*.md at build time.
// This is required because Cloudflare Workers have no filesystem at runtime.
//
// Sections share one parser — add a new entry below to add a section.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECTIONS = [
  { name: "blog", dir: "../content/blog", out: "../src/data/blog-posts.json" },
  { name: "labs", dir: "../content/labs", out: "../src/data/labs-posts.json" },
];

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

function buildSection({ name, dir, out }) {
  const contentDir = path.join(__dirname, dir);
  const output = path.join(__dirname, out);

  if (!fs.existsSync(contentDir)) {
    console.log(`[build-content] No ${dir} directory found, writing empty ${name} posts.`);
    fs.writeFileSync(output, JSON.stringify([]));
    return;
  }

  const files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".md")).sort().reverse();

  const posts = files.map((file) => {
    const slug = file.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
    const raw = fs.readFileSync(path.join(contentDir, file), "utf-8");
    const { frontmatter, content } = parseFrontmatter(raw);
    return {
      slug,
      title: frontmatter.title || slug,
      date: frontmatter.date || "",
      description: frontmatter.description || "",
      author: frontmatter.author || null,
      coverImage: frontmatter.coverImage || null,
      coverVideo: frontmatter.coverVideo || null,
      content,
    };
  });

  fs.writeFileSync(output, JSON.stringify(posts, null, 2));
  console.log(`[build-content] Wrote ${posts.length} ${name} post(s) to ${out.replace("../", "")}`);
}

for (const section of SECTIONS) {
  buildSection(section);
}
