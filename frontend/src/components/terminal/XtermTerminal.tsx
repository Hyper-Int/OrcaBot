"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { TerminalHandle, TerminalProps, TerminalTheme } from "./types";
import type { Terminal } from "xterm";
import type { FitAddon } from "@xterm/addon-fit";

interface XtermTheme extends TerminalTheme {}

export const XtermTerminal = React.forwardRef<TerminalHandle, TerminalProps>(
  function XtermTerminal(
    {
      onData,
      onResize,
      onReady,
      disabled = false,
      fontSize = 14,
      theme,
      className,
    },
    ref
  ) {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const terminalRef = React.useRef<Terminal | null>(null);
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const callbacksRef = React.useRef({
      onData,
      onResize,
      onReady,
      disabled,
    });

    React.useEffect(() => {
      callbacksRef.current = { onData, onResize, onReady, disabled };
      if (terminalRef.current) {
        terminalRef.current.options.disableStdin = disabled;
      }
    }, [onData, onResize, onReady, disabled]);

    React.useEffect(() => {
      let mounted = true;
      let disposeData: { dispose: () => void } | null = null;
      let disposed = false;

      async function initTerminal() {
        if (!containerRef.current) return;

        try {
          const [{ Terminal }, { FitAddon }] = await Promise.all([
            import("xterm"),
            import("@xterm/addon-fit"),
          ]);
          await import("xterm/css/xterm.css");

          if (!mounted || !containerRef.current) return;

          const terminal = new Terminal({
            fontSize,
            fontFamily:
              "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
            theme: theme as XtermTheme | undefined,
            cursorBlink: true,
            cursorStyle: "block",
            disableStdin: disabled,
          });

          const fitAddon = new FitAddon();
          terminal.loadAddon(fitAddon);
          terminal.open(containerRef.current);
          terminal.focus();
          fitAddon.fit();

          terminalRef.current = terminal;
          fitAddonRef.current = fitAddon;

          disposeData = terminal.onData((data: string) => {
            const { onData: onDataCb, disabled: isDisabled } = callbacksRef.current;
            if (!isDisabled && onDataCb) {
              onDataCb(data);
            }
          });

          if (callbacksRef.current.onResize) {
            callbacksRef.current.onResize(terminal.cols, terminal.rows);
          }

          setIsLoading(false);
          callbacksRef.current.onReady?.();
        } catch (err) {
          console.error("Failed to initialize xterm terminal:", err);
          if (mounted) {
            setError(err instanceof Error ? err.message : "Failed to load terminal");
            setIsLoading(false);
          }
        }
      }

      initTerminal();

      return () => {
        mounted = false;
        disposed = true;
        disposeData?.dispose();
        terminalRef.current?.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      };
    }, [theme]);

    React.useEffect(() => {
      if (!terminalRef.current) {
        return;
      }
      terminalRef.current.options.fontSize = fontSize;
      const container = containerRef.current;
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fitAddonRef.current?.fit();
        callbacksRef.current.onResize?.(
          terminalRef.current.cols,
          terminalRef.current.rows
        );
      } catch {
        // Ignore resize errors during teardown or rapid resizes.
      }
    }, [fontSize]);

    React.useImperativeHandle(
      ref,
      () => ({
        write: (data: string | Uint8Array) => {
          terminalRef.current?.write(data);
        },
        resize: (cols: number, rows: number) => {
          if (
            !terminalRef.current ||
            cols < 2 ||
            rows < 2 ||
            !terminalRef.current.element ||
            !terminalRef.current.element.isConnected
          ) {
            return;
          }
          try {
            terminalRef.current.resize(cols, rows);
            callbacksRef.current.onResize?.(cols, rows);
          } catch {
            // Ignore resize errors during initialization.
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
          terminalRef.current?.focus?.();
          containerRef.current?.focus();
        },
        fit: () => {
          if (!terminalRef.current || !fitAddonRef.current) {
            return;
          }
          const container = containerRef.current;
          if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
            return;
          }
          try {
            fitAddonRef.current.fit();
            callbacksRef.current.onResize?.(
              terminalRef.current.cols,
              terminalRef.current.rows
            );
          } catch {
            // Ignore resize errors during teardown or rapid resizes.
          }
        },
      }),
      []
    );

    if (error) {
      return (
        <div className={cn("flex items-center justify-center text-sm text-red-500", className)}>
          Failed to load terminal: {error}
        </div>
      );
    }

    return (
      <div className={cn("relative w-full h-full", className)}>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--foreground-muted)] text-sm">
            Loading terminal...
          </div>
        )}
        <div
          ref={containerRef}
          className={cn("w-full h-full", isLoading && "opacity-0")}
          tabIndex={0}
          onPointerDown={(event) => {
            event.stopPropagation();
            terminalRef.current?.focus?.();
          }}
        />
      </div>
    );
  }
);

export default XtermTerminal;
