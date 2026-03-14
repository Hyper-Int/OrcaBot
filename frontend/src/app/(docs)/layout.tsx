// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: docs-layout-v3-shared-header

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useMemo } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { searchDocs, getDocsByCategory } from "@/docs";
import {
  Search,
  X,
  ChevronRight,
  Rocket,
  Mail,
  MessageSquare,
  FolderGit2,
  Bot,
  Blocks,
  Menu,
} from "lucide-react";

const CATEGORY_META: Record<
  string,
  { label: string; icon: React.ReactNode }
> = {
  "getting-started": {
    label: "Getting Started",
    icon: <Rocket className="w-3.5 h-3.5" />,
  },
  google: {
    label: "Google",
    icon: <Mail className="w-3.5 h-3.5" />,
  },
  messaging: {
    label: "Messaging",
    icon: <MessageSquare className="w-3.5 h-3.5" />,
  },
  workspace: {
    label: "Workspace",
    icon: <FolderGit2 className="w-3.5 h-3.5" />,
  },
  agents: {
    label: "Agents",
    icon: <Bot className="w-3.5 h-3.5" />,
  },
  blocks: {
    label: "Blocks",
    icon: <Blocks className="w-3.5 h-3.5" />,
  },
};

const CATEGORY_ORDER = ["getting-started", "google", "messaging", "workspace", "agents", "blocks"] as const;

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const searchResults = useMemo(
    () => (searchQuery.trim() ? searchDocs(searchQuery, 8) : []),
    [searchQuery]
  );

  const currentSlug = pathname.replace("/docs/", "").replace("/docs", "");

  const sidebarToggle = (
    <button
      onClick={() => setSidebarOpen((o) => !o)}
      className="lg:hidden"
      style={{
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.6)",
        cursor: "pointer",
        padding: "4px",
      }}
      aria-label="Toggle sidebar"
    >
      <Menu className="w-5 h-5" />
    </button>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#0b1a2e",
        color: "#ffffff",
      }}
    >
      <SiteHeader section="Docs" position="sticky" afterLogo={sidebarToggle} />

      {/* Body: sidebar + content */}
      <div
        style={{ maxWidth: "80rem", margin: "0 auto", display: "flex" }}
      >
        {/* Sidebar */}
        <aside
          className={sidebarOpen ? "docs-sidebar-open" : ""}
          style={{
            width: 260,
            flexShrink: 0,
            borderRight: "1px solid rgba(255,255,255,0.08)",
            padding: "1.5rem 0",
            position: "sticky",
            top: 53,
            height: "calc(100vh - 53px)",
            overflowY: "auto",
          }}
        >
          <style
            dangerouslySetInnerHTML={{
              __html: `
            @media (max-width: 1023px) {
              aside:not(.docs-sidebar-open) { display: none; }
              .docs-sidebar-open {
                position: fixed !important;
                top: 53px !important;
                left: 0 !important;
                width: 280px !important;
                height: calc(100vh - 53px) !important;
                z-index: 30;
                background: #0b1a2e;
                border-right: 1px solid rgba(255,255,255,0.12);
                box-shadow: 4px 0 24px rgba(0,0,0,0.4);
              }
            }
          `,
            }}
          />

          {/* Search */}
          <div style={{ padding: "0 1rem", marginBottom: "1rem" }}>
            <div style={{ position: "relative" }}>
              <Search
                className="w-3.5 h-3.5"
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "rgba(255,255,255,0.35)",
                  pointerEvents: "none",
                }}
              />
              <input
                type="text"
                placeholder="Search docs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: "100%",
                  padding: "7px 30px 7px 30px",
                  fontSize: "0.8rem",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 8,
                  backgroundColor: "rgba(255,255,255,0.04)",
                  color: "#ffffff",
                  outline: "none",
                }}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  style={{
                    position: "absolute",
                    right: 8,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    color: "rgba(255,255,255,0.4)",
                    cursor: "pointer",
                    padding: 2,
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Search results */}
            {searchQuery.trim() && (
              <div style={{ marginTop: 8 }}>
                {searchResults.length === 0 ? (
                  <p
                    style={{
                      fontSize: "0.75rem",
                      color: "rgba(255,255,255,0.4)",
                      padding: "4px 0",
                    }}
                  >
                    No results
                  </p>
                ) : (
                  searchResults.map((doc) => (
                    <Link
                      key={doc.slug}
                      href={`/docs/${doc.slug}`}
                      onClick={() => {
                        setSearchQuery("");
                        setSidebarOpen(false);
                      }}
                      style={{
                        display: "block",
                        padding: "6px 8px",
                        borderRadius: 6,
                        fontSize: "0.8rem",
                        color: "rgba(255,255,255,0.85)",
                        textDecoration: "none",
                        backgroundColor:
                          currentSlug === doc.slug
                            ? "rgba(59,130,246,0.15)"
                            : "transparent",
                      }}
                    >
                      <span style={{ fontWeight: 500 }}>{doc.title}</span>
                      <span
                        style={{
                          display: "block",
                          fontSize: "0.7rem",
                          color: "rgba(255,255,255,0.4)",
                          marginTop: 1,
                          lineHeight: 1.3,
                        }}
                      >
                        {doc.summary}
                      </span>
                    </Link>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Nav sections */}
          {!searchQuery.trim() && (
            <nav>
              {/* Overview link */}
              <div style={{ padding: "0 1rem", marginBottom: "0.5rem" }}>
                <Link
                  href="/docs"
                  onClick={() => setSidebarOpen(false)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: 6,
                    fontSize: "0.82rem",
                    fontWeight: 500,
                    color:
                      currentSlug === ""
                        ? "#ffffff"
                        : "rgba(255,255,255,0.7)",
                    textDecoration: "none",
                    backgroundColor:
                      currentSlug === ""
                        ? "rgba(59,130,246,0.15)"
                        : "transparent",
                  }}
                >
                  Overview
                </Link>
              </div>

              {CATEGORY_ORDER.map((cat) => {
                const meta = CATEGORY_META[cat];
                const docs = getDocsByCategory(cat);
                if (docs.length === 0) return null;
                return (
                  <div key={cat} style={{ marginBottom: "0.75rem" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 1rem",
                        fontSize: "0.7rem",
                        fontWeight: 600,
                        color: "rgba(255,255,255,0.4)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      {meta.icon}
                      {meta.label}
                    </div>
                    {docs.map((doc) => (
                      <Link
                        key={doc.slug}
                        href={`/docs/${doc.slug}`}
                        onClick={() => setSidebarOpen(false)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "5px 8px 5px 1.75rem",
                          fontSize: "0.8rem",
                          color:
                            currentSlug === doc.slug
                              ? "#ffffff"
                              : "rgba(255,255,255,0.6)",
                          textDecoration: "none",
                          backgroundColor:
                            currentSlug === doc.slug
                              ? "rgba(59,130,246,0.15)"
                              : "transparent",
                          borderRadius: 4,
                          fontWeight: currentSlug === doc.slug ? 500 : 400,
                        }}
                      >
                        {currentSlug === doc.slug && (
                          <ChevronRight
                            className="w-3 h-3"
                            style={{ color: "#3b82f6", marginLeft: -14 }}
                          />
                        )}
                        {doc.title}
                      </Link>
                    ))}
                  </div>
                );
              })}
            </nav>
          )}
        </aside>

        {/* Main content */}
        <main
          style={{
            flex: 1,
            minWidth: 0,
            padding: "2rem 2.5rem",
            maxWidth: "48rem",
          }}
        >
          {children}
        </main>
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            top: 53,
            backgroundColor: "rgba(0,0,0,0.5)",
            zIndex: 25,
          }}
          className="lg:hidden"
        />
      )}
    </div>
  );
}
