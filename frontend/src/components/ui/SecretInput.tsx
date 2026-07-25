// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: secret-input-v6-mask-pending-selection
"use client";

import * as React from "react";
import { Input, type InputProps } from "./input";
import { cn } from "@/lib/utils";

const SECRET_INPUT_REVISION = "secret-input-v6-mask-pending-selection";
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
 * FAIL-CLOSED, even before verification. The font mask exposes the value if the
 * font fails to decode (`font-display: block` then falls back to a READABLE font,
 * and the field is `type="text"`). We can only verify the font AFTER paint (in an
 * effect), so we must not START in a readable state. The three states:
 *   - `unknown` (initial, pre-verification): render the text INVISIBLE via the
 *     `secret-pending` class (transparent fill + a `::selection` override so a
 *     selection can't reveal it) — font-independent (a corrupt/cached font can't
 *     flash the secret) and with NO `-webkit-text-security`, so no password-manager
 *     prompt is triggered for normal users.
 *   - `ok` (font verified available via `document.fonts.check`): the disc font
 *     mask — dots, no prompt. The common steady state.
 *   - `failed` (font unavailable, or no Font Loading API): the
 *     `-webkit-text-security` CSS mask — hides the value regardless of any font,
 *     at the cost of possibly prompting a password manager (acceptable vs. leaking
 *     a secret). Near-impossible for an inline data-URI font.
 * So the value is never rendered readable in any state or timing window.
 */
interface SecretInputProps extends InputProps {
  masked?: boolean;
}

const MASK_FONT = "16px 'text-security-disc'";
type MaskState = "unknown" | "ok" | "failed";

const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ masked = true, className, style, ...props }, ref) => {
    // Start `unknown` → rendered invisible (fail closed) until we can verify the
    // masking font, which is only possible after paint.
    const [maskState, setMaskState] = React.useState<MaskState>("unknown");
    React.useEffect(() => {
      if (!masked) return;
      if (typeof document === "undefined" || !document.fonts || !document.fonts.load) {
        setMaskState("failed"); // no Font Loading API → fail closed to the CSS mask
        return;
      }
      let cancelled = false;
      // `@font-face` fonts (including inline data-URIs) load LAZILY — only when
      // used. Since the fail-closed 'unknown' state does NOT use the font,
      // `document.fonts.check` would report it absent forever. Explicitly load it,
      // then confirm: a corrupt/undecodable font makes load() reject (or return no
      // face) → 'failed' → CSS mask.
      document.fonts.load(MASK_FONT)
        .then((faces) => {
          if (cancelled) return;
          const ok = faces.length > 0 && document.fonts.check(MASK_FONT);
          setMaskState(ok ? "ok" : "failed");
        })
        .catch(() => { if (!cancelled) setMaskState("failed"); });
      return () => { cancelled = true; };
    }, [masked]);

    // The mask for `failed` comes AFTER `...style` so a caller can't override it
    // (fail closed). `ok` and `unknown` use classes (`::selection` can't be styled
    // inline — a plain inline `color: transparent` is revealed by the global
    // `::selection { color: white }` when text is selected).
    let maskClass: string | false = false;
    let maskStyle = style;
    if (masked) {
      if (maskState === "ok") {
        maskClass = "secret-masked";
      } else if (maskState === "failed") {
        maskStyle = { ...style, WebkitTextSecurity: "disc" } as React.CSSProperties;
      } else {
        maskClass = "secret-pending";
      }
    }

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
        className={cn(maskClass, className)}
        style={maskStyle}
        {...props}
      />
    );
  }
);
SecretInput.displayName = "SecretInput";

export { SecretInput };
