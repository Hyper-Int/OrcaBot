// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

export interface TerminalTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selection?: string;
  selectionBackground?: string;
  selectionInactiveBackground?: string;
  selectionForeground?: string;
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

export interface TerminalProps {
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
  theme?: TerminalTheme;
  /** Optional className */
  className?: string;
}

export interface TerminalHandle {
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
