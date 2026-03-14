// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: blog-subscribe-v1

"use client";

import { useState } from "react";
import { CLOUDFLARE_API_URL } from "@/config/env";

const MODULE_REVISION = "blog-subscribe-v1";
console.log(`[BlogSubscribe] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

export function BlogSubscribe() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setStatus("loading");
    try {
      const res = await fetch(`${CLOUDFLARE_API_URL}/blog/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus("success");
        setMessage(data.message || "Subscribed!");
        setEmail("");
      } else {
        setStatus("error");
        setMessage(data.error || "Something went wrong");
      }
    } catch {
      setStatus("error");
      setMessage("Failed to subscribe. Please try again.");
    }
  }

  if (status === "success") {
    return (
      <div
        style={{
          padding: "24px",
          borderRadius: "12px",
          border: "1px solid var(--border)",
          textAlign: "center",
        }}
      >
        <p style={{ color: "var(--foreground)", fontSize: "0.95rem", margin: 0 }}>
          {message}
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        padding: "32px",
        borderRadius: "12px",
        border: "1px solid var(--border)",
      }}
    >
      <p
        style={{
          fontSize: "1.1rem",
          fontWeight: 600,
          color: "var(--foreground)",
          margin: "0 0 4px",
        }}
      >
        Get new posts by email
      </p>
      <p
        style={{
          fontSize: "0.85rem",
          color: "var(--foreground-muted)",
          margin: "0 0 16px",
        }}
      >
        No spam. Unsubscribe anytime.
      </p>
      <div style={{ display: "flex", gap: "8px" }}>
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "rgba(255,255,255,0.05)",
            color: "var(--foreground)",
            fontSize: "0.9rem",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={status === "loading"}
          style={{
            padding: "10px 20px",
            borderRadius: "8px",
            border: "none",
            background: "#0066ff",
            color: "#fff",
            fontSize: "0.9rem",
            fontWeight: 500,
            cursor: status === "loading" ? "wait" : "pointer",
            opacity: status === "loading" ? 0.7 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {status === "loading" ? "..." : "Subscribe"}
        </button>
      </div>
      {status === "error" && (
        <p style={{ color: "#ef4444", fontSize: "0.8rem", margin: "8px 0 0" }}>
          {message}
        </p>
      )}
    </form>
  );
}
