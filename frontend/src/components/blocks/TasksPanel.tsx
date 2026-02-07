// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: tasks-panel-v7-no-double-fetch

"use client";

const MODULE_REVISION = 'tasks-panel-v7-no-double-fetch';
console.log(`[TasksPanel] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  X,
  Plus,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  AlertCircle,
  PlayCircle,
  CircleDot,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ListTodo,
  Loader2,
  Trash2,
  Edit2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  type AgentTask,
  type AgentTaskStatus,
} from "@/lib/api/cloudflare/tasks";
import type { IncomingCollabMessage } from "@/types/collaboration";

// Status configuration
const STATUS_CONFIG: Record<AgentTaskStatus, {
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}> = {
  pending: {
    label: "Pending",
    icon: <Clock className="w-3 h-3" />,
    color: "text-gray-500",
    bgColor: "bg-gray-100 dark:bg-gray-800",
  },
  in_progress: {
    label: "In Progress",
    icon: <PlayCircle className="w-3 h-3" />,
    color: "text-blue-600",
    bgColor: "bg-blue-100 dark:bg-blue-900/30",
  },
  blocked: {
    label: "Blocked",
    icon: <AlertCircle className="w-3 h-3" />,
    color: "text-orange-600",
    bgColor: "bg-orange-100 dark:bg-orange-900/30",
  },
  completed: {
    label: "Completed",
    icon: <CheckCircle2 className="w-3 h-3" />,
    color: "text-emerald-600",
    bgColor: "bg-emerald-100 dark:bg-emerald-900/30",
  },
  cancelled: {
    label: "Cancelled",
    icon: <XCircle className="w-3 h-3" />,
    color: "text-red-500",
    bgColor: "bg-red-100 dark:bg-red-900/30",
  },
};

// Status badge component
const StatusBadge: React.FC<{ status: AgentTaskStatus }> = ({ status }) => {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium",
        config.color,
        config.bgColor
      )}
    >
      {config.icon}
      {config.label}
    </span>
  );
};

// Task item component
interface TaskItemProps {
  task: AgentTask;
  onStatusChange: (taskId: string, status: AgentTaskStatus) => void;
  onDelete: (taskId: string) => void;
  isUpdating: boolean;
}

const TaskItem: React.FC<TaskItemProps> = ({ task, onStatusChange, onDelete, isUpdating }) => {
  const [expanded, setExpanded] = React.useState(false);

  const nextStatus = (current: AgentTaskStatus): AgentTaskStatus | null => {
    switch (current) {
      case "pending":
        return "in_progress";
      case "in_progress":
        return "completed";
      case "blocked":
        return "in_progress";
      default:
        return null;
    }
  };

  const canAdvance = task.status !== "completed" && task.status !== "cancelled";
  const next = nextStatus(task.status);

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--background)]">
      <div
        className="flex items-start gap-2 px-2 py-1.5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Status toggle button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (canAdvance && next) {
              onStatusChange(task.id, next);
            }
          }}
          disabled={!canAdvance || isUpdating}
          className={cn(
            "w-4 h-4 mt-0.5 rounded border flex items-center justify-center transition-colors flex-shrink-0",
            task.status === "completed"
              ? "bg-emerald-500 border-emerald-500 text-white"
              : task.status === "in_progress"
                ? "bg-blue-500 border-blue-500 text-white"
                : "border-[var(--border-strong)] hover:border-[var(--accent-primary)]"
          )}
          title={canAdvance && next ? `Mark as ${STATUS_CONFIG[next].label}` : undefined}
        >
          {isUpdating ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : task.status === "completed" ? (
            <Check className="w-3 h-3" />
          ) : task.status === "in_progress" ? (
            <CircleDot className="w-2.5 h-2.5" />
          ) : null}
        </button>

        {/* Task content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-sm font-medium truncate",
                task.status === "completed"
                  ? "text-[var(--foreground-subtle)] line-through"
                  : "text-[var(--foreground)]"
              )}
            >
              {task.subject}
            </span>
          </div>
          {task.ownerAgent && (
            <div className="text-[10px] text-[var(--foreground-muted)] truncate">
              {task.ownerAgent}
            </div>
          )}
        </div>

        {/* Status and expand */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <StatusBadge status={task.status} />
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-[var(--foreground-muted)]" />
          ) : (
            <ChevronRight className="w-3 h-3 text-[var(--foreground-muted)]" />
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-2 pb-2 pt-1 border-t border-[var(--border)] space-y-2">
          {task.description && (
            <div className="text-xs text-[var(--foreground-subtle)] whitespace-pre-wrap">
              {task.description}
            </div>
          )}

          <div className="flex flex-wrap gap-2 text-[10px] text-[var(--foreground-muted)]">
            {task.priority !== 0 && (
              <span>Priority: {task.priority}</span>
            )}
            {task.blockedBy.length > 0 && (
              <span className="text-orange-600">
                Blocked by: {task.blockedBy.length} task(s)
              </span>
            )}
            {task.blocks.length > 0 && (
              <span>Blocks: {task.blocks.length} task(s)</span>
            )}
          </div>

          <div className="flex items-center gap-1 pt-1">
            {/* Status quick actions */}
            {task.status !== "completed" && task.status !== "cancelled" && (
              <>
                {task.status === "pending" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[10px] h-6 px-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStatusChange(task.id, "in_progress");
                    }}
                    disabled={isUpdating}
                  >
                    <PlayCircle className="w-3 h-3 mr-1" />
                    Start
                  </Button>
                )}
                {task.status === "in_progress" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[10px] h-6 px-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStatusChange(task.id, "completed");
                      }}
                      disabled={isUpdating}
                    >
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Complete
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[10px] h-6 px-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStatusChange(task.id, "blocked");
                      }}
                      disabled={isUpdating}
                    >
                      <AlertCircle className="w-3 h-3 mr-1" />
                      Block
                    </Button>
                  </>
                )}
                {task.status === "blocked" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[10px] h-6 px-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStatusChange(task.id, "in_progress");
                    }}
                    disabled={isUpdating}
                  >
                    <RotateCcw className="w-3 h-3 mr-1" />
                    Unblock
                  </Button>
                )}
              </>
            )}
            {(task.status === "completed" || task.status === "cancelled") && (
              <Button
                variant="ghost"
                size="sm"
                className="text-[10px] h-6 px-2"
                onClick={(e) => {
                  e.stopPropagation();
                  onStatusChange(task.id, "pending");
                }}
                disabled={isUpdating}
              >
                <RotateCcw className="w-3 h-3 mr-1" />
                Reopen
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-[10px] h-6 px-2 text-red-600 hover:text-red-700 ml-auto"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm("Delete this task?")) {
                  onDelete(task.id);
                }
              }}
              disabled={isUpdating}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

// Add task form
interface AddTaskFormProps {
  onAdd: (subject: string, description?: string) => void;
  onCancel: () => void;
  isLoading: boolean;
}

const AddTaskForm: React.FC<AddTaskFormProps> = ({ onAdd, onCancel, isLoading }) => {
  const [subject, setSubject] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [showDescription, setShowDescription] = React.useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (subject.trim()) {
      onAdd(subject.trim(), description.trim() || undefined);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2 p-2 rounded border border-[var(--border)] bg-[var(--background)]">
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Task subject..."
        autoFocus
        className={cn(
          "w-full px-2 py-1 text-sm rounded border border-[var(--border)]",
          "bg-[var(--background)] text-[var(--foreground)]",
          "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
        )}
      />
      {showDescription ? (
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)..."
          rows={2}
          className={cn(
            "w-full px-2 py-1 text-xs rounded border border-[var(--border)]",
            "bg-[var(--background)] text-[var(--foreground)]",
            "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]",
            "resize-none"
          )}
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowDescription(true)}
          className="text-[10px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
        >
          + Add description
        </button>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!subject.trim() || isLoading}
        >
          {isLoading ? (
            <Loader2 className="w-3 h-3 animate-spin mr-1" />
          ) : (
            <Plus className="w-3 h-3 mr-1" />
          )}
          Add Task
        </Button>
      </div>
    </form>
  );
};

// Filter tabs
type FilterTab = "all" | "active" | "completed";

// Main TasksPanel component
interface TasksPanelProps {
  dashboardId: string;
  sessionId?: string; // Optional: filter to specific terminal session
  onClose?: () => void;
  className?: string;
  /** Optional: real-time message handler from WebSocket */
  onMessage?: IncomingCollabMessage;
}

export const TasksPanel: React.FC<TasksPanelProps> = ({
  dashboardId,
  sessionId,
  onClose,
  className,
  onMessage,
}) => {
  const queryClient = useQueryClient();
  const [filter, setFilter] = React.useState<FilterTab>("active");
  const [isAdding, setIsAdding] = React.useState(false);
  const [updatingTaskId, setUpdatingTaskId] = React.useState<string | null>(null);

  // Query tasks - server returns dashboard-wide + session tasks when sessionId is provided
  // Always fetch with includeCompleted so we can show completed tab
  const tasksQuery = useQuery({
    queryKey: ["dashboard-tasks", dashboardId, sessionId],
    queryFn: () => listTasks(dashboardId, {
      sessionId,
      includeCompleted: true, // Always fetch all tasks, filter in UI for tabs
    }),
    staleTime: 30000,
  });

  // Handle real-time updates from WebSocket
  React.useEffect(() => {
    if (!onMessage) return;

    // Helper to check if a task belongs to this view
    // When sessionId is provided, only show tasks for this session or dashboard-wide tasks
    const taskBelongsToView = (task: AgentTask): boolean => {
      if (!sessionId) return true; // No session filter, show all
      // Show if task is dashboard-wide (no sessionId) or matches our session
      return !task.sessionId || task.sessionId === sessionId;
    };

    switch (onMessage.type) {
      case "task_create":
      case "task_update":
        // Only process if task belongs to this view
        if (!taskBelongsToView(onMessage.task)) return;
        // Optimistically update the cache with the new task
        queryClient.setQueryData<AgentTask[]>(
          ["dashboard-tasks", dashboardId, sessionId],
          (old = []) => {
            const existing = old.findIndex((t) => t.id === onMessage.task.id);
            if (existing >= 0) {
              const updated = [...old];
              updated[existing] = onMessage.task;
              return updated;
            }
            return [...old, onMessage.task];
          }
        );
        break;
      case "task_delete":
        queryClient.setQueryData<AgentTask[]>(
          ["dashboard-tasks", dashboardId, sessionId],
          (old = []) => old.filter((t) => t.id !== onMessage.taskId)
        );
        break;
    }
  }, [onMessage, dashboardId, sessionId, queryClient]);

  // Create task mutation
  // Note: Tasks are dashboard-wide by default for multiplayer collaboration
  // sessionId is only used for filtering/viewing, not for creating
  const createMutation = useMutation({
    mutationFn: (data: { subject: string; description?: string }) =>
      createTask(dashboardId, data),
    onSuccess: (newTask) => {
      queryClient.setQueryData<AgentTask[]>(
        ["dashboard-tasks", dashboardId, sessionId],
        (old = []) => [...old, newTask]
      );
      setIsAdding(false);
    },
  });

  // Update task mutation
  // Pass sessionId to access session-scoped tasks created by MCP tools
  const updateMutation = useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: { status?: AgentTaskStatus } }) =>
      updateTask(dashboardId, taskId, data, { sessionId }),
    onMutate: ({ taskId }) => {
      setUpdatingTaskId(taskId);
    },
    onSuccess: (updatedTask) => {
      queryClient.setQueryData<AgentTask[]>(
        ["dashboard-tasks", dashboardId, sessionId],
        (old = []) => old.map((t) => (t.id === updatedTask.id ? updatedTask : t))
      );
    },
    onSettled: () => {
      setUpdatingTaskId(null);
    },
  });

  // Delete task mutation
  // Pass sessionId to access session-scoped tasks created by MCP tools
  const deleteMutation = useMutation({
    mutationFn: (taskId: string) => deleteTask(dashboardId, taskId, { sessionId }),
    onSuccess: (_, taskId) => {
      queryClient.setQueryData<AgentTask[]>(
        ["dashboard-tasks", dashboardId, sessionId],
        (old = []) => old.filter((t) => t.id !== taskId)
      );
    },
  });

  // Filter tasks
  const tasks = tasksQuery.data || [];
  const filteredTasks = tasks.filter((task) => {
    switch (filter) {
      case "active":
        return task.status !== "completed" && task.status !== "cancelled";
      case "completed":
        return task.status === "completed" || task.status === "cancelled";
      default:
        return true;
    }
  });

  // Sort: in_progress first, then pending, then blocked, then completed
  const sortedTasks = [...filteredTasks].sort((a, b) => {
    const order: Record<AgentTaskStatus, number> = {
      in_progress: 0,
      pending: 1,
      blocked: 2,
      completed: 3,
      cancelled: 4,
    };
    const orderDiff = order[a.status] - order[b.status];
    if (orderDiff !== 0) return orderDiff;
    // Within same status, sort by priority (higher first) then creation date
    if (a.priority !== b.priority) return b.priority - a.priority;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const activeCounts = {
    all: tasks.length,
    active: tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled").length,
    completed: tasks.filter((t) => t.status === "completed" || t.status === "cancelled").length,
  };

  return (
    <div
      className={cn(
        "rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md w-80",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
          <ListTodo className="w-3 h-3" />
          <span>Agent Tasks</span>
          {tasksQuery.isLoading && (
            <Loader2 className="w-3 h-3 animate-spin text-[var(--foreground-muted)]" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setIsAdding(true)}
            className="h-5 w-5"
            title="Add task"
            disabled={isAdding}
          >
            <Plus className="w-3 h-3" />
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose} className="h-5 w-5 nodrag">
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] text-[10px]">
        {(["active", "all", "completed"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={cn(
              "px-2 py-0.5 rounded transition-colors capitalize",
              filter === tab
                ? "bg-[var(--accent-primary)] text-white"
                : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background-hover)]"
            )}
          >
            {tab} ({activeCounts[tab]})
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-2 space-y-2 max-h-[400px] overflow-auto">
        {/* Add task form */}
        {isAdding && (
          <AddTaskForm
            onAdd={(subject, description) => createMutation.mutate({ subject, description })}
            onCancel={() => setIsAdding(false)}
            isLoading={createMutation.isPending}
          />
        )}

        {/* Task list */}
        {tasksQuery.isLoading ? (
          <div className="text-xs text-[var(--foreground-muted)] text-center py-4">
            Loading tasks...
          </div>
        ) : sortedTasks.length === 0 ? (
          <div className="text-xs text-[var(--foreground-muted)] text-center py-4">
            {filter === "active"
              ? "No active tasks"
              : filter === "completed"
                ? "No completed tasks"
                : "No tasks yet"}
          </div>
        ) : (
          <div className="space-y-1">
            {sortedTasks.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onStatusChange={(taskId, status) =>
                  updateMutation.mutate({ taskId, data: { status } })
                }
                onDelete={(taskId) => deleteMutation.mutate(taskId)}
                isUpdating={
                  updatingTaskId === task.id ||
                  deleteMutation.isPending
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer with summary */}
      {tasks.length > 0 && (
        <div className="px-2 py-1 border-t border-[var(--border)] text-[10px] text-[var(--foreground-muted)]">
          {activeCounts.active} active, {activeCounts.completed} completed
        </div>
      )}
    </div>
  );
};

export default TasksPanel;
