// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: docs-overview-v2-category-groups

import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation - OrcaBot",
  description:
    "Learn how to use OrcaBot - sandboxed AI coding agents, multiplayer dashboards, integrations, and secrets protection.",
};

const CAPABILITIES = [
  {
    title: "Run AI coding agents in secure sandboxes",
    desc: "Launch Claude Code, Gemini CLI, or Codex in isolated VMs with zero setup. Each dashboard gets its own sandbox with pre-installed tools, a built-in Chromium browser, and persistent workspace files.",
    link: "/docs/terminals",
    linkText: "Terminals & Agents",
  },
  {
    title: "Protect API keys from prompt injection",
    desc: "The secrets broker injects API keys server-side - agents only see placeholders. Output redaction strips any leaked values before they reach your browser. Custom secrets require explicit domain approval.",
    link: "/docs/secrets",
    linkText: "Secrets & API Keys",
  },
  {
    title: "Connect your tools with policy-guarded access",
    desc: "Attach Gmail, GitHub, Google Calendar, Slack, Discord, and more to your terminals. OAuth tokens never leave the control plane. Policies control exactly what each agent can do - read-only, send-restricted, or full access.",
    link: "/docs/gmail",
    linkText: "Integrations",
  },
  {
    title: "Build visual workflows on a collaborative canvas",
    desc: "Dashboards are Figma-like boards with terminals, notes, todos, prompts, and decision blocks. Wire blocks together to create data pipelines. Multiple users can view and collaborate in real time.",
    link: "/docs/notes",
    linkText: "Dashboard Blocks",
  },
  {
    title: "Connect messaging platforms for two-way communication",
    desc: "Slack, Discord, Telegram, WhatsApp, Teams, and more. Subscribe to channels, receive inbound messages, and let agents send replies. Perfect for monitoring, alerting, and remote agent control.",
    link: "/docs/slack",
    linkText: "Messaging Integrations",
  },
  {
    title: "Automate with schedules and recipes",
    desc: "Run commands on cron schedules (every N minutes or full cron expressions). Define multi-step recipes and monitor execution history. Trigger immediate runs or let them fire automatically.",
    link: "/docs/schedules",
    linkText: "Schedules & Recipes",
  },
];

const SECTION_GROUPS = [
  {
    title: "Google",
    desc: "Google Workspace integrations for email, calendar, documents, and more.",
    items: [
      { name: "Calendar", slug: "calendar" },
      { name: "Contacts", slug: "contacts" },
      { name: "Forms", slug: "forms" },
      { name: "Gmail", slug: "gmail" },
      { name: "Sheets", slug: "sheets" },
    ],
  },
  {
    title: "Messaging",
    desc: "Connect chat platforms for two-way agent communication.",
    items: [
      { name: "Discord", slug: "discord" },
      { name: "Google Chat", slug: "google-chat" },
      { name: "Matrix", slug: "matrix" },
      { name: "Slack", slug: "slack" },
      { name: "Teams", slug: "teams" },
      { name: "Telegram", slug: "telegram" },
      { name: "X (Twitter)", slug: "twitter" },
      { name: "WhatsApp", slug: "whatsapp" },
    ],
  },
  {
    title: "Workspace",
    desc: "Source control and file management tools.",
    items: [
      { name: "GitHub", slug: "github" },
      { name: "Workspace", slug: "workspace" },
    ],
  },
  {
    title: "Agents",
    desc: "Terminal sessions, AI agents, and secrets management.",
    items: [
      { name: "Secrets & API Keys", slug: "secrets" },
      { name: "Terminals & Agents", slug: "terminals" },
    ],
  },
  {
    title: "Blocks",
    desc: "Dashboard canvas blocks for building workflows.",
    items: [
      { name: "Browser", slug: "browser" },
      { name: "Decisions", slug: "decisions" },
      { name: "Links", slug: "links" },
      { name: "Notes", slug: "notes" },
      { name: "Prompts", slug: "prompts" },
      { name: "Recipes", slug: "recipes" },
      { name: "Schedules", slug: "schedules" },
      { name: "Todos", slug: "todos" },
    ],
  },
];

export default function DocsOverviewPage() {
  return (
    <div>
      {/* Hero */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1
          style={{
            fontSize: "1.75rem",
            fontWeight: 700,
            lineHeight: 1.2,
            marginBottom: "0.75rem",
          }}
        >
          OrcaBot Documentation
        </h1>
        <p
          style={{
            fontSize: "1rem",
            color: "rgba(255,255,255,0.65)",
            lineHeight: 1.6,
            maxWidth: "36rem",
          }}
        >
          OrcaBot is a sandboxed, multiplayer AI coding platform. Run AI agents
          in secure VMs, connect your tools, and collaborate in real time - all
          from a Figma-like dashboard in your browser.
        </p>
      </div>

      {/* Get Started card */}
      <Link
        href="/docs/getting-started"
        style={{
          display: "block",
          padding: "1.25rem 1.5rem",
          borderRadius: 12,
          border: "1px solid rgba(59,130,246,0.3)",
          backgroundColor: "rgba(59,130,246,0.08)",
          textDecoration: "none",
          marginBottom: "2.5rem",
          transition: "border-color 0.15s",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <span
              style={{
                fontSize: "0.95rem",
                fontWeight: 600,
                color: "#ffffff",
              }}
            >
              Getting Started
            </span>
            <p
              style={{
                fontSize: "0.82rem",
                color: "rgba(255,255,255,0.55)",
                marginTop: 4,
              }}
            >
              Create your first dashboard, start an AI agent, and begin coding
              in minutes.
            </p>
          </div>
          <span
            style={{
              fontSize: "0.82rem",
              color: "#3b82f6",
              fontWeight: 500,
              whiteSpace: "nowrap",
              marginLeft: "1rem",
            }}
          >
            Read guide →
          </span>
        </div>
      </Link>

      {/* What you can do */}
      <h2
        style={{
          fontSize: "1.15rem",
          fontWeight: 600,
          marginBottom: "1rem",
          color: "#ffffff",
        }}
      >
        What you can do
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "1rem",
          marginBottom: "2.5rem",
        }}
      >
        {CAPABILITIES.map((cap) => (
          <Link
            key={cap.link}
            href={cap.link}
            style={{
              display: "block",
              padding: "1.25rem",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.08)",
              backgroundColor: "rgba(255,255,255,0.02)",
              textDecoration: "none",
              transition: "border-color 0.15s, background-color 0.15s",
            }}
          >
            <h3
              style={{
                fontSize: "0.88rem",
                fontWeight: 600,
                color: "#ffffff",
                marginBottom: 6,
                lineHeight: 1.3,
              }}
            >
              {cap.title}
            </h3>
            <p
              style={{
                fontSize: "0.78rem",
                color: "rgba(255,255,255,0.5)",
                lineHeight: 1.5,
                marginBottom: 8,
              }}
            >
              {cap.desc}
            </p>
            <span
              style={{
                fontSize: "0.75rem",
                color: "#3b82f6",
                fontWeight: 500,
              }}
            >
              {cap.linkText} →
            </span>
          </Link>
        ))}
      </div>

      {/* Grouped sections */}
      {SECTION_GROUPS.map((group) => (
        <div key={group.title} style={{ marginBottom: "2rem" }}>
          <h2
            style={{
              fontSize: "1.05rem",
              fontWeight: 600,
              marginBottom: "0.4rem",
              color: "#ffffff",
            }}
          >
            {group.title}
          </h2>
          <p
            style={{
              fontSize: "0.82rem",
              color: "rgba(255,255,255,0.5)",
              marginBottom: "0.75rem",
            }}
          >
            {group.desc}
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
            }}
          >
            {group.items.map((item) => (
              <Link
                key={item.slug}
                href={`/docs/${item.slug}`}
                style={{
                  padding: "6px 14px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.1)",
                  fontSize: "0.78rem",
                  color: "rgba(255,255,255,0.7)",
                  textDecoration: "none",
                  transition: "border-color 0.15s",
                }}
              >
                {item.name}
              </Link>
            ))}
          </div>
        </div>
      ))}

      {/* Security callout */}
      <div
        style={{
          padding: "1.25rem 1.5rem",
          borderRadius: 12,
          border: "1px solid rgba(16,185,129,0.25)",
          backgroundColor: "rgba(16,185,129,0.06)",
          marginBottom: "2rem",
        }}
      >
        <h3
          style={{
            fontSize: "0.88rem",
            fontWeight: 600,
            color: "#10b981",
            marginBottom: 6,
          }}
        >
          Security by design
        </h3>
        <p
          style={{
            fontSize: "0.8rem",
            color: "rgba(255,255,255,0.6)",
            lineHeight: 1.5,
          }}
        >
          API keys are broker-protected - agents never see raw values. OAuth
          tokens stay in the control plane. Network egress is proxy-controlled
          with user approval. All integration API calls are made server-side
          through a policy gateway.
        </p>
      </div>
    </div>
  );
}
