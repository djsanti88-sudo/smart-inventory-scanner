import { describe, it, expect } from 'vitest';
import { validateAgentFile } from '../validate-agents.mjs';

const good = `---\nname: x\ndescription: d\ntools: Read\nmodel: sonnet\n---\nbody\n\`\`\`json\n[]\n\`\`\`\nscore_key: <0-100>\nNo em dashes.`;

describe('validateAgentFile', () => {
  it('passes a well-formed agent', () => {
    expect(validateAgentFile(good).ok).toBe(true);
  });
  it('fails on an em dash', () => {
    expect(validateAgentFile(good + '\nbad — dash').ok).toBe(false);
  });
  it('fails when the json block is missing', () => {
    expect(validateAgentFile(good.replace('```json\n[]\n```', '')).ok).toBe(false);
  });
});
