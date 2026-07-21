#!/usr/bin/env node
// Generates src/data/<section>-posts.json from content/<section>/*.md at build time.
// This is required because Cloudflare Workers have no filesystem at runtime.
//
// Sections share one parser — add a new entry below to add a section.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import GithubSlugger from "github-slugger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECTIONS = [
  { name: "blog", dir: "../content/blog", out: "../src/data/blog-posts.json" },
  { name: "labs", dir: "../content/labs", out: "../src/data/labs-posts.json" },
];

// Extract ## and ### headings for a table-of-contents side menu. Skips fenced
// code blocks so a "## " inside a code sample isn't treated as a heading.
//
// Slugs are generated with the SAME library rehype-slug uses (github-slugger),
// fed the SAME text it sees on the rendered heading, so the TOC anchors line up
// with the ids stamped on the <h2>/<h3> — including footnote markers and the
// -1/-2 dedup suffixes. Footnotes are kept for the slug (github-slugger strips
// the [^ ] punctuation, leaving the number, e.g. "SWE-bench Pro [^8]" ->
// "swe-bench-pro-8") but dropped from the display text so the menu reads cleanly.
function extractHeadings(content) {
  const headings = [];
  const slugger = new GithubSlugger();
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const depth = m[1].length; // 2 or 3
    // Strip link/emphasis/code markup to the rendered text, but keep footnotes.
    const slugText = m[2]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "");
    const slug = slugger.slug(slugText);
    const text = slugText.replace(/\[\^[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
    headings.push({ depth, text, slug });
  }
  return headings;
}

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
      headings: extractHeadings(content),
      content,
    };
  });

  fs.writeFileSync(output, JSON.stringify(posts, null, 2));
  console.log(`[build-content] Wrote ${posts.length} ${name} post(s) to ${out.replace("../", "")}`);
}

for (const section of SECTIONS) {
  buildSection(section);
}
