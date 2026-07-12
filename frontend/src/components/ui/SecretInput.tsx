// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: secret-input-v2-unmasked-default
"use client";

import * as React from "react";
import { Input, type InputProps } from "./input";

const SECRET_INPUT_REVISION = "secret-input-v2-unmasked-default";
if (typeof window !== "undefined" && !(window as unknown as { __secretInputLogged?: boolean }).__secretInputLogged) {
  (window as unknown as { __secretInputLogged?: boolean }).__secretInputLogged = true;
  console.log(`[SecretInput] REVISION: ${SECRET_INPUT_REVISION} loaded at ${new Date().toISOString()}`);
}

/**
 * SecretInput — a text input for secrets/tokens/API keys that NEVER trips browser
 * password managers. BOTH `type="password"` AND the `-webkit-text-security` CSS
 * mask make browsers (notably Safari) classify the field as a password — popping
 * a "save password" prompt and offering to autofill saved site passwords (the
 * Touch-ID thumbprint) right on top of the field. So we render a plain text input
 * with every "ignore me" hint the managers respect, and leave it UNMASKED by
 * default: a key is pasted once, and saved secrets are shown masked in the list.
 * Pass `masked` to re-enable the CSS mask if you accept the manager popups.
 */
interface SecretInputProps extends InputProps {
  masked?: boolean;
}

const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ style, masked = false, ...props }, ref) => {
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
        style={masked ? ({ WebkitTextSecurity: "disc", ...style } as React.CSSProperties) : style}
        {...props}
      />
    );
  }
);
SecretInput.displayName = "SecretInput";

export { SecretInput };
