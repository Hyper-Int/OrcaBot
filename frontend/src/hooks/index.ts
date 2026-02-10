// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

export { useCollaboration, type UseCollaborationOptions, type UseCollaborationState, type UseCollaborationActions } from "./useCollaboration";
export { usePresence, type UsePresenceOptions, type UsePresenceResult } from "./usePresence";
export { useTerminal, shouldBlockInput, getTerminalStatus, type UseTerminalOptions, type UseTerminalState, type UseTerminalActions, type UseTerminalCallbacks } from "./useTerminal";
export { useTerminalAudio } from "./useTerminalAudio";
export { useDebouncedCallback } from "./useDebounce";
export { useUICommands } from "./useUICommands";
export { useUndoRedo } from "./useUndoRedo";
export { useAgentTasks, type UseAgentTasksOptions, type UseAgentTasksResult } from "./useAgentTasks";
export { useChat, type UseChatState, type UseChatActions, type UseChatReturn, type UseChatOptions, type PendingToolCall } from "./useChat";
export { useUIGuidance, type UseUIGuidanceReturn, type UseUIGuidanceOptions, type ActiveHighlight, type ActiveTooltip, type UIGuidanceState, type UIGuidanceActions } from "./useUIGuidance";
export { useFolderImport, type FolderImportState } from "./useFolderImport";
