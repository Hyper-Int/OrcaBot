// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: messaging-placeholder-v1-initial

"use client";

const MODULE_REVISION = "messaging-placeholder-v1-initial";
console.log(`[MessagingPlaceholderBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { MessageSquare } from "lucide-react";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";

/**
 * Placeholder block for messaging providers that don't have a full UI implementation yet
 * (Discord, Telegram, WhatsApp, Teams, Matrix, Google Chat).
 *
 * Renders a "Coming Soon" state instead of breaking React Flow with an unknown node type.
 */

interface PlaceholderData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type PlaceholderNode = Node<PlaceholderData, "discord" | "telegram" | "whatsapp" | "teams" | "matrix" | "google_chat">;

export function MessagingPlaceholderBlock({ id, data, selected, type }: NodeProps<PlaceholderNode>) {
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const label = type ? type.charAt(0).toUpperCase() + type.slice(1).replace("_", " ") : "Messaging";

  return (
    <BlockWrapper selected={selected} minWidth={200} minHeight={120}>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
      <div className="flex flex-col items-center justify-center h-full p-4">
        <MessageSquare className="w-8 h-8 text-[var(--text-muted)] mb-2" />
        <p className="text-xs font-medium text-[var(--text-primary)]">{label}</p>
        <p className="text-[10px] text-[var(--text-muted)] text-center mt-1">
          Coming soon
        </p>
      </div>
    </BlockWrapper>
  );
}

export default MessagingPlaceholderBlock;
