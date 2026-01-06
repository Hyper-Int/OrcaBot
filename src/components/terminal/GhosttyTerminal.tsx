"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// Ghostty-web types (library doesn't export TypeScript types)
interface GhosttyTerminal {
  open: (element: HTMLElement) => void;
  write: (data: string | Uint8Array) => void;
  onData: (callback: (data: string) => void) => void;
  resize: (cols: number, rows: number) => void;
  dispose: () => void;
  cols: number;
  rows: number;
}

interface GhosttyTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selection?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

interface GhosttyOptions {
  fontSize?: number;
  fontFamily?: string;
  theme?: GhosttyTheme;
  cursorBlink?: boolean;
  cursorStyle?: "block" | "underline" | "bar";
}

// Default dark theme matching our design system
const DEFAULT_THEME: GhosttyTheme = {
  background: "#0a0a0b",
  foreground: "#e4e4e7",
  cursor: "#3b82f6",
  cursorAccent: "#0a0a0b",
  selection: "rgba(59, 130, 246, 0.3)",
  black: "#27272a",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#fafafa",
};

export interface GhosttyTerminalProps {
  /** Called when the terminal sends data (user input) */
  onData?: (data: string) => void;
  /** Called when the terminal is resized */
  onResize?: (cols: number, rows: number) => void;
  /** Called when the terminal is ready */
  onReady?: () => void;
  /** Whether the terminal is disabled (no input) */
  disabled?: boolean;
  /** Font size in pixels */
  fontSize?: number;
  /** Custom theme */
  theme?: GhosttyTheme;
  /** Optional className */
  className?: string;
}

export interface GhosttyTerminalHandle {
  /** Write data to the terminal */
  write: (data: string | Uint8Array) => void;
  /** Resize the terminal */
  resize: (cols: number, rows: number) => void;
  /** Get current dimensions */
  getDimensions: () => { cols: number; rows: number } | null;
  /** Focus the terminal */
  focus: () => void;
  /** Fit terminal to container */
  fit: () => void;
}

/**
 * Ghostty-web terminal component
 * Wraps the ghostty-web WASM terminal emulator
 */
export const GhosttyTerminal = React.forwardRef<
  GhosttyTerminalHandle,
  GhosttyTerminalProps
>(function GhosttyTerminal(
  {
    onData,
    onResize,
    onReady,
    disabled = false,
    fontSize = 14,
    theme = DEFAULT_THEME,
    className,
  },
  ref
) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<GhosttyTerminal | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Initialize terminal
  React.useEffect(() => {
    let mounted = true;
    let terminal: GhosttyTerminal | null = null;

    async function initTerminal() {
      if (!containerRef.current) return;

      try {
        // Dynamic import for WASM module (must be client-side only)
        const ghostty = await import("ghostty-web");

        // Initialize the WASM module
        await ghostty.init();

        if (!mounted || !containerRef.current) return;

        // Create terminal instance
        terminal = new ghostty.Terminal({
          fontSize,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
          theme,
          cursorBlink: true,
          cursorStyle: "block",
        } as GhosttyOptions) as unknown as GhosttyTerminal;

        // Open in container
        terminal.open(containerRef.current);
        terminalRef.current = terminal;

        // Set up data handler
        terminal.onData((data: string) => {
          if (!disabled && onData) {
            onData(data);
          }
        });

        setIsLoading(false);
        onReady?.();

        // Initial resize notification
        if (onResize && terminal.cols && terminal.rows) {
          onResize(terminal.cols, terminal.rows);
        }
      } catch (err) {
        console.error("Failed to initialize Ghostty terminal:", err);
        if (mounted) {
          setError(err instanceof Error ? err.message : "Failed to load terminal");
          setIsLoading(false);
        }
      }
    }

    initTerminal();

    return () => {
      mounted = false;
      if (terminal) {
        terminal.dispose();
      }
      terminalRef.current = null;
    };
  }, [fontSize, theme, disabled, onData, onReady, onResize]);

  // Track last dimensions to avoid unnecessary resizes
  const lastDimensionsRef = React.useRef({ cols: 0, rows: 0 });

  // Expose methods via ref
  React.useImperativeHandle(
    ref,
    () => ({
      write: (data: string | Uint8Array) => {
        terminalRef.current?.write(data);
      },
      resize: (cols: number, rows: number) => {
        if (cols !== lastDimensionsRef.current.cols || rows !== lastDimensionsRef.current.rows) {
          lastDimensionsRef.current = { cols, rows };
          terminalRef.current?.resize(cols, rows);
          onResize?.(cols, rows);
        }
      },
      getDimensions: () => {
        if (terminalRef.current) {
          return {
            cols: terminalRef.current.cols,
            rows: terminalRef.current.rows,
          };
        }
        return null;
      },
      focus: () => {
        containerRef.current?.focus();
      },
      fit: () => {
        // Ghostty-web auto-fits, but we can trigger a resize check
        if (terminalRef.current && containerRef.current) {
          // Get container dimensions and calculate appropriate cols/rows
          const rect = containerRef.current.getBoundingClientRect();
          // Approximate character dimensions (will vary by font)
          const charWidth = fontSize * 0.6;
          const charHeight = fontSize * 1.2;
          const cols = Math.floor(rect.width / charWidth);
          const rows = Math.floor(rect.height / charHeight);
          // Only resize if dimensions changed
          if (cols > 0 && rows > 0 &&
              (cols !== lastDimensionsRef.current.cols || rows !== lastDimensionsRef.current.rows)) {
            lastDimensionsRef.current = { cols, rows };
            terminalRef.current.resize(cols, rows);
            onResize?.(cols, rows);
          }
        }
      },
    }),
    [fontSize, onResize]
  );

  // Handle container resize with robust debouncing to prevent ResizeObserver loops
  React.useEffect(() => {
    if (!containerRef.current || isLoading) return;

    let rafId: number | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let isResizing = false;

    const handleResize = () => {
      if (!terminalRef.current || !containerRef.current || isResizing) return;

      const rect = containerRef.current.getBoundingClientRect();
      // Skip if container has no size yet
      if (rect.width < 10 || rect.height < 10) return;

      const charWidth = fontSize * 0.6;
      const charHeight = fontSize * 1.2;
      const cols = Math.floor(rect.width / charWidth);
      const rows = Math.floor(rect.height / charHeight);

      // Only resize if dimensions actually changed
      if (cols > 0 && rows > 0 &&
          (cols !== lastDimensionsRef.current.cols || rows !== lastDimensionsRef.current.rows)) {
        isResizing = true;
        lastDimensionsRef.current = { cols, rows };

        try {
          terminalRef.current.resize(cols, rows);
          onResize?.(cols, rows);
        } finally {
          // Reset flag after a short delay to allow layout to settle
          setTimeout(() => {
            isResizing = false;
          }, 50);
        }
      }
    };

    const debouncedResize = () => {
      // Cancel any pending resize
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }

      // Use requestAnimationFrame + setTimeout for robust debouncing
      resizeTimeout = setTimeout(() => {
        rafId = requestAnimationFrame(handleResize);
      }, 150);
    };

    const resizeObserver = new ResizeObserver(debouncedResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
    };
  }, [fontSize, isLoading, onResize]);

  if (error) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-black text-red-500 text-sm p-4",
          className
        )}
      >
        Terminal error: {error}
      </div>
    );
  }

  return (
    <div className={cn("relative", className)} style={{ contain: "strict" }}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black text-gray-500 text-sm">
          Loading terminal...
        </div>
      )}
      <div
        ref={containerRef}
        className={cn(
          "w-full h-full",
          disabled && "pointer-events-none opacity-75"
        )}
        style={{
          backgroundColor: theme?.background || DEFAULT_THEME.background,
          contain: "strict",
          overflow: "hidden",
        }}
      />
    </div>
  );
});

export default GhosttyTerminal;
