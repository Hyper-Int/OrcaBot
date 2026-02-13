// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: replay-v2-bugfixes
const MODULE_REVISION = "replay-v2-bugfixes";

import * as React from "react";
import { ReplayCursor } from "./ReplayCursor";
import { ReplayControlBar } from "./ReplayControlBar";
import { useConnectionDataFlow } from "@/contexts/ConnectionDataFlowContext";
import { getReplayScript } from "@/data/replay-scripts";
import type { ReplayRunnerAPI, ReplayScript, ReplayAction } from "./types";

interface ReplayRunnerProps {
  api: ReplayRunnerAPI;
  scriptName: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Orchestrates scripted replay sequences on the dashboard.
 * Activated via `?replay=script-name` URL param.
 * Drives real dashboard mutations (addBlock, createEdge, etc.) with an animated cursor overlay.
 */
export function ReplayRunner({ api, scriptName }: ReplayRunnerProps) {
  React.useEffect(() => {
    console.log(`[ReplayRunner] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
  }, []);

  const connectionFlow = useConnectionDataFlow();
  const connectionFlowRef = React.useRef(connectionFlow);
  connectionFlowRef.current = connectionFlow;

  const [isRunning, setIsRunning] = React.useState(false);
  const [currentStep, setCurrentStep] = React.useState(0);
  const [loopCount, setLoopCount] = React.useState(0);
  const [cursorX, setCursorX] = React.useState(0);
  const [cursorY, setCursorY] = React.useState(0);
  const [cursorVisible, setCursorVisible] = React.useState(false);
  const [clicking, setClicking] = React.useState(false);
  const [moveDurationMs, setMoveDurationMs] = React.useState(0);

  // Track created items for cleanup on loop
  const aliasMapRef = React.useRef<Map<string, string>>(new Map());
  const createdItemIdsRef = React.useRef<string[]>([]);
  const stopRequestedRef = React.useRef(false);
  const scriptRef = React.useRef<ReplayScript | null>(null);

  // Keep api ref current to avoid stale closures in the async executor
  const apiRef = React.useRef(api);
  apiRef.current = api;

  const handleStop = React.useCallback(() => {
    stopRequestedRef.current = true;
    setIsRunning(false);
    setCursorVisible(false);
    // Remove ?replay from URL without page reload
    const url = new URL(window.location.href);
    url.searchParams.delete("replay");
    window.history.replaceState({}, "", url.toString());
  }, []);

  // Convert flow coordinates to screen coordinates
  const flowToScreen = React.useCallback(
    (flowX: number, flowY: number): { x: number; y: number } => {
      const vp = apiRef.current.getViewport() ?? { x: 0, y: 0, zoom: 1 };
      const zoom = vp.zoom || 1;
      return {
        x: flowX * zoom + (vp.x || 0),
        y: flowY * zoom + (vp.y || 0),
      };
    },
    []
  );

  // Execute a single action
  const executeAction = React.useCallback(
    async (action: ReplayAction) => {
      if (stopRequestedRef.current) return;

      switch (action.type) {
        case "moveCursor": {
          setMoveDurationMs(action.durationMs);
          const screen = flowToScreen(action.x, action.y);
          setCursorX(screen.x);
          setCursorY(screen.y);
          await sleep(action.durationMs);
          break;
        }

        case "click": {
          setClicking(true);
          await sleep(action.durationMs ?? 200);
          setClicking(false);
          await sleep(50); // brief pause after click
          break;
        }

        case "addBlock": {
          const itemId = await apiRef.current.addBlock(
            action.blockType,
            action.label,
            action.position
          );
          aliasMapRef.current.set(action.alias, itemId);
          createdItemIdsRef.current.push(itemId);
          // Brief pause for the block to render
          await sleep(300);
          break;
        }

        case "typeTerminal": {
          const itemId = aliasMapRef.current.get(action.alias);
          if (!itemId) {
            console.warn(`[ReplayRunner] Unknown alias: ${action.alias}`);
            break;
          }
          const nodeId = apiRef.current.getNodeId(itemId);
          const charDelay = action.charDelayMs ?? 30;
          const flow = connectionFlowRef.current;
          if (!flow) {
            console.warn(`[ReplayRunner] No connection data flow context`);
            break;
          }

          if (charDelay > 0) {
            // Type character by character for realistic effect
            for (const char of action.text) {
              if (stopRequestedRef.current) break;
              flow.sendDirectInput(nodeId, "left-in", { text: char });
              await sleep(charDelay);
            }
          } else {
            flow.sendDirectInput(nodeId, "left-in", { text: action.text });
          }

          if (action.execute) {
            await sleep(100);
            flow.sendDirectInput(nodeId, "left-in", {
              text: "",
              execute: true,
            });
          }
          break;
        }

        case "createEdge": {
          const sourceId = aliasMapRef.current.get(action.sourceAlias);
          const targetId = aliasMapRef.current.get(action.targetAlias);
          if (!sourceId || !targetId) {
            console.warn(
              `[ReplayRunner] Unknown alias: ${action.sourceAlias} or ${action.targetAlias}`
            );
            break;
          }
          await apiRef.current.createEdge(
            sourceId,
            targetId,
            action.sourceHandle,
            action.targetHandle
          );
          await sleep(200);
          break;
        }

        case "panCanvas": {
          apiRef.current.panTo(
            action.x,
            action.y,
            action.zoom,
            action.durationMs
          );
          await sleep(action.durationMs);
          break;
        }

        case "wait": {
          await sleep(action.durationMs);
          break;
        }

        case "deleteItem": {
          const itemId = aliasMapRef.current.get(action.alias);
          if (!itemId) {
            console.warn(`[ReplayRunner] Unknown alias: ${action.alias}`);
            break;
          }
          await apiRef.current.deleteItem(itemId);
          // Remove from tracking
          aliasMapRef.current.delete(action.alias);
          createdItemIdsRef.current = createdItemIdsRef.current.filter(
            (id) => id !== itemId
          );
          await sleep(200);
          break;
        }
      }
    },
    [flowToScreen]
  );

  // Cleanup created items between loops
  const cleanup = React.useCallback(async () => {
    const ids = [...createdItemIdsRef.current].reverse();
    for (const id of ids) {
      if (stopRequestedRef.current) break;
      try {
        await apiRef.current.deleteItem(id);
      } catch {
        // Item may already be deleted
      }
      await sleep(100);
    }
    aliasMapRef.current.clear();
    createdItemIdsRef.current = [];
  }, []);

  // Main script executor
  React.useEffect(() => {
    if (!scriptName) return;

    const script = getReplayScript(scriptName);
    if (!script) {
      console.error(`[ReplayRunner] Script not found: ${scriptName}`);
      return;
    }
    scriptRef.current = script;

    let cancelled = false;
    stopRequestedRef.current = false;

    const run = async () => {
      setIsRunning(true);
      setCursorVisible(true);
      setMoveDurationMs(0);

      // Set initial viewport
      apiRef.current.panTo(
        script.initialViewport.x,
        script.initialViewport.y,
        script.initialViewport.zoom,
        500
      );
      await sleep(600);

      // Position cursor at center initially
      const initialScreen = flowToScreen(
        script.initialViewport.x,
        script.initialViewport.y
      );
      setCursorX(initialScreen.x);
      setCursorY(initialScreen.y);

      let loop = 0;
      while (!cancelled && !stopRequestedRef.current) {
        setLoopCount(loop);
        aliasMapRef.current.clear();
        createdItemIdsRef.current = [];

        for (let i = 0; i < script.actions.length; i++) {
          if (cancelled || stopRequestedRef.current) break;
          setCurrentStep(i + 1);
          await executeAction(script.actions[i]);
        }

        if (cancelled || stopRequestedRef.current) break;

        // Loop cleanup
        if (script.cleanupOnLoop) {
          setCursorVisible(false);
          await sleep(500);
          await cleanup();

          // Reset viewport
          apiRef.current.panTo(
            script.initialViewport.x,
            script.initialViewport.y,
            script.initialViewport.zoom,
            500
          );
          await sleep(script.loopDelayMs);
          setCursorVisible(true);
          setMoveDurationMs(0);

          const screen = flowToScreen(
            script.initialViewport.x,
            script.initialViewport.y
          );
          setCursorX(screen.x);
          setCursorY(screen.y);
        } else {
          await sleep(script.loopDelayMs);
        }

        loop++;
      }

      setIsRunning(false);
      setCursorVisible(false);
    };

    run();

    return () => {
      cancelled = true;
      stopRequestedRef.current = true;
    };
  }, [scriptName, executeAction, flowToScreen, cleanup]);

  if (!scriptName || !scriptRef.current) return null;

  return (
    <>
      <ReplayCursor
        x={cursorX}
        y={cursorY}
        visible={cursorVisible}
        clicking={clicking}
        moveDurationMs={moveDurationMs}
      />
      {isRunning && (
        <ReplayControlBar
          scriptName={scriptName}
          currentStep={currentStep}
          totalSteps={scriptRef.current.actions.length}
          loopCount={loopCount}
          onStop={handleStop}
        />
      )}
    </>
  );
}
