// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { XtermTerminal } from "./XtermTerminal";
import type { TerminalHandle, TerminalProps } from "./types";

export const Terminal = React.forwardRef<TerminalHandle, TerminalProps>(
  function Terminal(props, ref) {
    return <XtermTerminal ref={ref} {...props} />;
  }
);

export default Terminal;
