"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, leftIcon, rightIcon, ...props }, ref) => {
    return (
      <div className="relative">
        {leftIcon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--foreground-subtle)]">
            {leftIcon}
          </div>
        )}
        <input
          type={type}
          className={cn(
            "flex h-9 w-full rounded-[var(--radius-input)] bg-[var(--background-surface)] px-3 py-2 text-sm",
            "border border-[var(--border)] text-[var(--foreground)]",
            "placeholder:text-[var(--foreground-subtle)]",
            "focus:outline-none focus:ring-2 focus:ring-[var(--border-focus)] focus:border-transparent",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "transition-colors",
            error && "border-[var(--status-error)] focus:ring-[var(--status-error)]",
            leftIcon && "pl-10",
            rightIcon && "pr-10",
            className
          )}
          ref={ref}
          {...props}
        />
        {rightIcon && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--foreground-subtle)]">
            {rightIcon}
          </div>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-[var(--radius-input)] bg-[var(--background-surface)] px-3 py-2 text-sm",
          "border border-[var(--border)] text-[var(--foreground)]",
          "placeholder:text-[var(--foreground-subtle)]",
          "focus:outline-none focus:ring-2 focus:ring-[var(--border-focus)] focus:border-transparent",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "transition-colors resize-none",
          error && "border-[var(--status-error)] focus:ring-[var(--status-error)]",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Input, Textarea };
