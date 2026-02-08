// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Highlight special tokens like [input] within text segments */
function highlightTokens(text: string): React.ReactNode {
  const segments = text.split(/(\[input\])/i);
  if (segments.length === 1) return text;
  return segments.map((seg, i) =>
    seg.toLowerCase() === "[input]" ? (
      <span
        key={i}
        className="px-1 py-0.5 rounded text-[0.85em] font-mono font-semibold bg-violet-500/20 text-violet-600 dark:text-violet-400"
        title="Replaced with upstream input data at runtime"
      >
        {seg}
      </span>
    ) : (
      <React.Fragment key={i}>{seg}</React.Fragment>
    )
  );
}

interface CodeBlockRendererProps {
  content: string;
  className?: string;
  placeholder?: string;
}

/**
 * Renders text content with code blocks (``` ... ```) styled with monospace font.
 * Regular text is rendered normally, code blocks get monospace styling.
 */
export function CodeBlockRenderer({ content, className, placeholder }: CodeBlockRendererProps) {
  const parts = React.useMemo(() => {
    if (!content) return [];

    // Split by code block markers, capturing the code blocks
    // Regex matches ```optional-language\ncode\n``` or ```code```
    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
    const result: Array<{ type: "text" | "code"; content: string; language?: string }> = [];

    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before this code block
      if (match.index > lastIndex) {
        result.push({
          type: "text",
          content: content.slice(lastIndex, match.index),
        });
      }

      // Add the code block
      result.push({
        type: "code",
        content: match[2],
        language: match[1] || undefined,
      });

      lastIndex = match.index + match[0].length;
    }

    // Add any remaining text
    if (lastIndex < content.length) {
      result.push({
        type: "text",
        content: content.slice(lastIndex),
      });
    }

    return result;
  }, [content]);

  if (!content && placeholder) {
    return (
      <div className={cn("text-[var(--foreground-subtle)]", className)}>
        {placeholder}
      </div>
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return (
    <div className={cn("whitespace-pre-wrap break-words", className)}>
      {parts.map((part, index) => {
        if (part.type === "code") {
          return (
            <code
              key={index}
              className={cn(
                "block my-1 p-2 rounded",
                "font-mono text-[0.8em] leading-relaxed",
                "bg-black/10 dark:bg-white/10",
                "overflow-x-auto"
              )}
            >
              {part.content}
            </code>
          );
        }
        return <span key={index}>{highlightTokens(part.content)}</span>;
      })}
    </div>
  );
}

export default CodeBlockRenderer;
