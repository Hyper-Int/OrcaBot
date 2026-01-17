// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

declare module "*.css" {
  const content: { [className: string]: string };
  export default content;
}

declare module "xterm/css/xterm.css";
