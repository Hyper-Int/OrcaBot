// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: secret-input-v1-masked-no-password-field
"use client";

import * as React from "react";
import { Input, type InputProps } from "./input";

const SECRET_INPUT_REVISION = "secret-input-v1-masked-no-password-field";
if (typeof window !== "undefined" && !(window as unknown as { __secretInputLogged?: boolean }).__secretInputLogged) {
  (window as unknown as { __secretInputLogged?: boolean }).__secretInputLogged = true;
  console.log(`[SecretInput] REVISION: ${SECRET_INPUT_REVISION} loaded at ${new Date().toISOString()}`);
}

/**
 * SecretInput — a masked text input for secrets/tokens/API keys that NEVER uses
 * `type="password"`. Using a real password field triggers browser password
 * managers (notably Safari's built-in Passwords, which pops a "save password"
 * prompt whenever a masked field is submitted through a native form). Instead we
 * render a plain text input visually masked via `-webkit-text-security` and set
 * every "please ignore me" hint the common managers respect.
 */
const SecretInput = React.forwardRef<HTMLInputElement, InputProps>(
  ({ style, ...props }, ref) => {
    return (
      <Input
        ref={ref}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        style={{ WebkitTextSecurity: "disc", ...style } as React.CSSProperties}
        {...props}
      />
    );
  }
);
SecretInput.displayName = "SecretInput";

export { SecretInput };
