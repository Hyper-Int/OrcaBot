// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-vendor-list-v12-shared-vendors
// The organisations whose models are in the table, as linked chips.
//
// This was a scrolling marquee, matching the splash page. It is now static
// rows, which is strictly better here: every vendor is readable at once instead
// of a third of them being mid-transit, nothing has to be chased with the
// pointer to click it, and the set no longer has to be duplicated to fake a
// seamless loop - so there is no hidden copy to keep out of the accessibility
// tree, and no motion to suppress for readers who have asked for less of it.
//
// Where the logos come from, and why, is documented in ttsVendors.

import * as React from "react";

import { ICON_BASE, VENDORS } from "./ttsVendors";

const MODULE_REVISION = "tts-vendor-list-v12-shared-vendors";
if (typeof window !== "undefined") {
  console.log(`[tts-vendor-list] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

// The list and the logos now live in ttsVendors, shared with the results
// table's logo column so one vendor cannot be added to the chips and missed in
// the rows.

// Selectors are deliberately over-specific. This renders inside .legal-content,
// whose "a" rule paints every link accent blue and underlines it, and whose
// "img" rule sets display:block with 1.75rem of vertical margin - which alone
// inflated these chips from 36px tall to 92px. Both need beating on specificity.
const CSS = `
.tts-vendors-figure ul.tts-vendors {
  display: flex; flex-wrap: wrap; gap: 8px;
  margin: 0; padding: 0; list-style: none;
}
.tts-vendors-figure ul.tts-vendors > li { margin: 0; padding: 0; list-style: none; }
.tts-vendors a.tts-vendor-chip {
  display: inline-flex; align-items: center; gap: 9px;
  /* Sized for three rows, not squeezed into two. The prose column is a fixed
     1104px, so row count is set purely by chip width, and this was trimmed twice
     to hold twenty-one chips at 11 + 10. Twenty-five will not fit two rows at any
     readable size - the only sizing that managed it was 0.70rem with 5px padding,
     which shrinks every chip to tidy one row's wrapping.
     So the constraint is dropped and the space used instead: twenty-seven wrap
     9 + 9 + 9 with 82px spare on the last row. The horizontal padding is 13px
     rather than 14 for exactly that reason - at 14 the set spilled 8 + 9 + 9 + 1,
     stranding one chip alone on a fourth row, and one pixel either side of each
     chip is the whole difference. The label carries the width, so the font is
     untouched at 0.85rem and shrinking the logos would buy no row at all.
     Measured in-page rather than guessed; re-measure when a vendor is added. */
  padding: 9px 13px; border: 1px solid var(--border, #2a4570); border-radius: 40px;
  font-size: 0.85rem; font-weight: 500; line-height: 1;
  color: var(--foreground, #e8edf5);
  text-decoration: none; white-space: nowrap; background: var(--background-elevated, #0d1526);
}
.tts-vendors a.tts-vendor-chip:hover,
.tts-vendors a.tts-vendor-chip:focus-visible { border-color: #d95926; opacity: 1; }
.tts-vendors a.tts-vendor-chip img {
  width: 18px; height: 18px; margin: 0; display: inline-block;
  object-fit: contain; border-radius: 4px; flex-shrink: 0;
}
`;

export function TtsVendorList() {
  return (
    <figure className="tts-vendors-figure" style={{ margin: "2rem 0" }}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <figcaption style={{ marginBottom: "0.6rem", fontSize: "0.8rem", color: "#94a3c0" }}>
        Every model measured here is somebody&apos;s published work. These are the teams behind
        them.
      </figcaption>
      {/* A list, because that is what it is: a set of related links with no
          order that matters to the reader. */}
      <ul className="tts-vendors">
        {VENDORS.map((v) => (
          <li key={v.name}>
            <a className="tts-vendor-chip" href={v.url} target="_blank" rel="noopener noreferrer">
              <img src={ICON_BASE + v.icon} alt="" width={18} height={18} />
              {v.name}
            </a>
          </li>
        ))}
      </ul>
    </figure>
  );
}
