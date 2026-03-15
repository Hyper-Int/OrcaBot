// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: outlook-calendar-v2-scope-by-calendar-id
console.log(`[outlook-calendar-client] REVISION: outlook-calendar-v2-scope-by-calendar-id loaded at ${new Date().toISOString()}`);

/**
 * Outlook Calendar API Client (Microsoft Graph)
 *
 * Executes Microsoft Graph Calendar API calls with OAuth access token.
 * Token never leaves the control plane.
 */

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

interface OutlookCalendarEvent {
  id: string;
  subject: string;
  bodyPreview?: string;
  body?: {
    contentType: string;
    content: string;
  };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay?: boolean;
  location?: {
    displayName?: string;
  };
  organizer?: {
    emailAddress: {
      name?: string;
      address: string;
    };
  };
  attendees?: Array<{
    emailAddress: {
      name?: string;
      address: string;
    };
    type: 'required' | 'optional' | 'resource';
    status?: {
      response?: string;
      time?: string;
    };
  }>;
  webLink?: string;
  recurrence?: unknown;
  isCancelled?: boolean;
}

interface OutlookCalendarEventList {
  value: OutlookCalendarEvent[];
  '@odata.nextLink'?: string;
}

interface OutlookCalendar {
  id: string;
  name: string;
  color?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
  owner?: {
    name?: string;
    address?: string;
  };
}

interface OutlookCalendarList {
  value: OutlookCalendar[];
}

/**
 * Execute an Outlook Calendar action
 */
export async function executeOutlookCalendarAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'outlook_calendar.list_calendars':
      return listCalendars(args, accessToken);
    case 'outlook_calendar.list_events':
      return listEvents(args, accessToken);
    case 'outlook_calendar.get_event':
      return getEvent(args, accessToken);
    case 'outlook_calendar.create_event':
      return createEvent(args, accessToken);
    case 'outlook_calendar.update_event':
      return updateEvent(args, accessToken);
    case 'outlook_calendar.delete_event':
      return deleteEvent(args, accessToken);
    case 'outlook_calendar.search_events':
      return searchEvents(args, accessToken);
    default:
      throw new Error(`Unknown Outlook Calendar action: ${action}`);
  }
}

async function listCalendars(
  _args: Record<string, unknown>,
  accessToken: string
): Promise<{ calendars: OutlookCalendar[] }> {
  const response = await fetch(`${GRAPH_API_BASE}/me/calendars`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Prefer': 'outlook.timezone="UTC"',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook Calendar API error: ${response.status} - ${error}`);
  }

  const result = await response.json() as OutlookCalendarList;
  return { calendars: result.value || [] };
}

async function listEvents(
  args: Record<string, unknown>,
  accessToken: string
): Promise<OutlookCalendarEventList> {
  // calendarView requires startDateTime and endDateTime; default to current week
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); // Sunday
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const startDateTime = args.startDateTime as string || args.start_date as string || args.timeMin as string || weekStart.toISOString();
  const endDateTime = args.endDateTime as string || args.end_date as string || args.timeMax as string || weekEnd.toISOString();
  const maxResults = Math.min((args.limit ?? args.maxResults ?? args.max_results ?? 100) as number, 500);
  const calendarId = (args.calendarId ?? args.calendar_id) as string | undefined;

  const params = new URLSearchParams({
    startDateTime,
    endDateTime,
    '$top': maxResults.toString(),
    '$orderby': 'start/dateTime',
  });

  // Scope to specific calendar if provided; otherwise default calendar
  const basePath = calendarId
    ? `/me/calendars/${encodeURIComponent(calendarId)}/calendarView`
    : '/me/calendarView';

  const response = await fetch(`${GRAPH_API_BASE}${basePath}?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Prefer': 'outlook.timezone="UTC"',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook Calendar API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<OutlookCalendarEventList>;
}

async function getEvent(
  args: Record<string, unknown>,
  accessToken: string
): Promise<OutlookCalendarEvent> {
  const eventId = (args.event_id ?? args.eventId ?? args.id) as string;
  if (!eventId) {
    throw new Error('event_id is required');
  }
  const calendarId = (args.calendarId ?? args.calendar_id) as string | undefined;

  const basePath = calendarId
    ? `/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    : `/me/events/${encodeURIComponent(eventId)}`;

  const response = await fetch(`${GRAPH_API_BASE}${basePath}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Prefer': 'outlook.timezone="UTC"',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook Calendar API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<OutlookCalendarEvent>;
}

/**
 * Normalize a start/end arg that may be:
 * - a plain ISO 8601 string (from MCP tool schemas)
 * - an object { dateTime, timeZone } (from direct API callers)
 */
function normalizeDateTimeArg(val: unknown): { dateTime: string; timeZone: string } | null {
  if (!val) return null;
  if (typeof val === 'string') {
    return { dateTime: val, timeZone: 'UTC' };
  }
  if (typeof val === 'object') {
    const obj = val as { dateTime?: string; timeZone?: string };
    if (obj.dateTime) {
      return { dateTime: obj.dateTime, timeZone: obj.timeZone || 'UTC' };
    }
  }
  return null;
}

/**
 * Normalize attendees that may be:
 * - a comma-separated string (from MCP tool schemas)
 * - an array of strings or objects
 */
function normalizeAttendees(val: unknown): Array<{ emailAddress: { address: string; name?: string }; type: string }> {
  let list: unknown[];
  if (typeof val === 'string') {
    // Comma-separated email string from MCP tools
    list = val.split(',').map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(val)) {
    list = val;
  } else {
    return [];
  }

  return list.map((a) => {
    if (typeof a === 'string') {
      return { emailAddress: { address: a }, type: 'required' };
    }
    const obj = a as { email?: string; address?: string; name?: string; type?: string; emailAddress?: { address: string; name?: string } };
    if (obj.emailAddress) {
      return { emailAddress: obj.emailAddress, type: obj.type || 'required' };
    }
    return {
      emailAddress: {
        address: (obj.email || obj.address) as string,
        ...(obj.name ? { name: obj.name } : {}),
      },
      type: obj.type || 'required',
    };
  });
}

async function createEvent(
  args: Record<string, unknown>,
  accessToken: string
): Promise<OutlookCalendarEvent> {
  const subject = args.subject as string;
  if (!subject) {
    throw new Error('subject is required');
  }

  const start = normalizeDateTimeArg(args.start);
  const end = normalizeDateTimeArg(args.end);
  if (!start || !end) {
    throw new Error('start and end are required');
  }

  const event: Record<string, unknown> = {
    subject,
    start,
    end,
  };

  const isAllDay = args.isAllDay ?? args.is_all_day;
  if (isAllDay !== undefined) {
    event.isAllDay = isAllDay as boolean;
  }

  if (args.location) {
    const loc = args.location;
    event.location = typeof loc === 'string'
      ? { displayName: loc }
      : loc;
  }

  if (args.body) {
    const body = args.body;
    event.body = typeof body === 'string'
      ? { contentType: 'text', content: body }
      : body;
  }

  if (args.attendees) {
    event.attendees = normalizeAttendees(args.attendees);
  }

  // If calendarId is specified, create in that calendar; otherwise default
  const calendarId = (args.calendarId ?? args.calendar_id) as string | undefined;
  const url = calendarId
    ? `${GRAPH_API_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`
    : `${GRAPH_API_BASE}/me/events`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'outlook.timezone="UTC"',
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook Calendar API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<OutlookCalendarEvent>;
}

async function updateEvent(
  args: Record<string, unknown>,
  accessToken: string
): Promise<OutlookCalendarEvent> {
  const eventId = (args.event_id ?? args.eventId ?? args.id) as string;
  if (!eventId) {
    throw new Error('event_id is required');
  }

  const patch: Record<string, unknown> = {};

  if (args.subject !== undefined) {
    patch.subject = args.subject as string;
  }

  if (args.start !== undefined) {
    const start = normalizeDateTimeArg(args.start);
    if (start) patch.start = start;
  }

  if (args.end !== undefined) {
    const end = normalizeDateTimeArg(args.end);
    if (end) patch.end = end;
  }

  const isAllDay = args.isAllDay ?? args.is_all_day;
  if (isAllDay !== undefined) {
    patch.isAllDay = isAllDay as boolean;
  }

  if (args.location !== undefined) {
    const loc = args.location;
    patch.location = typeof loc === 'string'
      ? { displayName: loc }
      : loc;
  }

  if (args.body !== undefined) {
    const body = args.body;
    patch.body = typeof body === 'string'
      ? { contentType: 'text', content: body }
      : body;
  }

  if (args.attendees !== undefined) {
    patch.attendees = normalizeAttendees(args.attendees);
  }

  const calendarId = (args.calendarId ?? args.calendar_id) as string | undefined;
  const basePath = calendarId
    ? `/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    : `/me/events/${encodeURIComponent(eventId)}`;

  const response = await fetch(`${GRAPH_API_BASE}${basePath}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'outlook.timezone="UTC"',
    },
    body: JSON.stringify(patch),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook Calendar API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<OutlookCalendarEvent>;
}

async function deleteEvent(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ success: boolean; status: string }> {
  const eventId = (args.event_id ?? args.eventId ?? args.id) as string;
  if (!eventId) {
    throw new Error('event_id is required');
  }
  const calendarId = (args.calendarId ?? args.calendar_id) as string | undefined;

  const basePath = calendarId
    ? `/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    : `/me/events/${encodeURIComponent(eventId)}`;

  const response = await fetch(`${GRAPH_API_BASE}${basePath}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook Calendar API error: ${response.status} - ${error}`);
  }

  // DELETE returns 204 with no body on success
  return { success: true, status: 'deleted' };
}

async function searchEvents(
  args: Record<string, unknown>,
  accessToken: string
): Promise<OutlookCalendarEventList> {
  const query = args.query as string || '';
  const maxResults = Math.min((args.limit ?? args.maxResults ?? args.max_results ?? 50) as number, 500);
  const calendarId = (args.calendarId ?? args.calendar_id) as string | undefined;
  const startDate = (args.start_date ?? args.startDate ?? args.timeMin) as string | undefined;
  const endDate = (args.end_date ?? args.endDate ?? args.timeMax) as string | undefined;

  // When date bounds are provided, use calendarView (inherently scopes by date range)
  // and filter by subject client-side. Without date bounds, use /events with $filter.
  if (startDate || endDate) {
    const now = new Date();
    const effectiveStart = startDate || now.toISOString();
    const effectiveEnd = endDate || new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const params = new URLSearchParams({
      startDateTime: effectiveStart,
      endDateTime: effectiveEnd,
      '$top': maxResults.toString(),
      '$orderby': 'start/dateTime',
    });

    // calendarView supports $filter on subject
    if (query) {
      params.set('$filter', `contains(subject,'${query.replace(/'/g, "''")}')`);
    }

    const basePath = calendarId
      ? `/me/calendars/${encodeURIComponent(calendarId)}/calendarView`
      : '/me/calendarView';

    const response = await fetch(`${GRAPH_API_BASE}${basePath}?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Prefer': 'outlook.timezone="UTC"',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Outlook Calendar API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<OutlookCalendarEventList>;
  }

  // No date bounds — search across all events with subject filter
  const params = new URLSearchParams({
    '$top': maxResults.toString(),
    '$orderby': 'start/dateTime',
  });

  if (query) {
    params.set('$filter', `contains(subject,'${query.replace(/'/g, "''")}')`);
  }

  const basePath = calendarId
    ? `/me/calendars/${encodeURIComponent(calendarId)}/events`
    : '/me/events';

  const response = await fetch(`${GRAPH_API_BASE}${basePath}?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Prefer': 'outlook.timezone="UTC"',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook Calendar API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<OutlookCalendarEventList>;
}
