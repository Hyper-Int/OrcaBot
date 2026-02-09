// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: agent-tasks-hook-v7-session-mutations

"use client";

const MODULE_REVISION = 'agent-tasks-hook-v7-session-mutations';
console.log(`[useAgentTasks] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  type AgentTask,
  type AgentTaskStatus,
} from "@/lib/api/cloudflare/tasks";
import type { IncomingCollabMessage } from "@/types/collaboration";

export interface UseAgentTasksOptions {
  dashboardId: string;
  sessionId?: string;
  /** Include completed/cancelled tasks. Default: false (matches server default) */
  includeCompleted?: boolean;
  enabled?: boolean;
}

export interface UseAgentTasksResult {
  tasks: AgentTask[];
  isLoading: boolean;
  error: Error | null;
  // Counts
  counts: {
    total: number;
    pending: number;
    inProgress: number;
    blocked: number;
    completed: number;
    cancelled: number;
  };
  // Actions
  addTask: (subject: string, description?: string) => Promise<AgentTask>;
  updateTaskStatus: (taskId: string, status: AgentTaskStatus) => Promise<AgentTask>;
  removeTask: (taskId: string) => Promise<void>;
  // Real-time handling
  handleRealtimeMessage: (message: IncomingCollabMessage) => void;
}

/**
 * Hook for managing agent tasks with real-time updates
 */
export function useAgentTasks(options: UseAgentTasksOptions): UseAgentTasksResult {
  const { dashboardId, sessionId, includeCompleted = false, enabled = true } = options;
  const queryClient = useQueryClient();
  // Include includeCompleted in query key so different views have separate caches
  const queryKey = ["dashboard-tasks", dashboardId, sessionId, includeCompleted];

  // Query tasks
  const tasksQuery = useQuery({
    queryKey,
    queryFn: () => listTasks(dashboardId, { sessionId, includeCompleted }),
    staleTime: 30000,
    enabled,
  });

  // Create task mutation - dashboard-wide by default (no sessionId)
  const createMutation = useMutation({
    mutationFn: (data: { subject: string; description?: string }) =>
      createTask(dashboardId, data),
    onSuccess: (newTask) => {
      queryClient.setQueryData<AgentTask[]>(queryKey, (old = []) => [...old, newTask]);
    },
  });

  // Update task mutation
  // Pass sessionId to access session-scoped tasks
  const updateMutation = useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: { status?: AgentTaskStatus } }) =>
      updateTask(dashboardId, taskId, data, { sessionId }),
    onSuccess: (updatedTask) => {
      queryClient.setQueryData<AgentTask[]>(queryKey, (old = []) =>
        old.map((t) => (t.id === updatedTask.id ? updatedTask : t))
      );
    },
  });

  // Delete task mutation
  // Pass sessionId to access session-scoped tasks
  const deleteMutation = useMutation({
    mutationFn: (taskId: string) => deleteTask(dashboardId, taskId, { sessionId }),
    onSuccess: (_, taskId) => {
      queryClient.setQueryData<AgentTask[]>(queryKey, (old = []) =>
        old.filter((t) => t.id !== taskId)
      );
    },
  });

  // Handle real-time messages
  const handleRealtimeMessage = React.useCallback(
    (message: IncomingCollabMessage) => {
      // Helper to check if a task belongs to this view
      // When sessionId is provided, only accept tasks for this session or dashboard-wide tasks
      const taskBelongsToView = (task: AgentTask): boolean => {
        if (!sessionId) return true; // No session filter, show all dashboard-wide tasks
        // Show if task is dashboard-wide (no sessionId) or matches our session
        return !task.sessionId || task.sessionId === sessionId;
      };

      // Helper to check if a task should be visible based on includeCompleted setting
      const taskVisibleByStatus = (task: AgentTask): boolean => {
        if (includeCompleted) return true;
        // When includeCompleted is false, drop completed/cancelled tasks to match server behavior
        return task.status !== "completed" && task.status !== "cancelled";
      };

      switch (message.type) {
        case "task_create":
          queryClient.setQueryData<AgentTask[]>(queryKey, (old = []) => {
            if (old.some((t) => t.id === message.task.id)) return old;
            // Only add if task belongs to this view and is visible by status
            if (!taskBelongsToView(message.task)) return old;
            if (!taskVisibleByStatus(message.task)) return old;
            return [...old, message.task];
          });
          break;
        case "task_update":
          queryClient.setQueryData<AgentTask[]>(queryKey, (old = []) => {
            const taskInView = taskBelongsToView(message.task);
            const taskVisible = taskVisibleByStatus(message.task);
            return old
              .map((t) => (t.id === message.task.id ? message.task : t))
              // Filter out tasks that no longer belong to this view or became completed/cancelled
              .filter((t) => t.id !== message.task.id || (taskInView && taskVisible));
          });
          break;
        case "task_delete":
          // No filter needed - removing a non-existent task is a no-op
          queryClient.setQueryData<AgentTask[]>(queryKey, (old = []) =>
            old.filter((t) => t.id !== message.taskId)
          );
          break;
      }
    },
    [queryClient, queryKey, sessionId, includeCompleted]
  );

  // Compute counts
  const tasks = tasksQuery.data || [];
  const counts = React.useMemo(() => {
    const result = {
      total: tasks.length,
      pending: 0,
      inProgress: 0,
      blocked: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const task of tasks) {
      switch (task.status) {
        case "pending":
          result.pending++;
          break;
        case "in_progress":
          result.inProgress++;
          break;
        case "blocked":
          result.blocked++;
          break;
        case "completed":
          result.completed++;
          break;
        case "cancelled":
          result.cancelled++;
          break;
      }
    }
    return result;
  }, [tasks]);

  return {
    tasks,
    isLoading: tasksQuery.isLoading,
    error: tasksQuery.error,
    counts,
    addTask: (subject: string, description?: string) =>
      createMutation.mutateAsync({ subject, description }),
    updateTaskStatus: (taskId: string, status: AgentTaskStatus) =>
      updateMutation.mutateAsync({ taskId, data: { status } }),
    removeTask: (taskId: string) => deleteMutation.mutateAsync(taskId),
    handleRealtimeMessage,
  };
}

export default useAgentTasks;
