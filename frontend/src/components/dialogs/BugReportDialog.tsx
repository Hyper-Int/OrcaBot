// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: bug-report-v6-validation

"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Camera, X, ImageIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Textarea,
} from "@/components/ui";
import { submitBugReport } from "@/lib/api/cloudflare/bug-reports";

const MODULE_REVISION = "bug-report-v6-validation";
console.log(
  `[BugReportDialog] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboardId: string;
  dashboardName: string;
}

export function BugReportDialog({
  open,
  onOpenChange,
  dashboardId,
  dashboardName,
}: BugReportDialogProps) {
  const [notes, setNotes] = React.useState("");
  const [includeScreenshot, setIncludeScreenshot] = React.useState(false);
  const [screenshot, setScreenshot] = React.useState<string | null>(null);
  const [isCapturing, setIsCapturing] = React.useState(false);

  
  // Reset form when dialog closes
  React.useEffect(() => {
    if (!open) {
      setNotes("");
      setScreenshot(null);
      setIncludeScreenshot(false);
    }
  }, [open]);

  const captureScreenshot = async () => {
    setIsCapturing(true);
    try {
      const { domToPng } = await import("modern-screenshot");

      const dataUrl = await domToPng(document.body, {
        scale: 0.5, // Reduce size for smaller file
        quality: 0.7,
        filter: (node: Node) => {
          // Exclude dialog portals from the screenshot
          if (node instanceof HTMLElement) {
            if (node.hasAttribute('data-radix-portal')) {
              return false;
            }
            // Also check for dialog overlay/content
            if (node.getAttribute('role') === 'dialog') {
              return false;
            }
          }
          return true;
        },
      });

      setScreenshot(dataUrl);
      setIncludeScreenshot(true);
    } catch (err) {
      console.warn("[BugReportDialog] Screenshot capture failed:", err);
      setScreenshot(null);
    }
    setIsCapturing(false);
  };

  const submitMutation = useMutation({
    mutationFn: (data: {
      notes: string;
      screenshot?: string;
      dashboardId: string;
      dashboardName: string;
    }) => submitBugReport(data),
    onSuccess: (result) => {
      if (result.screenshotExcluded) {
        toast.success("Bug report submitted, but the screenshot was too large or invalid and was excluded.");
      } else {
        toast.success("Bug report submitted. Thank you!");
      }
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to submit bug report"
      );
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitMutation.mutate({
      notes,
      screenshot: includeScreenshot && screenshot ? screenshot : undefined,
      dashboardId,
      dashboardName,
    });
  };

  const handleRemoveScreenshot = () => {
    setScreenshot(null);
    setIncludeScreenshot(false);
  };

  const handleRetakeScreenshot = () => {
    setScreenshot(null);
    captureScreenshot();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Report a Bug</DialogTitle>
          <DialogDescription>
            Help us improve OrcaBot by reporting issues you encounter.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Notes textarea */}
          <div className="space-y-2">
            <label
              htmlFor="bug-notes"
              className="text-sm font-medium text-[var(--foreground)]"
            >
              Describe the issue
            </label>
            <Textarea
              id="bug-notes"
              placeholder="What went wrong? What did you expect to happen?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="min-h-[100px]"
            />
          </div>

          {/* Screenshot section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Screenshot
              </label>
              {screenshot && (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRetakeScreenshot}
                    disabled={isCapturing}
                    className="text-xs h-7"
                  >
                    <Camera className="w-3 h-3 mr-1" />
                    Retake
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRemoveScreenshot}
                    className="text-xs h-7 text-[var(--status-error)]"
                  >
                    <X className="w-3 h-3 mr-1" />
                    Remove
                  </Button>
                </div>
              )}
            </div>

            {isCapturing ? (
              <div className="flex items-center justify-center h-32 border border-dashed border-[var(--border)] rounded-md bg-[var(--background-surface)]">
                <div className="flex items-center gap-2 text-sm text-[var(--foreground-muted)]">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Capturing screenshot...
                </div>
              </div>
            ) : screenshot ? (
              <div className="relative border border-[var(--border)] rounded-md overflow-hidden">
                <img
                  src={screenshot}
                  alt="Bug report screenshot"
                  className="w-full h-auto max-h-48 object-contain bg-[var(--background-surface)]"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={captureScreenshot}
                className="flex flex-col items-center justify-center h-32 w-full border border-dashed border-[var(--border)] rounded-md bg-[var(--background-surface)] hover:bg-[var(--background-elevated)] transition-colors cursor-pointer"
              >
                <ImageIcon className="w-8 h-8 text-[var(--foreground-muted)] mb-2" />
                <span className="text-sm text-[var(--foreground-muted)]">
                  Click to capture screenshot
                </span>
              </button>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitMutation.isPending}
            >
              {submitMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                "Submit Report"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
