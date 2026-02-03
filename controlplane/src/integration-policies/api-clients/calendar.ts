// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: calendar-client-v1
console.log(`[calendar-client] REVISION: calendar-client-v1 loaded at ${new Date().toISOString()}`);

/**
 * Google Calendar API Client
 *
 * Executes Google Calendar API calls with OAuth access token.
 * Token never leaves the control plane.
 */

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  status?: string;
  htmlLink?: string;
  creator?: { email: string; displayName?: string };
  organizer?: { email: string; displayName?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
  }>;
  recurrence?: string[];
}

interface CalendarEventList {
  items: CalendarEvent[];
  nextPageToken?: string;
}

interface Calendar {
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  primary?: boolean;
}

/**
 * Execute a Google Calendar action
 */
export async function executeCalendarAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'calendar.list_calendars':
      return listCalendars(args, accessToken);
    case 'calendar.list_events':
      return listEvents(args, accessToken);
    case 'calendar.get_event':
      return getEvent(args, accessToken);
    case 'calendar.create_event':
      return createEvent(args, accessToken);
    case 'calendar.update_event':
      return updateEvent(args, accessToken);
    case 'calendar.delete_event':
      return deleteEvent(args, accessToken);
    case 'calendar.search_events':
      return searchEvents(args, accessToken);
    default:
      throw new Error(`Unknown Calendar action: ${action}`);
  }
}

async function calendarFetch(
  path: string,
  accessToken: string,
  options?: RequestInit
): Promise<Response> {
  const response = await fetch(`${CALENDAR_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Calendar API error: ${response.status} - ${error}`);
  }

  return response;
}

async function listCalendars(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ calendars: Calendar[] }> {
  const response = await calendarFetch('/users/me/calendarList', accessToken);
  const result = await response.json() as { items: Calendar[] };
  return { calendars: result.items || [] };
}

async function listEvents(
  args: Record<string, unknown>,
  accessToken: string
): Promise<CalendarEventList> {
  const calendarId = args.calendarId as string || 'primary';
  const timeMin = args.timeMin as string || new Date().toISOString();
  const timeMax = args.timeMax as string || undefined;
  const maxResults = Math.min(args.maxResults as number || 100, 2500);
  const pageToken = args.pageToken as string || undefined;

  const params = new URLSearchParams({
    maxResults: maxResults.toString(),
    timeMin,
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  if (timeMax) {
    params.set('timeMax', timeMax);
  }
  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    accessToken
  );

  return response.json() as Promise<CalendarEventList>;
}

async function getEvent(
  args: Record<string, unknown>,
  accessToken: string
): Promise<CalendarEvent> {
  const calendarId = args.calendarId as string || 'primary';
  const eventId = args.eventId as string;
  if (!eventId) {
    throw new Error('eventId is required');
  }

  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    accessToken
  );

  return response.json() as Promise<CalendarEvent>;
}

async function createEvent(
  args: Record<string, unknown>,
  accessToken: string
): Promise<CalendarEvent> {
  const calendarId = args.calendarId as string || 'primary';
  const summary = args.summary as string;
  if (!summary) {
    throw new Error('summary is required');
  }

  const start = args.start as { dateTime?: string; date?: string; timeZone?: string };
  const end = args.end as { dateTime?: string; date?: string; timeZone?: string };
  if (!start || !end) {
    throw new Error('start and end are required');
  }

  const event: Partial<CalendarEvent> = {
    summary,
    start,
    end,
    description: args.description as string || undefined,
    location: args.location as string || undefined,
    attendees: args.attendees as CalendarEvent['attendees'] || undefined,
  };

  const sendUpdates = args.sendUpdates as string || 'none';

  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${sendUpdates}`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(event),
    }
  );

  return response.json() as Promise<CalendarEvent>;
}

async function updateEvent(
  args: Record<string, unknown>,
  accessToken: string
): Promise<CalendarEvent> {
  const calendarId = args.calendarId as string || 'primary';
  const eventId = args.eventId as string;
  if (!eventId) {
    throw new Error('eventId is required');
  }

  // First get existing event
  const existing = await getEvent({ calendarId, eventId }, accessToken);

  // Merge updates
  const event: Partial<CalendarEvent> = {
    ...existing,
    summary: args.summary as string || existing.summary,
    description: args.description !== undefined ? args.description as string : existing.description,
    location: args.location !== undefined ? args.location as string : existing.location,
    start: args.start as CalendarEvent['start'] || existing.start,
    end: args.end as CalendarEvent['end'] || existing.end,
    attendees: args.attendees as CalendarEvent['attendees'] || existing.attendees,
  };

  const sendUpdates = args.sendUpdates as string || 'none';

  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=${sendUpdates}`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify(event),
    }
  );

  return response.json() as Promise<CalendarEvent>;
}

async function deleteEvent(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ success: boolean }> {
  const calendarId = args.calendarId as string || 'primary';
  const eventId = args.eventId as string;
  if (!eventId) {
    throw new Error('eventId is required');
  }

  const sendUpdates = args.sendUpdates as string || 'none';

  await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=${sendUpdates}`,
    accessToken,
    {
      method: 'DELETE',
    }
  );

  return { success: true };
}

async function searchEvents(
  args: Record<string, unknown>,
  accessToken: string
): Promise<CalendarEventList> {
  const calendarId = args.calendarId as string || 'primary';
  const query = args.query as string;
  const timeMin = args.timeMin as string || new Date().toISOString();
  const timeMax = args.timeMax as string || undefined;
  const maxResults = Math.min(args.maxResults as number || 100, 2500);

  const params = new URLSearchParams({
    maxResults: maxResults.toString(),
    timeMin,
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  if (query) {
    params.set('q', query);
  }
  if (timeMax) {
    params.set('timeMax', timeMax);
  }

  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    accessToken
  );

  return response.json() as Promise<CalendarEventList>;
}
