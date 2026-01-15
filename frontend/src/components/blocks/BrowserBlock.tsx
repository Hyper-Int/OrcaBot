"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { ExternalLink, Globe } from "lucide-react";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { checkEmbeddable } from "@/lib/api/cloudflare";
import type { DashboardItem } from "@/types/dashboard";

interface BrowserData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type BrowserNode = Node<BrowserData, "browser">;

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function isValidUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function BrowserBlock({ id, data, selected }: NodeProps<BrowserNode>) {
  const [draftUrl, setDraftUrl] = React.useState(data.content || "");
  const [isEmbeddable, setIsEmbeddable] = React.useState(true);
  const lastEmbeddableRef = React.useRef<boolean | null>(null);
  const connectorsVisible = selected || Boolean(data.connectorMode);

  React.useEffect(() => {
    setDraftUrl(data.content || "");
  }, [data.content]);

  const commitUrl = React.useCallback(() => {
    const normalized = normalizeUrl(draftUrl);
    setDraftUrl(normalized);
    if (normalized !== data.content) {
      data.onContentChange?.(normalized);
    }
  }, [draftUrl, data.content, data.onContentChange]);

  const url = data.content || "";
  const validUrl = isValidUrl(url);
  const isCollapsed = validUrl && !isEmbeddable;

  // Store onItemChange in a ref to avoid triggering effect on every render
  const onItemChangeRef = React.useRef(data.onItemChange);
  onItemChangeRef.current = data.onItemChange;

  React.useEffect(() => {
    let cancelled = false;

    if (!validUrl) {
      setIsEmbeddable(true);
      lastEmbeddableRef.current = true;
      return;
    }

    checkEmbeddable(url)
      .then((result) => {
        if (cancelled) return;
        const embeddable = result.embeddable;
        setIsEmbeddable(embeddable);
        if (lastEmbeddableRef.current !== embeddable) {
          const targetSize = embeddable
            ? { width: 520, height: 360 }
            : { width: 250, height: 130 };
          onItemChangeRef.current?.({ size: targetSize });
        }
        lastEmbeddableRef.current = embeddable;
      })
      .catch(() => {
        if (!cancelled) {
          setIsEmbeddable(true);
          lastEmbeddableRef.current = true;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [validUrl, url]);

  const handleOpen = () => {
    if (validUrl) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <span title="Browser icon">
        <Globe className="w-3.5 h-3.5 text-[var(--foreground-subtle)]" />
      </span>
      <Input
        value={draftUrl}
        onChange={(e) => setDraftUrl(e.target.value)}
        onBlur={commitUrl}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitUrl();
          }
        }}
        placeholder="https://..."
        title="Enter URL"
        className={cn(
          "h-6 text-xs bg-[var(--background-elevated)] nodrag",
          "border-[var(--border)] focus:border-[var(--border-strong)]"
        )}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleOpen}
        disabled={!validUrl}
        title={validUrl ? "Open in new tab" : "Enter a valid URL"}
        className="nodrag"
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </Button>
    </div>
  );

  if (isCollapsed) {
    return (
      <BlockWrapper
        selected={selected}
        className="p-0 flex flex-col overflow-visible"
        minWidth={250}
        minHeight={130}
        includeHandles={false}
      >
        {header}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 bg-[var(--background-elevated)] p-2">
          <div className="text-xs text-[var(--foreground-muted)]">
            Unable to display the webpage here
          </div>
          <Button
            variant="primary"
            onClick={handleOpen}
            className="text-sm font-semibold nodrag w-full h-full"
          >
            Open in new tab
          </Button>
        </div>
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
      </BlockWrapper>
    );
  }

  return (
    <BlockWrapper
      selected={selected}
      className="p-0 flex flex-col overflow-visible"
      minWidth={200}
      minHeight={30}
      includeHandles={false}
    >
      {header}

      <div className="relative flex-1 min-h-0 bg-white flex flex-col">
        {validUrl ? (
          <div className="flex-1 min-h-0">
            <iframe
              title="Browser"
              src={url}
              className="w-full h-full"
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--foreground-muted)]">
            Enter a URL to load a page.
          </div>
        )}
      </div>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default BrowserBlock;
