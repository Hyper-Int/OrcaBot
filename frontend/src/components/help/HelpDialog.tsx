// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: help-dialog-v1-initial
"use client";

const MODULE_REVISION = "help-dialog-v1-initial";
console.log(`[HelpDialog] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import Image from "next/image";
import Markdown from "react-markdown";
import { HelpCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DocEntry } from "@/docs/types";

interface HelpDialogProps {
  /** The doc entry to display */
  doc: DocEntry;
  /** Controlled open state */
  open: boolean;
  /** Called when dialog should close */
  onOpenChange: (open: boolean) => void;
}

/**
 * Friendly orcabot help dialog — shows quick setup steps and summary.
 * Uses /orca.png (friendly) not /orca_mad.png (angry paste warning).
 * Expandable to show full documentation body.
 */
export function HelpDialog({ doc, open, onOpenChange }: HelpDialogProps) {
  const [showFull, setShowFull] = React.useState(false);

  // Reset expanded state when dialog closes
  React.useEffect(() => {
    if (!open) setShowFull(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <DialogTitle className="flex items-center gap-2 text-[var(--foreground)]">
                <HelpCircle className="w-4 h-4 text-[var(--accent-primary)]" />
                {doc.title}
              </DialogTitle>
              <DialogDescription>
                {doc.summary}
              </DialogDescription>
            </div>
            <div className="flex-shrink-0 w-14 h-14 rounded-full overflow-hidden ring-2 ring-[var(--accent-primary)]/30">
              <Image
                src="/orca.png"
                alt="Orcabot"
                width={56}
                height={56}
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        </DialogHeader>

        {/* Quick setup steps */}
        <div className="rounded-lg border border-[var(--accent-primary)]/20 bg-[var(--accent-primary)]/5 p-3 mt-2">
          <p className="text-xs font-medium text-[var(--accent-primary)] mb-2 uppercase tracking-wide">
            Quick Setup
          </p>
          <ol className="space-y-1.5">
            {doc.quickHelp.map((step, i) => (
              <li key={i} className="flex gap-2 text-sm text-[var(--foreground)]">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[var(--accent-primary)]/15 text-[var(--accent-primary)] text-xs font-medium flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                <span className="leading-snug">{step}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Expandable full docs */}
        {showFull ? (
          <div className="mt-3 overflow-y-auto flex-1 min-h-0">
            <div className="prose prose-sm prose-invert max-w-none text-sm [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-3 [&_h3]:mb-1 [&_p]:my-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_code]:bg-[var(--background-surface)] [&_code]:px-1 [&_code]:rounded [&_code]:text-xs" style={{ color: 'var(--foreground)' }}>
              <Markdown>{doc.body}</Markdown>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFull(false)}
              className="mt-2 text-[var(--foreground-muted)] w-full"
            >
              Show less
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowFull(true)}
            className="mt-1 text-[var(--accent-primary)] hover:text-[var(--accent-primary)]"
          >
            Read full guide
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Small help button (?) that opens the HelpDialog for a given doc.
 * Drop this into any block header.
 */
interface HelpButtonProps {
  doc: DocEntry;
  className?: string;
}

export function HelpButton({ doc, className }: HelpButtonProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={`Help: ${doc.title}`}
        className={cn("nodrag", className)}
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </Button>
      <HelpDialog doc={doc} open={open} onOpenChange={setOpen} />
    </>
  );
}

export default HelpDialog;
