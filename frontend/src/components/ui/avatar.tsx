// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const avatarVariants = cva(
  "relative inline-flex items-center justify-center overflow-hidden rounded-full bg-[var(--background-surface)] text-[var(--foreground-muted)] font-medium",
  {
    variants: {
      size: {
        xs: "h-6 w-6 text-[10px]",
        sm: "h-8 w-8 text-xs",
        md: "h-10 w-10 text-sm",
        lg: "h-12 w-12 text-base",
        xl: "h-16 w-16 text-lg",
      },
    },
    defaultVariants: {
      size: "md",
    },
  }
);

export interface AvatarProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof avatarVariants> {
  src?: string;
  alt?: string;
  name?: string;
  fallback?: string;
  borderColor?: string;
}

/**
 * Get initials from a name
 */
function getInitials(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function Avatar({
  className,
  size,
  src,
  alt,
  name,
  fallback,
  borderColor,
  style,
  ...props
}: AvatarProps) {
  const [imageError, setImageError] = React.useState(false);

  const showImage = src && !imageError;
  const initials = fallback || (name ? getInitials(name) : "?");

  return (
    <div
      className={cn(avatarVariants({ size }), className)}
      style={{
        ...style,
        ...(borderColor && {
          boxShadow: `0 0 0 2px ${borderColor}`,
        }),
      }}
      {...props}
    >
      {showImage ? (
        <img
          src={src}
          alt={alt || name || "Avatar"}
          className="h-full w-full object-cover"
          onError={() => setImageError(true)}
        />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}

export interface AvatarGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  max?: number;
  size?: VariantProps<typeof avatarVariants>["size"];
}

function AvatarGroup({
  children,
  max = 5,
  size = "sm",
  className,
  ...props
}: AvatarGroupProps) {
  const childArray = React.Children.toArray(children);
  const visibleChildren = childArray.slice(0, max);
  const overflow = childArray.length - max;

  return (
    <div className={cn("flex -space-x-2", className)} {...props}>
      {visibleChildren.map((child, index) => (
        <div
          key={index}
          className="relative ring-2 ring-[var(--background-elevated)]"
          style={{ zIndex: visibleChildren.length - index }}
        >
          {React.isValidElement<AvatarProps>(child)
            ? React.cloneElement(child, { size })
            : child}
        </div>
      ))}
      {overflow > 0 && (
        <div
          className={cn(
            avatarVariants({ size }),
            "ring-2 ring-[var(--background-elevated)] bg-[var(--background-hover)]"
          )}
        >
          <span>+{overflow}</span>
        </div>
      )}
    </div>
  );
}

export { Avatar, AvatarGroup, avatarVariants };
