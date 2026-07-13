// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: secret-input-v3-disc-font-mask
"use client";

import * as React from "react";
import { Input, type InputProps } from "./input";
import { cn } from "@/lib/utils";

const SECRET_INPUT_REVISION = "secret-input-v3-disc-font-mask";
if (typeof window !== "undefined" && !(window as unknown as { __secretInputLogged?: boolean }).__secretInputLogged) {
  (window as unknown as { __secretInputLogged?: boolean }).__secretInputLogged = true;
  console.log(`[SecretInput] REVISION: ${SECRET_INPUT_REVISION} loaded at ${new Date().toISOString()}`);
}

/**
 * SecretInput — a text input for secrets/tokens/API keys that shows the value
 * masked (••••) WITHOUT tripping browser password managers.
 *
 * The trick: masking is exactly what Safari/Chrome key on. BOTH `type="password"`
 * AND the `-webkit-text-security` CSS mask make them classify the field as a
 * password — popping a "save password" prompt and the saved-credential autofill
 * thumbprint. So instead of masking via `type`/CSS, we keep an ordinary
 * `type="text"` field and mask visually with the self-hosted `text-security-disc`
 * font (see globals.css). The browser sees a normal text input → no popup, no
 * thumbprint — but every glyph renders as a bullet. `input.value` is still the
 * real secret. Every "ignore me" manager hint is also set as belt-and-braces.
 *
 * Pass `masked={false}` to show the value in plain text (e.g. a reveal toggle).
 */
interface SecretInputProps extends InputProps {
  masked?: boolean;
}

const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ masked = true, className, ...props }, ref) => {
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
        className={cn(masked && "secret-masked", className)}
        {...props}
      />
    );
  }
);
SecretInput.displayName = "SecretInput";

export { SecretInput };
