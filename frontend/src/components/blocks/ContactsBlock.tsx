// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  Users,
  RefreshCw,
  Clock,
  CheckCircle,
  Loader2,
  Settings,
  LogOut,
  Mail,
  Phone,
  Building,
  Search,
  ChevronLeft,
  Minimize2,
} from "lucide-react";
import { GoogleContactsIcon } from "@/components/icons";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  getContactsIntegration,
  getContactsStatus,
  getContacts,
  syncContacts,
  setupContactsMirror,
  unlinkContactsMirror,
  type ContactsIntegration,
  type ContactsStatus,
  type Contact,
} from "@/lib/api/cloudflare";
import { API } from "@/config/env";
import type { DashboardItem } from "@/types/dashboard";

interface ContactsData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  dashboardId?: string;
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type ContactsNode = Node<ContactsData, "contacts">;

export function ContactsBlock({ id, data, selected }: NodeProps<ContactsNode>) {
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
  const [integration, setIntegration] = React.useState<ContactsIntegration | null>(null);
  const [status, setStatus] = React.useState<ContactsStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tokenRevoked, setTokenRevoked] = React.useState(false);
  const [enabling, setEnabling] = React.useState(false);

  // Contacts state
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [contactsTotal, setContactsTotal] = React.useState(0);
  const [contactsLoading, setContactsLoading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");

  // Selected contact state
  const [selectedContact, setSelectedContact] = React.useState<Contact | null>(null);

  // Debounce search
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

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
        getContactsIntegration(dashboardId),
        getContactsStatus(dashboardId).catch(() => null),
      ]);
      setIntegration(integrationData);
      setStatus(statusData);
      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Contacts");
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  // Load contacts
  const loadContacts = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      setContactsLoading(true);
      const response = await getContacts(dashboardId, {
        limit: 50,
        search: debouncedSearch || undefined,
      });
      setContacts(response.contacts);
      setContactsTotal(response.total);
    } catch (err) {
      console.error("Failed to load contacts:", err);
    } finally {
      setContactsLoading(false);
    }
  }, [dashboardId, debouncedSearch]);

  // Initial load - skip duplicate loads in Strict Mode/Fast Refresh
  React.useEffect(() => {
    if (!dashboardId) return;
    if (loadedDashboardRef.current === dashboardId) return;
    loadedDashboardRef.current = dashboardId;
    loadIntegration();
  }, [dashboardId, loadIntegration]);

  // Load contacts when integration is ready (use booleans to avoid flicker from object reference changes)
  const contactsReady = Boolean(integration?.connected && integration?.linked);
  React.useEffect(() => {
    if (contactsReady) {
      loadContacts();
    }
  }, [contactsReady, loadContacts]);

  // Sync handler
  const handleSync = async () => {
    if (!dashboardId) return;
    try {
      setSyncing(true);
      await syncContacts(dashboardId);
      await loadContacts();
      await loadIntegration();
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncing(false);
    }
  };

  // Connect Contacts
  const handleConnect = () => {
    if (!dashboardId) return;
    const connectUrl = `${API.cloudflare.base}/integrations/google/contacts/connect?dashboard_id=${dashboardId}&mode=popup`;
    const popup = window.open(connectUrl, "contacts-connect", "width=600,height=700");

    let completed = false;

    const completeSetup = async () => {
      if (completed) return;
      completed = true;
      window.removeEventListener("message", handleMessage);
      if (pollInterval) clearInterval(pollInterval);
      popup?.close();
      try {
        await setupContactsMirror(dashboardId);
        await loadIntegration();
        await loadContacts();
      } catch (err) {
        console.error("Failed to set up Contacts mirror:", err);
        await loadIntegration();
      }
    };

    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type === "contacts-auth-complete") {
        await completeSetup();
      }
    };
    window.addEventListener("message", handleMessage);

    const pollInterval = setInterval(async () => {
      if (popup?.closed) {
        clearInterval(pollInterval);
        setTimeout(async () => {
          if (!completed) {
            await completeSetup();
          }
        }, 500);
      }
    }, 500);
  };

  // Disconnect Contacts
  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await unlinkContactsMirror(dashboardId);
      setIntegration(null);
      setStatus(null);
      setContacts([]);
      setSelectedContact(null);
    } catch (err) {
      console.error("Failed to disconnect Contacts:", err);
    }
  };

  // Get initials for avatar
  const getInitials = (contact: Contact) => {
    if (contact.givenName && contact.familyName) {
      return `${contact.givenName[0]}${contact.familyName[0]}`.toUpperCase();
    }
    if (contact.displayName) {
      const parts = contact.displayName.split(" ");
      if (parts.length >= 2) {
        return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
      }
      return contact.displayName.substring(0, 2).toUpperCase();
    }
    return "??";
  };

  // Header
  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <GoogleContactsIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.emailAddress || status?.emailAddress || "Contacts"}
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
                Disconnect Contacts
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={handleConnect}>
                <Users className="w-3.5 h-3.5 mr-2" />
                Connect Contacts
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
            Disconnect Contacts
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={handleConnect}>
            <Users className="w-3.5 h-3.5 mr-2" />
            Connect Contacts
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
        icon={<GoogleContactsIcon className="w-14 h-14" />}
        label={integration?.emailAddress || "Contacts"}
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
            <Users className="w-8 h-8 text-[var(--text-muted)] mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect Google Contacts to view contacts
            </p>
            <Button size="sm" onClick={handleConnect} className="nodrag">
              Connect Contacts
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
            <Users className="w-8 h-8 text-[var(--text-muted)] mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Enable Contacts sync for this dashboard
            </p>
            <Button
              size="sm"
              disabled={enabling}
              onClick={async () => {
                if (!dashboardId || enabling) return;
                try {
                  setEnabling(true);
                  setTokenRevoked(false);
                  await setupContactsMirror(dashboardId);
                  await loadIntegration();
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (msg.includes("TOKEN_REVOKED") || msg.includes("revoked")) {
                    setTokenRevoked(true);
                  } else {
                    console.error("Failed to setup Contacts:", err);
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
                Access was revoked. Please disconnect and reconnect Contacts.
              </p>
            )}
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Main view with contacts
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
          {/* Contact list */}
          <div className={cn(
            "flex flex-col overflow-hidden border-r border-[var(--border)]",
            selectedContact ? "w-1/2" : "w-full"
          )}>
            {/* Search */}
            <div className="px-2 py-1.5 border-b border-[var(--border)]">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-muted)]" />
                <Input
                  placeholder="Search contacts..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="nodrag h-6 pl-7 text-[10px]"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {contactsLoading ? (
                <div className="flex items-center justify-center p-4">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
                </div>
              ) : contacts.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-4">
                  <p className="text-xs text-[var(--text-muted)]">
                    {debouncedSearch ? "No contacts found" : "No contacts"}
                  </p>
                </div>
              ) : (
                contacts.map(contact => (
                  <button
                    key={contact.resourceName}
                    onClick={() => setSelectedContact(contact)}
                    className={cn(
                      "nodrag w-full px-2 py-1.5 text-left border-b border-[var(--border)] hover:bg-[var(--background)] transition-colors flex items-center gap-2",
                      selectedContact?.resourceName === contact.resourceName && "bg-[var(--background)]"
                    )}
                  >
                    {contact.photoUrl ? (
                      <img
                        src={contact.photoUrl}
                        alt=""
                        className="w-6 h-6 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center text-[9px] font-medium shrink-0">
                        {getInitials(contact)}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-medium text-[var(--text-primary)] truncate">
                        {contact.displayName || "(No name)"}
                      </p>
                      {contact.emailAddresses[0]?.value && (
                        <p className="text-[9px] text-[var(--text-muted)] truncate">
                          {contact.emailAddresses[0].value}
                        </p>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* Status footer */}
            <div className="px-2 py-1 border-t border-[var(--border)] bg-[var(--background)]">
              <div className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
                <CheckCircle className="w-2.5 h-2.5 text-green-500" />
                <span>{contactsTotal} contacts</span>
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

          {/* Contact detail */}
          {selectedContact && (
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {/* Detail header */}
              <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelectedContact(null)}
                  className="nodrag"
                >
                  <ChevronLeft className="w-3 h-3" />
                </Button>
              </div>

              {/* Contact content */}
              <div className="flex-1 overflow-y-auto p-2">
                <div className="flex items-center gap-2 mb-3">
                  {selectedContact.photoUrl ? (
                    <img
                      src={selectedContact.photoUrl}
                      alt=""
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center text-sm font-medium">
                      {getInitials(selectedContact)}
                    </div>
                  )}
                  <div>
                    <h3 className="text-xs font-medium text-[var(--text-primary)]">
                      {selectedContact.displayName || "(No name)"}
                    </h3>
                    {selectedContact.organizations[0]?.name && (
                      <p className="text-[10px] text-[var(--text-secondary)]">
                        {selectedContact.organizations[0].title && `${selectedContact.organizations[0].title} at `}
                        {selectedContact.organizations[0].name}
                      </p>
                    )}
                  </div>
                </div>

                {selectedContact.emailAddresses.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[9px] font-medium text-[var(--text-muted)] mb-1 flex items-center gap-1">
                      <Mail className="w-2.5 h-2.5" /> Email
                    </p>
                    {selectedContact.emailAddresses.map((email, i) => (
                      <p key={i} className="text-[10px] text-[var(--text-secondary)]">
                        {email.value}
                        {email.type && <span className="text-[var(--text-muted)]"> ({email.type})</span>}
                      </p>
                    ))}
                  </div>
                )}

                {selectedContact.phoneNumbers.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[9px] font-medium text-[var(--text-muted)] mb-1 flex items-center gap-1">
                      <Phone className="w-2.5 h-2.5" /> Phone
                    </p>
                    {selectedContact.phoneNumbers.map((phone, i) => (
                      <p key={i} className="text-[10px] text-[var(--text-secondary)]">
                        {phone.value}
                        {phone.type && <span className="text-[var(--text-muted)]"> ({phone.type})</span>}
                      </p>
                    ))}
                  </div>
                )}

                {selectedContact.organizations.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[9px] font-medium text-[var(--text-muted)] mb-1 flex items-center gap-1">
                      <Building className="w-2.5 h-2.5" /> Organization
                    </p>
                    {selectedContact.organizations.map((org, i) => (
                      <p key={i} className="text-[10px] text-[var(--text-secondary)]">
                        {org.title && `${org.title} at `}{org.name}
                      </p>
                    ))}
                  </div>
                )}

                {selectedContact.notes && (
                  <div>
                    <p className="text-[9px] font-medium text-[var(--text-muted)] mb-1">Notes</p>
                    <p className="text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap">
                      {selectedContact.notes}
                    </p>
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

export default ContactsBlock;
