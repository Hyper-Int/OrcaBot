// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-class-filter-v1
// One class filter, shared by the results table and the preference/error charts.
//
// They are separate ```chart fences in the markdown, so they have no common
// React parent to hang a context provider from - the article is their only
// ancestor and it is a server component. A module-level store subscribed to
// with useSyncExternalStore needs no provider and no shared parent: both
// components import this file and see the same Set.
//
// The filter is additive. An empty Set means every class, so the default state
// needs no special case and unpressing the last chip returns to showing
// everything rather than to showing nothing.

import * as React from "react";

let selected: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

const getSnapshot = () => selected;

export function useClassFilter() {
  // Server render has no selection, so the server snapshot is a stable empty
  // Set rather than the live one - returning a value that could differ between
  // render passes is what makes useSyncExternalStore warn.
  const active = React.useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);

  const toggle = React.useCallback((key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
    emit();
  }, []);

  const clear = React.useCallback(() => {
    if (selected.size === 0) return;
    selected = new Set();
    emit();
  }, []);

  /** True when this class should be shown. Everything passes when nothing is
   *  selected, which is the "no filter" state. */
  const shows = React.useCallback(
    (key: string) => active.size === 0 || active.has(key),
    [active]
  );

  return { active, toggle, clear, shows };
}

const EMPTY: ReadonlySet<string> = new Set();
