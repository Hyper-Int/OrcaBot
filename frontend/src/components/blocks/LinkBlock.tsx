// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { ExternalLink, Globe, Link, Minimize2, Settings, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import type { DashboardItem } from "@/types/dashboard";

interface LinkData extends Record<string, unknown> {
  content: string; // URL
  title?: string;
  description?: string;
  favicon?: string;
  size: { width: number; height: number };
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  onDuplicate?: () => void;
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
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
    };
  }, []);

  const handleMinimize = () => {
    const expandedSize = data.size;
    setIsAnimatingMinimize(true);
    data.onItemChange?.({
      metadata: { ...data.metadata, expandedSize },
      size: MINIMIZED_SIZE,
    });
    minimizeTimeoutRef.current = setTimeout(() => {
      setIsAnimatingMinimize(false);
      data.onItemChange?.({
        metadata: { ...data.metadata, minimized: true, expandedSize },
      });
    }, 350);
  };

  const handleExpand = () => {
    const savedSize = data.metadata?.expandedSize as { width: number; height: number } | undefined;
    setExpandAnimation("animate-expand-bounce");
    setTimeout(() => setExpandAnimation(null), 300);
    data.onItemChange?.({
      metadata: { ...data.metadata, minimized: false },
      size: savedSize || { width: 280, height: 120 },
    });
  };

  const handleClick = () => {
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  // Minimized view - only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={data.favicon ? (
          <img src={data.favicon} alt="" className="w-14 h-14 rounded" />
        ) : (
          <Link className="w-14 h-14 text-[var(--foreground-subtle)]" />
        )}
        label={hostname}
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  return (
    <BlockWrapper
      selected={selected}
      className={cn(
        "cursor-pointer hover:border-[var(--border-strong)] transition-colors",
        expandAnimation
      )}
      includeHandles={false}
    >
      {/* All content fades during minimize */}
      <div onClick={handleClick} className={cn("p-3", isAnimatingMinimize && "animate-content-fade-out")} title={`Open ${hostname}`}>
        {/* Favicon and hostname */}
        <div className="flex items-center gap-2 mb-2">
          {data.favicon ? (
            <img
              src={data.favicon}
              alt={`${hostname} favicon`}
              title={`${hostname} favicon`}
              className="w-4 h-4 rounded"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <span title="Link icon">
              <Globe className="w-4 h-4 text-[var(--foreground-subtle)]" />
            </span>
          )}
          <span className="text-xs text-[var(--foreground-subtle)] truncate flex-1">
            {hostname}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="nodrag h-5 w-5" title="Settings" onClick={(e) => e.stopPropagation()}>
                <Settings className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
                <Copy className="w-3 h-3" />
                <span>Duplicate</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => { e.stopPropagation(); handleMinimize(); }}
            title="Minimize"
            className="nodrag h-5 w-5"
          >
            <Minimize2 className="w-3 h-3" />
          </Button>
          <span title="Opens in new tab">
            <ExternalLink className="w-3 h-3 text-[var(--foreground-subtle)]" />
          </span>
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
