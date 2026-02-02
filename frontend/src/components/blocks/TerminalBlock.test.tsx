import * as React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

vi.mock("./BlockWrapper", () => ({
  BlockWrapper: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="block-wrapper">{children}</div>
  ),
}));

function renderTerminal(sessionOwnerId: string, viewerId: string) {
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
      connectionState: "connected",
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
      reconnect: vi.fn(),
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
          selected={false}
          dragging={false}
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

  it("does not show view-only messaging for the owner", () => {
    renderTerminal("owner-1", "owner-1");
    expect(screen.queryByText("View-only session")).toBeNull();
  });

  it("shows view-only messaging for non-owners", () => {
    renderTerminal("owner-1", "viewer-1");
    expect(screen.getAllByText("View-only session").length).toBeGreaterThan(0);
  });
});
