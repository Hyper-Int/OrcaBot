// REVISION: agent-icons-v2-detect-from-script
import { describe, expect, it } from "vitest";
import { getAgentType } from "./agent-icons";

// PokerBench's Codex seat: comments mention other agents; the agent is on the exec line.
const CODEX_SEAT = `# ===== PokerBench seat: an agent terminal like any other =====
# Log in here as usual (Claude Code, Codex and Gemini CLI seats look alike).
MODEL=                  # blank: the default model
export MODEL PATH="/tmp/pokerbench/bin:$PATH" POKER_CLI=/tmp/pokerbench/bin/poker
( until [ -r /tmp/pokerbench/seat.sh ]; do sleep 3; done
  exec bash /tmp/pokerbench/seat.sh helper openai ) >/dev/null 2>&1 &
exec codex --no-daemon \${MODEL:+-m "$MODEL"} --dangerously-bypass-approvals-and-sandbox`;

describe("getAgentType", () => {
  it("keeps a renamed agent terminal's type", () => {
    expect(getAgentType(CODEX_SEAT, "Codex")).toBe("codex");
    expect(getAgentType(CODEX_SEAT, "Codex (gpt-6.2-sol)")).toBe("codex");
    expect(getAgentType(CODEX_SEAT, "Seat 3")).toBe("codex");
    expect(getAgentType("exec /usr/bin/claude --model x", "Opus seat")).toBe("claude");
    expect(getAgentType("cd /x && gemini --yolo", "anything")).toBe("gemini");
  });

  it("falls back to the name, exactly or as a prefix", () => {
    expect(getAgentType("claude", "whatever")).toBe("claude");
    expect(getAgentType(undefined, "Gemini CLI")).toBe("gemini");
    expect(getAgentType(undefined, "Gemini CLI 2")).toBe("gemini");
    expect(getAgentType("bash", "Claude Code-opus")).toBe("claude");
    expect(getAgentType(undefined, "Codexify")).toBe("shell"); // not a prefix match
  });

  it("a plain shell stays a shell", () => {
    expect(getAgentType("npm run dev", "Dev server")).toBe("shell");
    expect(getAgentType("# runs codex later\nbash", "Terminal")).toBe("shell");
    expect(getAgentType(undefined, undefined)).toBe("shell");
  });
});
