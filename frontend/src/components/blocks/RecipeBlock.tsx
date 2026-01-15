"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Play, Check, Circle, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { Button, Badge } from "@/components/ui";
import { ConnectionHandles } from "./ConnectionHandles";

type StepStatus = "pending" | "running" | "completed" | "failed";

interface RecipeStep {
  id: string;
  name: string;
  status: StepStatus;
}

interface RecipeData extends Record<string, unknown> {
  content: string; // JSON stringified recipe data
  title?: string;
  size: { width: number; height: number };
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type RecipeNode = Node<RecipeData, "recipe">;

const statusIcons: Record<StepStatus, React.ReactNode> = {
  pending: <Circle className="w-4 h-4 text-[var(--foreground-subtle)]" />,
  running: <Loader2 className="w-4 h-4 text-[var(--accent-primary)] animate-spin" />,
  completed: <Check className="w-4 h-4 text-[var(--status-success)]" />,
  failed: <AlertCircle className="w-4 h-4 text-[var(--status-error)]" />,
};

export function RecipeBlock({ id, data, selected }: NodeProps<RecipeNode>) {
  const [title, setTitle] = React.useState(data.title || "Recipe");
  const [steps, setSteps] = React.useState<RecipeStep[]>(() => {
    try {
      const parsed = JSON.parse(data.content || "{}");
      return parsed.steps || [
        { id: "1", name: "Initialize environment", status: "pending" },
        { id: "2", name: "Run tests", status: "pending" },
        { id: "3", name: "Deploy changes", status: "pending" },
      ];
    } catch {
      return [];
    }
  });

  const isRunning = steps.some((step) => step.status === "running");
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const connectorsVisible = selected || Boolean(data.connectorMode);

  const handleRun = () => {
    // This would trigger the actual recipe execution via API
    console.log("Running recipe:", title);
  };

  return (
    <BlockWrapper
      selected={selected}
      className="p-0 overflow-hidden flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
        <div className="flex items-center gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-sm font-medium text-[var(--foreground)] bg-transparent focus:outline-none"
          />
          <Badge
            variant={isRunning ? "warning" : completedCount === steps.length ? "success" : "secondary"}
            size="sm"
          >
            {isRunning ? "Running" : `${completedCount}/${steps.length}`}
          </Badge>
        </div>
      </div>

      {/* Steps */}
      <div className="p-3 space-y-2 flex-1 overflow-y-auto">
        {steps.map((step, index) => (
          <div
            key={step.id}
            className={cn(
              "flex items-center gap-3 px-2 py-1.5 rounded",
              step.status === "running" && "bg-[var(--accent-primary)]/10",
              step.status === "failed" && "bg-[var(--status-error)]/10"
            )}
          >
            <span className="text-xs text-[var(--foreground-subtle)] w-4">
              {index + 1}.
            </span>
            {statusIcons[step.status]}
            <span
              className={cn(
                "flex-1 text-sm",
                step.status === "completed" && "text-[var(--foreground-muted)]",
                step.status === "failed" && "text-[var(--status-error)]",
                step.status === "running" && "text-[var(--accent-primary)]",
                step.status === "pending" && "text-[var(--foreground)]"
              )}
            >
              {step.name}
            </span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-[var(--border)] bg-[var(--background)] shrink-0">
        <Button
          variant={isRunning ? "secondary" : "primary"}
          size="sm"
          onClick={handleRun}
          disabled={isRunning}
          leftIcon={isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          className="w-full"
        >
          {isRunning ? "Running..." : "Run Recipe"}
        </Button>
      </div>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default RecipeBlock;
