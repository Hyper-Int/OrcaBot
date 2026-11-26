// REVISION: analytics-v4-antigravity
import { describe, expect, it } from 'vitest';
import { detectAgentType } from './handler';

describe('detectAgentType', () => {
  it('knows Antigravity CLI (agy) alongside the other agents', () => {
    expect(detectAgentType('agy')).toBe('antigravity');
    expect(detectAgentType('cd "$HOME/x" && agy --dangerously-skip-permissions')).toBe('antigravity');
    expect(detectAgentType('gemini --yolo')).toBe('gemini');
    expect(detectAgentType('claude')).toBe('claude');
    expect(detectAgentType('npm run dev')).toBe('shell');
    expect(detectAgentType('')).toBeNull();
  });
});
