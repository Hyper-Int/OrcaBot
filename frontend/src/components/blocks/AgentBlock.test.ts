// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: agent-block-v2-status-detail

import { describe, it, expect } from "vitest";
import { cleanPairingCode, parseAgentContent, statusMessage } from "./AgentBlock";
import { AGENT_KINDS, agentKind, setupText } from "@/data/agent-kinds";

describe("Agent block", () => {
  it("reads pairing codes however they're typed or pasted", () => {
    expect(cleanPairingCode("ABCD-EFGH")).toBe("ABCDEFGH");
    expect(cleanPairingCode("abcd efgh")).toBe("ABCDEFGH");
    expect(cleanPairingCode("  abcdefgh ")).toBe("ABCDEFGH");
    expect(cleanPairingCode("My pairing code is 42YN-U7CP, it expires in 10 minutes")).toBe("42YNU7CP");
    expect(cleanPairingCode("ABC")).toBeNull();
    expect(cleanPairingCode("")).toBeNull();
  });

  it("parses its content defensively", () => {
    expect(parseAgentContent("")).toEqual({ kind: "grok", agent: undefined });
    expect(parseAgentContent("not json")).toEqual({ kind: "grok" });
    expect(parseAgentContent(JSON.stringify({ kind: "muse" }))).toEqual({ kind: "muse", agent: undefined });
    expect(parseAgentContent(JSON.stringify({ kind: "dots", agent: { identity: "orca:x/agent:dots", name: "dots" } })))
      .toEqual({ kind: "dots", agent: { identity: "orca:x/agent:dots", name: "dots" } });
    // A malformed agent is ignored rather than trusted.
    expect(parseAgentContent(JSON.stringify({ kind: "dots", agent: { identity: 5 } })).agent).toBeUndefined();
  });

  it("says why the link failed, and only when something is wrong", () => {
    const why = "couldn't get settings from the control plane: GET https://api.orcabot.com/internal/...: 404";
    expect(statusMessage("error", why)).toEqual({ text: "This dashboard can't reach your agents.", why });
    expect(statusMessage("error", "")).toEqual({ text: "This dashboard can't reach your agents.", why: null });
    expect(statusMessage("ready", "leftover detail").why).toBeNull();
    expect(statusMessage("pairing", "x").why).toBeNull();
    // The VM's "disabled" detail repeats the text: don't say it twice.
    expect(statusMessage("disabled", "agent linking isn't set up on this Orcabot").why).toBeNull();
    expect(statusMessage("something-new").text).toBe("something-new");
  });

  it("fills the hub URL into every agent's setup text and never names the hub", () => {
    for (const k of AGENT_KINDS) {
      const text = setupText(k, "https://hub.example/");
      expect(text).not.toContain("{hub}");
      expect(text).toContain("https://hub.example");
      expect(text).not.toMatch(/siren app|Siren app/i);
      expect(text.toLowerCase()).toContain("pairing code");
    }
    expect(agentKind("nope").id).toBe(AGENT_KINDS[0].id);
  });
});
