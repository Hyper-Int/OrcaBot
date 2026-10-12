// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect } from 'vitest';
import { validateGatewayArgs } from './arg-safety';
import { deriveEnforcementContext } from './gateway';

describe('validateGatewayArgs: IDs in URL paths', () => {
  it.each([
    ['github', { owner: 'myorg', repo: '../otherorg/secret' }],
    ['github', { owner: 'myorg/../evil', repo: 'x' }],
    ['github', { owner: 'myorg', repo: 'ok', path: '../../../otherorg/secret/contents/f' }],
    ['github', { owner: 'myorg', repo: 'ok', path: 'src/%2e%2e/x' }],
    ['discord', { channel: 'C1', message_id: '../../C2/messages/9' }],
    ['drive', { fileId: 'OTHER/permissions?x=' }],
    ['gmail', { messageId: 'abc/trash' }],
    ['teams', { team_id: 'T/channels/OTHER/messages#', channel_id: '19:ok@thread.tacv2' }],
    ['calendar', { calendarId: 'mine', eventId: '../../other@group.calendar.google.com/events/1' }],
    ['twitter', { tweet_id: '1?x=y' }],
    ['google_chat', { space: 'spaces/A', message_id: 'spaces/B/messages/1' }],
    ['google_chat', { space: 'spaces/../B' }],
  ])('%s rejects %j', (provider, args) => {
    expect(validateGatewayArgs(provider, args)).toMatch(/^E796/);
  });

  it.each([
    ['github', { owner: 'my-org', repo: 'repo.js', path: 'src/index.ts' }],
    ['github', { owner: 'o', repo: 'r', path: '' }],
    ['discord', { channel: '123456789', message_id: '987654321' }],
    ['teams', { team_id: '8c1e-guid', channel_id: '19:abc@thread.tacv2', message_id: '1700000000000' }],
    ['drive', { fileId: '1AbC_d-EfG' }],
    ['google_chat', { space: 'spaces/AAAA', message_id: 'spaces/AAAA/messages/BBB.CCC' }],
    ['google_chat', { space: 'AAAA', message_id: 'BBB' }],
    ['calendar', { calendarId: 'en.usa#holiday@group.v.calendar.google.com', eventId: 'abc123' }],
  ])('%s accepts %j', (provider, args) => {
    expect(validateGatewayArgs(provider, args)).toBeNull();
  });
});

describe('validateGatewayArgs: email headers and recipients', () => {
  it('rejects header injection through the subject or a recipient', () => {
    expect(validateGatewayArgs('gmail', { to: ['a@ok.com'], subject: 'hi\r\nBcc: evil@x.com' })).toMatch(/^E79613/);
    expect(validateGatewayArgs('gmail', { to: ['a@ok.com\r\nBcc: evil@x.com'] })).toMatch(/^E79613/);
    expect(validateGatewayArgs('outlook', { to: ['a@ok.com\nCc: evil@x.com'] })).toMatch(/^E79613/);
  });

  it.each([
    ['a@ok.com, evil@x.com'],
    ['x <a@ok.com>, evil@x.com'],
    ['a@ok.com ,evil@x.com'],
    ['a@ok.com;evil@x.com'],
    ['"Doe, John" <a@ok.com>'],
  ])('rejects a recipient entry hiding several addresses: %s', (entry) => {
    expect(validateGatewayArgs('gmail', { to: [entry] })).toMatch(/^E79614/);
  });

  it('accepts one address per entry, with or without a display name', () => {
    expect(validateGatewayArgs('gmail', { to: ['a@ok.com', 'Jane Doe <j@ok.com>'], cc: 'b@ok.com', subject: 'Hello' })).toBeNull();
  });

  it('rejects non-string recipients', () => {
    expect(validateGatewayArgs('gmail', { to: ['a@ok.com', 42] })).toMatch(/^E79614/);
  });
});

describe('deriveEnforcementContext: checks what the client sends', () => {
  it.each([
    ['telegram.send_message', { channel: 'ALLOWED', chat_id: 'TARGET' }],
    ['whatsapp.send_message', { channel: 'ALLOWED', to: 'TARGET' }],
    ['teams.send_message', { channel: 'ALLOWED', channel_id: 'TARGET' }],
    ['matrix.send_message', { channel: 'ALLOWED', room_id: 'TARGET' }],
    ['google_chat.send_message', { channel: 'ALLOWED', space: 'TARGET' }],
    ['slack.send_message', { chat_id: 'ALLOWED', channel: 'TARGET' }],
    ['discord.send_message', { chat_id: 'ALLOWED', channel: 'TARGET' }],
  ])('%s checks the field the client sends to', (action, args) => {
    expect(deriveEnforcementContext(action, args).channelId).toBe('TARGET');
  });

  it('ignores an LLM-supplied channel_name', () => {
    expect(deriveEnforcementContext('slack.send_message', { channel: 'C_SECRET', channel_name: 'general' }).channelName).toBeUndefined();
  });

  it('counts Discord content and Slack blocks toward the message length', () => {
    expect(deriveEnforcementContext('discord.send_message', { channel: 'C', content: 'x'.repeat(500) }).messageText).toHaveLength(500);
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'y'.repeat(800) } }];
    expect(deriveEnforcementContext('slack.send_message', { channel: 'C', text: 'hi', blocks }).messageText!.length).toBeGreaterThan(800);
  });
});
