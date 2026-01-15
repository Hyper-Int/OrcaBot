"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { ExternalLink, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";

interface LinkData extends Record<string, unknown> {
  content: string; // URL
  title?: string;
  description?: string;
  favicon?: string;
  size: { width: number; height: number };
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type LinkNode = Node<LinkData, "link">;

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function LinkBlock({ id, data, selected }: NodeProps<LinkNode>) {
  const url = data.content || "";
  const hostname = getHostname(url);
  const connectorsVisible = selected || Boolean(data.connectorMode);

  const handleClick = () => {
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <BlockWrapper
      selected={selected}
      className={cn(
        "cursor-pointer hover:border-[var(--border-strong)] transition-colors"
      )}
      includeHandles={false}
    >
      <div onClick={handleClick} className="p-3">
        {/* Favicon and hostname */}
        <div className="flex items-center gap-2 mb-2">
          {data.favicon ? (
            <img
              src={data.favicon}
              alt=""
              className="w-4 h-4 rounded"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <Globe className="w-4 h-4 text-[var(--foreground-subtle)]" />
          )}
          <span className="text-xs text-[var(--foreground-subtle)] truncate">
            {hostname}
          </span>
          <ExternalLink className="w-3 h-3 text-[var(--foreground-subtle)] ml-auto" />
        </div>

        {/* Title */}
        <h3 className="text-sm font-medium text-[var(--foreground)] line-clamp-2 mb-1">
          {data.title || url}
        </h3>

        {/* Description */}
        {data.description && (
          <p className="text-xs text-[var(--foreground-muted)] line-clamp-2">
            {data.description}
          </p>
        )}

        {/* URL preview */}
        <div className="mt-2 pt-2 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--foreground-subtle)] truncate">
            {url}
          </p>
        </div>
      </div>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default LinkBlock;
