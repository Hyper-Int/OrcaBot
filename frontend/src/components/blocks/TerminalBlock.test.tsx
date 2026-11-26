// REVISION: terminal-block-tests-v2-liveness-before-restart
import * as React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { TerminalBlock } from "./TerminalBlock";
import { useAuthStore } from "@/stores/auth-store";

const useTerminalMock = vi.fn();

vi.mock("@/hooks/useTerminal", () => ({
  useTerminal: (...args: unknown[]) => useTerminalMock(...args),
}));

vi.mock("@/components/terminal", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const Terminal = ReactModule.forwardRef((_props, ref) => {
    ReactModule.useImperativeHandle(ref, () => ({
      fit: vi.fn(),
      write: vi.fn(),
      getDimensions: () => ({ cols: 120, rows: 40 }),
    }));
    return <div data-testid="terminal" />;
  });

  return {
    Terminal,
    useTerminalOverlay: () => null,
  };
});

const livenessMock = vi.fn();
vi.mock("@/lib/api/cloudflare/session-liveness", () => ({
  getSessionLiveness: (...args: unknown[]) => livenessMock(...args),
}));

const stopSessionMock = vi.fn();
const createSessionMock = vi.fn();
vi.mock("@/lib/api/cloudflare", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/cloudflare")>("@/lib/api/cloudflare");
  return {
    ...actual,
    stopSession: (...args: unknown[]) => stopSessionMock(...args),
    createSession: (...args: unknown[]) => createSessionMock(...args),
    applySessionSecrets: vi.fn(async () => undefined),
  };
});

vi.mock("./BlockWrapper", () => ({
  BlockWrapper: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="block-wrapper">{children}</div>
  ),
}));

function renderTerminal(sessionOwnerId: string, viewerId: string, connectionState = "connected", reconnect = vi.fn()) {
  const queryClient = new QueryClient();
  useAuthStore.setState({
    user: {
      id: viewerId,
      name: "Viewer",
      email: "viewer@example.com",
      createdAt: new Date().toISOString(),
    },
    isAuthenticated: true,
    isLoading: false,
  });

  useTerminalMock.mockReturnValue([
    {
      connectionState,
      turnTaking: {
        controller: sessionOwnerId,
        controllerName: "Owner",
        isController: false,
        hasPendingRequest: false,
        pendingRequests: [],
        inputBlocked: true,
        inputBlockReason: "not_controller",
      },
      agentState: null,
      error: null,
    },
    {
      sendInput: vi.fn(),
      sendRawInput: vi.fn(),
      sendResize: vi.fn(),
      takeControl: vi.fn(),
      requestControl: vi.fn(),
      grantControl: vi.fn(),
      revokeControl: vi.fn(),
      reconnect,
    },
  ]);

  return render(
    <QueryClientProvider client={queryClient}>
      <ReactFlowProvider>
        <TerminalBlock
          id="terminal-1"
          data={{
            content: "Terminal",
            size: { width: 420, height: 320 },
            dashboardId: "dashboard-1",
            itemId: "terminal-1",
            session: {
              id: "session-1",
              dashboardId: "dashboard-1",
              itemId: "terminal-1",
              ownerUserId: sessionOwnerId,
              ownerName: "Owner",
              sandboxSessionId: "sandbox-1",
              ptyId: "pty-1",
              status: "active",
              region: "local",
              createdAt: new Date().toISOString(),
              stoppedAt: null,
            },
          }}
          type="terminal"
          selected={false}
          dragging={false}
          draggable={true}
          selectable={true}
          deletable={true}
          zIndex={0}
          isConnectable={true}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          width={420}
          height={320}
        />
      </ReactFlowProvider>
    </QueryClientProvider>
  );
}

describe("TerminalBlock owner controls", () => {
  beforeEach(() => {
    useTerminalMock.mockReset();
  });
  afterEach(() => cleanup());

  it("does not show view-only messaging for the owner", () => {
    renderTerminal("owner-1", "owner-1");
    expect(screen.queryByText("View-only session")).toBeNull();
  });

  it("shows view-only messaging for non-owners", () => {
    renderTerminal("owner-1", "viewer-1");
    expect(screen.getAllByText("View-only session").length).toBeGreaterThan(0);
  });
});

// A dropped connection isn't a dead terminal: the page asks the sandbox before replacing
// it (2026-11-24: a backgrounded Safari tab restarted healthy PokerBench terminals).
describe("TerminalBlock recovery after a lost connection", () => {
  let hidden = false;
  beforeEach(() => {
    useTerminalMock.mockReset();
    livenessMock.mockReset();
    stopSessionMock.mockReset();
    createSessionMock.mockReset();
    createSessionMock.mockReturnValue(new Promise(() => {}));
    hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("reconnects to a terminal that is still running, without restarting it", async () => {
    livenessMock.mockResolvedValue(true);
    const reconnect = vi.fn();
    renderTerminal("owner-1", "owner-1", "failed", reconnect);
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(livenessMock).toHaveBeenCalledWith("session-1");
    expect(stopSessionMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("starts a fresh session when the terminal's process is gone", async () => {
    livenessMock.mockResolvedValue(false);
    const reconnect = vi.fn();
    renderTerminal("owner-1", "owner-1", "failed", reconnect);
    await waitFor(() => expect(stopSessionMock).toHaveBeenCalledWith("session-1"), { timeout: 5000 });
    await waitFor(() => expect(createSessionMock).toHaveBeenCalled());
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("never restarts when it can't tell", async () => {
    livenessMock.mockResolvedValue(null);
    const reconnect = vi.fn();
    renderTerminal("owner-1", "owner-1", "failed", reconnect);
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(stopSessionMock).not.toHaveBeenCalled();
  });

  it("decides nothing while the tab is hidden", async () => {
    hidden = true;
    livenessMock.mockResolvedValue(true);
    const reconnect = vi.fn();
    renderTerminal("owner-1", "owner-1", "failed", reconnect);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(livenessMock).not.toHaveBeenCalled();
    hidden = false;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(stopSessionMock).not.toHaveBeenCalled();
  });
});
