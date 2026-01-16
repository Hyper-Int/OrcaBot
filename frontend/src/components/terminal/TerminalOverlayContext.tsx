// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";

export type TerminalViewport = {
  x: number;
  y: number;
  zoom: number;
};

export type TerminalOverlayContextValue = {
  root: HTMLElement | null;
  viewport: TerminalViewport;
  zIndexVersion: number;
  bringToFront: (id: string) => void;
  getZIndex: (id: string) => number;
};

const TerminalOverlayContext = React.createContext<TerminalOverlayContextValue | null>(
  null
);

export function TerminalOverlayProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: TerminalOverlayContextValue;
}) {
  return (
    <TerminalOverlayContext.Provider value={value}>
      {children}
    </TerminalOverlayContext.Provider>
  );
}

export function useTerminalOverlay() {
  return React.useContext(TerminalOverlayContext);
}

export function useTerminalZIndex(): {
  zIndexVersion: number;
  bringToFront: (id: string) => void;
  getZIndex: (id: string) => number;
} {
  const zIndexMapRef = React.useRef<Map<string, number>>(new Map());
  const counterRef = React.useRef(1);
  const [zIndexVersion, setZIndexVersion] = React.useState(0);

  const bringToFront = React.useCallback((id: string) => {
    zIndexMapRef.current.set(id, counterRef.current++);
    setZIndexVersion((v) => v + 1);
  }, []);

  const getZIndex = React.useCallback((id: string) => {
    return zIndexMapRef.current.get(id) ?? 0;
  }, []);

  return { zIndexVersion, bringToFront, getZIndex };
}
