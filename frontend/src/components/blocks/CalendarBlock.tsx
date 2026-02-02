// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  Calendar,
  RefreshCw,
  Clock,
  CheckCircle,
  Loader2,
  Settings,
  LogOut,
  MapPin,
  ExternalLink,
  Minimize2,
} from "lucide-react";
import { GoogleCalendarIcon } from "@/components/icons";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  getCalendarIntegration,
  getCalendarStatus,
  getCalendarEvents,
  syncCalendar,
  setupCalendarMirror,
  unlinkCalendarMirror,
  type CalendarIntegration,
  type CalendarStatus,
  type CalendarEvent,
} from "@/lib/api/cloudflare";
import { API } from "@/config/env";
import type { DashboardItem } from "@/types/dashboard";

interface CalendarData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  dashboardId?: string;
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type CalendarNode = Node<CalendarData, "calendar">;

export function CalendarBlock({ id, data, selected }: NodeProps<CalendarNode>) {
  const dashboardId = data.dashboardId;
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
    };
  }, []);

  const handleMinimize = () => {
    const expandedSize = data.size;
    setIsAnimatingMinimize(true);
    data.onItemChange?.({
      metadata: { ...data.metadata, expandedSize },
      size: MINIMIZED_SIZE,
    });
    minimizeTimeoutRef.current = setTimeout(() => {
      setIsAnimatingMinimize(false);
      data.onItemChange?.({
        metadata: { ...data.metadata, minimized: true, expandedSize },
      });
    }, 350);
  };

  const handleExpand = () => {
    const savedSize = data.metadata?.expandedSize as { width: number; height: number } | undefined;
    setExpandAnimation("animate-expand-bounce");
    setTimeout(() => setExpandAnimation(null), 300);
    data.onItemChange?.({
      metadata: { ...data.metadata, minimized: false },
      size: savedSize || { width: 320, height: 400 },
    });
  };

  // Integration state
  const [integration, setIntegration] = React.useState<CalendarIntegration | null>(null);
  const [status, setStatus] = React.useState<CalendarStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tokenRevoked, setTokenRevoked] = React.useState(false);
  const [enabling, setEnabling] = React.useState(false);

  // Events state
  const [events, setEvents] = React.useState<CalendarEvent[]>([]);
  const [eventsTotal, setEventsTotal] = React.useState(0);
  const [eventsLoading, setEventsLoading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);

  // Selected event state
  const [selectedEvent, setSelectedEvent] = React.useState<CalendarEvent | null>(null);

  // Track if initial load is done (per dashboard to handle Fast Refresh/Strict Mode)
  const initialLoadDone = React.useRef(false);
  const loadedDashboardRef = React.useRef<string | null>(null);

  // Load integration status
  const loadIntegration = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      // Only show loading spinner on initial load, not refreshes
      if (!initialLoadDone.current) {
        setLoading(true);
      }
      setError(null);
      const [integrationData, statusData] = await Promise.all([
        getCalendarIntegration(dashboardId),
        getCalendarStatus(dashboardId).catch(() => null),
      ]);
      setIntegration(integrationData);
      setStatus(statusData);
      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Calendar");
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  // Load events
  const loadEvents = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      setEventsLoading(true);
      // Fetch events for next 30 days
      const now = new Date();
      const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const response = await getCalendarEvents(dashboardId, {
        limit: 50,
        timeMin: now.toISOString(),
        timeMax: timeMax.toISOString(),
      });
      setEvents(response.events);
      setEventsTotal(response.total);
    } catch (err) {
      console.error("Failed to load events:", err);
    } finally {
      setEventsLoading(false);
    }
  }, [dashboardId]);

  // Initial load - skip duplicate loads in Strict Mode/Fast Refresh
  React.useEffect(() => {
    if (!dashboardId) return;
    if (loadedDashboardRef.current === dashboardId) return;
    loadedDashboardRef.current = dashboardId;
    loadIntegration();
  }, [dashboardId, loadIntegration]);

  // Load events when integration is ready (use booleans to avoid flicker from object reference changes)
  const calendarReady = Boolean(integration?.connected && integration?.linked);
  React.useEffect(() => {
    if (calendarReady) {
      loadEvents();
    }
  }, [calendarReady, loadEvents]);

  // Sync handler
  const handleSync = async () => {
    if (!dashboardId) return;
    try {
      setSyncing(true);
      await syncCalendar(dashboardId);
      await loadEvents();
      await loadIntegration();
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncing(false);
    }
  };

  // Connect Calendar
  const handleConnect = () => {
    if (!dashboardId) return;
    const connectUrl = `${API.cloudflare.base}/integrations/google/calendar/connect?dashboard_id=${dashboardId}&mode=popup`;
    const popup = window.open(connectUrl, "calendar-connect", "width=600,height=700");

    let completed = false;

    const completeSetup = async () => {
      if (completed) return;
      completed = true;
      window.removeEventListener("message", handleMessage);
      if (pollInterval) clearInterval(pollInterval);
      popup?.close();
      try {
        await setupCalendarMirror(dashboardId);
        await loadIntegration();
        await loadEvents();
      } catch (err) {
        console.error("Failed to set up Calendar mirror:", err);
        // Still reload integration state even if setup fails
        await loadIntegration();
      }
    };

    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type === "calendar-auth-complete") {
        await completeSetup();
      }
    };
    window.addEventListener("message", handleMessage);

    // Also poll for popup close (backup in case postMessage fails due to origin mismatch)
    const pollInterval = setInterval(async () => {
      if (popup?.closed) {
        clearInterval(pollInterval);
        // Give a moment for postMessage to arrive, then check integration status
        setTimeout(async () => {
          if (!completed) {
            await completeSetup();
          }
        }, 500);
      }
    }, 500);
  };

  // Disconnect Calendar
  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await unlinkCalendarMirror(dashboardId);
      setIntegration(null);
      setStatus(null);
      setEvents([]);
      setSelectedEvent(null);
    } catch (err) {
      console.error("Failed to disconnect Calendar:", err);
    }
  };

  // Format date for display
  const formatEventTime = (event: CalendarEvent) => {
    if (event.allDay) {
      const date = new Date(event.startTime);
      return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    }
    const start = new Date(event.startTime);
    const end = new Date(event.endTime);
    const sameDay = start.toDateString() === end.toDateString();

    if (sameDay) {
      return `${start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }
    return `${start.toLocaleDateString([], { month: "short", day: "numeric" })} - ${end.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  };

  // Format relative date
  const formatRelativeDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = date.getTime() - now.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      return "Today";
    } else if (days === 1) {
      return "Tomorrow";
    } else if (days < 7) {
      return date.toLocaleDateString([], { weekday: "long" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  // Group events by date
  const groupedEvents = React.useMemo(() => {
    const groups: Map<string, CalendarEvent[]> = new Map();
    for (const event of events) {
      const dateKey = new Date(event.startTime).toDateString();
      const existing = groups.get(dateKey) || [];
      existing.push(event);
      groups.set(dateKey, existing);
    }
    return groups;
  }, [events]);

  // Header
  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <GoogleCalendarIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.emailAddress || status?.emailAddress || "Calendar"}
      </div>
      <div className="flex items-center gap-1">
        {integration?.connected && integration?.linked && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleSync}
            disabled={syncing}
            title="Sync"
            className="nodrag"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", syncing && "animate-spin")} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleMinimize}
          title="Minimize"
          className="nodrag"
        >
          <Minimize2 className="w-3.5 h-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Settings"
              className="nodrag"
            >
              <Settings className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {integration?.connected && (
              <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
                <LogOut className="w-3.5 h-3.5 mr-2" />
                Disconnect Calendar
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={handleConnect}>
                <Calendar className="w-3.5 h-3.5 mr-2" />
                Connect Calendar
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  // Settings menu for minimized view
  const settingsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Settings"
          className="nodrag h-5 w-5"
        >
          <Settings className="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {integration?.connected && (
          <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
            <LogOut className="w-3.5 h-3.5 mr-2" />
            Disconnect Calendar
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={handleConnect}>
            <Calendar className="w-3.5 h-3.5 mr-2" />
            Connect Calendar
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Minimized view - only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<GoogleCalendarIcon className="w-14 h-14" />}
        label={integration?.emailAddress || "Calendar"}
        onExpand={handleExpand}
        settingsMenu={settingsMenu}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  // Loading state
  if (loading) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={expandAnimation || undefined}>
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex items-center justify-center h-full p-4">
            <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Not connected state
  if (!integration?.connected) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200}>
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center h-full p-4">
            <Calendar className="w-8 h-8 text-[var(--text-muted)] mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect Google Calendar to view events
            </p>
            <Button size="sm" onClick={handleConnect} className="nodrag">
              Connect Calendar
            </Button>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Not linked state
  if (!integration?.linked) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200}>
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center h-full p-4">
            <Calendar className="w-8 h-8 text-[var(--text-muted)] mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Enable Calendar sync for this dashboard
            </p>
            <Button
              size="sm"
              disabled={enabling}
              onClick={async () => {
                if (!dashboardId || enabling) return;
                try {
                  setEnabling(true);
                  setTokenRevoked(false);
                  await setupCalendarMirror(dashboardId);
                  await loadIntegration();
                } catch (err) {
                  // Check if token was revoked (user needs to reconnect)
                  const msg = err instanceof Error ? err.message : String(err);
                  if (msg.includes("TOKEN_REVOKED") || msg.includes("revoked")) {
                    setTokenRevoked(true);
                  } else {
                    console.error("Failed to setup calendar:", err);
                  }
                } finally {
                  setEnabling(false);
                }
              }}
              className="nodrag"
            >
              {enabling ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Syncing...
                </>
              ) : (
                "Enable Sync"
              )}
            </Button>
            {tokenRevoked && (
              <p className="text-[10px] text-red-500 text-center mt-2">
                Access was revoked. Please disconnect and reconnect Calendar.
              </p>
            )}
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Main view with events
  return (
    <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={cn(expandAnimation)}>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
      {/* All content fades during minimize */}
      <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
        {header}

        {/* Two pane layout */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Event list */}
          <div className={cn(
            "flex flex-col overflow-hidden border-r border-[var(--border)]",
            selectedEvent ? "w-1/2" : "w-full"
          )}>
            <div className="flex-1 overflow-y-auto">
              {eventsLoading ? (
                <div className="flex items-center justify-center p-4">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
                </div>
              ) : events.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-4">
                  <p className="text-xs text-[var(--text-muted)]">No upcoming events</p>
                </div>
              ) : (
                Array.from(groupedEvents.entries()).map(([dateKey, dayEvents]) => (
                  <div key={dateKey}>
                    <div className="px-2 py-1 text-[9px] font-medium text-[var(--text-muted)] bg-[var(--background)] sticky top-0">
                      {formatRelativeDate(dayEvents[0].startTime)}
                    </div>
                    {dayEvents.map(event => (
                      <button
                        key={event.eventId}
                        onClick={() => setSelectedEvent(event)}
                        className={cn(
                          "nodrag w-full px-2 py-1.5 text-left border-b border-[var(--border)] hover:bg-[var(--background)] transition-colors",
                          selectedEvent?.eventId === event.eventId && "bg-[var(--background)]"
                        )}
                      >
                        <div className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                          <span className="text-[10px] truncate flex-1 font-medium text-[var(--text-primary)]">
                            {event.summary || "(No title)"}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5 ml-3">
                          <Clock className="w-2.5 h-2.5 text-[var(--text-muted)]" />
                          <span className="text-[9px] text-[var(--text-muted)]">
                            {event.allDay ? "All day" : `${new Date(event.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${new Date(event.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                          </span>
                        </div>
                        {event.location && (
                          <div className="flex items-center gap-1 mt-0.5 ml-3">
                            <MapPin className="w-2.5 h-2.5 text-[var(--text-muted)]" />
                            <span className="text-[9px] text-[var(--text-muted)] truncate">
                              {event.location}
                            </span>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>

            {/* Status footer */}
            <div className="px-2 py-1 border-t border-[var(--border)] bg-[var(--background)]">
              <div className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
                <CheckCircle className="w-2.5 h-2.5 text-green-500" />
                <span>{eventsTotal} events</span>
                {status?.lastSyncedAt && (
                  <>
                    <span>·</span>
                    <Clock className="w-2.5 h-2.5" />
                    <span>{new Date(status.lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Event detail */}
          {selectedEvent && (
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {/* Detail header */}
              <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelectedEvent(null)}
                  className="nodrag"
                >
                  <span className="text-xs">&larr;</span>
                </Button>
                <div className="flex-1" />
                {selectedEvent.htmlLink && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => window.open(selectedEvent.htmlLink!, "_blank")}
                    title="Open in Google Calendar"
                    className="nodrag"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </Button>
                )}
              </div>

              {/* Event content */}
              <div className="flex-1 overflow-y-auto p-2">
                <h3 className="text-xs font-medium text-[var(--text-primary)] mb-1">
                  {selectedEvent.summary || "(No title)"}
                </h3>
                <p className="text-[10px] text-[var(--text-secondary)] mb-2">
                  {formatEventTime(selectedEvent)}
                </p>
                {selectedEvent.location && (
                  <div className="flex items-start gap-1 mb-2">
                    <MapPin className="w-3 h-3 text-[var(--text-muted)] shrink-0 mt-0.5" />
                    <p className="text-[10px] text-[var(--text-secondary)]">
                      {selectedEvent.location}
                    </p>
                  </div>
                )}
                {selectedEvent.description && (
                  <p className="text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap mt-2">
                    {selectedEvent.description}
                  </p>
                )}
                {selectedEvent.attendees.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[9px] font-medium text-[var(--text-muted)] mb-1">Attendees</p>
                    {selectedEvent.attendees.map((attendee, i) => (
                      <p key={i} className="text-[10px] text-[var(--text-secondary)]">
                        {attendee.displayName || attendee.email}
                        {attendee.responseStatus && (
                          <span className="text-[var(--text-muted)]"> ({attendee.responseStatus})</span>
                        )}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </BlockWrapper>
  );
}

export default CalendarBlock;
