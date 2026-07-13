// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: secret-input-v4-fail-closed-font-fallback
"use client";

import * as React from "react";
import { Input, type InputProps } from "./input";
import { cn } from "@/lib/utils";

const SECRET_INPUT_REVISION = "secret-input-v4-fail-closed-font-fallback";
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
 *
 * FAIL-CLOSED: the font approach masks nothing if the font fails to decode —
 * `font-display: block` then falls back to a READABLE font and, since the field
 * is `type="text"`, the secret would be exposed permanently. So we verify the
 * masking font is actually available (`document.fonts.check`, after
 * `document.fonts.ready`) and, if it is NOT, fall back to the `-webkit-text-security`
 * CSS mask — which hides the value independently of any font, at the cost of
 * possibly prompting a password manager (an acceptable degradation vs. leaking a
 * secret). The font is an inline data-URI so this fallback essentially never fires,
 * but the masking no longer depends on font availability.
 */
interface SecretInputProps extends InputProps {
  masked?: boolean;
}

const MASK_FONT = "16px 'text-security-disc'";

const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ masked = true, className, style, ...props }, ref) => {
    // Optimistically assume the font is available; before this resolves the font
    // class + font-display:block render the text invisible, which is itself
    // fail-closed. Only after fonts settle do we know if we must fall back.
    const [fontOk, setFontOk] = React.useState(true);
    React.useEffect(() => {
      if (!masked) return;
      if (typeof document === "undefined" || !document.fonts) return;
      let cancelled = false;
      document.fonts.ready
        .then(() => {
          if (cancelled) return;
          try {
            setFontOk(document.fonts.check(MASK_FONT));
          } catch {
            // If we can't tell, fail closed to the CSS mask.
            setFontOk(false);
          }
        })
        .catch(() => { if (!cancelled) setFontOk(false); });
      return () => { cancelled = true; };
    }, [masked]);

    const useFontMask = masked && fontOk;
    const useCssMask = masked && !fontOk;

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
        className={cn(useFontMask && "secret-masked", className)}
        style={useCssMask ? ({ WebkitTextSecurity: "disc", ...style } as React.CSSProperties) : style}
        {...props}
      />
    );
  }
);
SecretInput.displayName = "SecretInput";

export { SecretInput };
