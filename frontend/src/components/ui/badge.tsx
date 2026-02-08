// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--background-surface)] text-[var(--foreground-muted)] border border-[var(--border)]",
        secondary:
          "bg-[var(--background-hover)] text-[var(--foreground-muted)]",
        success:
          "bg-[var(--status-success)]/10 text-[var(--status-success)] border border-[var(--status-success)]/20",
        warning:
          "bg-[var(--status-warning)]/10 text-[var(--status-warning)] border border-[var(--status-warning)]/20",
        error:
          "bg-[var(--status-error)]/10 text-[var(--status-error)] border border-[var(--status-error)]/20",
        info: "bg-[var(--status-info)]/10 text-[var(--status-info)] border border-[var(--status-info)]/20",
        // Terminal control states
        control:
          "bg-[var(--status-control-active)]/10 text-[var(--status-control-active)] border border-[var(--status-control-active)]/20",
        observing:
          "bg-[var(--status-control-observing)]/10 text-[var(--status-control-observing)] border border-[var(--status-control-observing)]/20",
        agent:
          "bg-[var(--status-control-agent)]/10 text-[var(--status-control-agent)] border border-[var(--status-control-agent)]/20",
      },
      size: {
        sm: "text-[10px] px-2 py-0",
        md: "text-xs px-2.5 py-0.5",
        lg: "text-sm px-3 py-1",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
  dotColor?: string;
}

function Badge({
  className,
  variant,
  size,
  dot,
  dotColor,
  children,
  ...props
}: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot && (
        <span
          className="mr-1.5 h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor: dotColor || "currentColor",
          }}
        />
      )}
      {children}
    </div>
  );
}

export { Badge, badgeVariants };
