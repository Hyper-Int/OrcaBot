// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Minimal ambient types for @novnc/novnc (the package ships JS-only, no .d.ts).
// Covers just the RFB surface we use. RFB extends EventTarget, so addEventListener
// works for 'connect' | 'disconnect' | 'credentialsrequired' | 'securityfailure' |
// 'clipboard' | 'bell' | 'desktopname' events.
declare module "@novnc/novnc" {
  interface RFBOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string, options?: RFBOptions);
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string }): void;
    focus(): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
  }
}
