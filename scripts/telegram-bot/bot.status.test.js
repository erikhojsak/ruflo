import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Module mocks (hoisted before imports) ---

vi.mock('dotenv/config', () => ({}));

const mockSendMessage = vi.fn().mockResolvedValue({});
const mockOnText = vi.fn();
const mockOn = vi.fn();

vi.mock('node-telegram-bot-api', () => ({
  default: vi.fn().mockImplementation(() => ({
    sendMessage: mockSendMessage,
    onText: mockOnText,
    on: mockOn,
  })),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn().mockReturnValue(''),
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn().mockImplementation((filePath) => {
      if (String(filePath).endsWith('sessions.json')) return '{}';
      if (String(filePath).endsWith('tasks.json')) return '{}';
      return '{}';
    }),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  },
}));

// --- Helpers to extract registered handlers ---

/**
 * Returns the callback registered for a given regex pattern via bot.onText().
 * bot.onText is mocked, so each call is captured in mockOnText.mock.calls as [regex, callback].
 */
function getHandler(pattern) {
  const match = mockOnText.mock.calls.find(([regex]) => regex.toString() === pattern.toString());
  if (!match) throw new Error(`No handler registered for ${pattern}`);
  return match[1];
}

function makeMockMsg(userId, chatId = userId) {
  return { from: { id: userId }, chat: { id: chatId } };
}

// --- Test setup ---

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  // Reset mocks to defaults for each test
  mockSendMessage.mockResolvedValue({});
  mockOnText.mockImplementation(() => {});
  mockOn.mockImplementation(() => {});

  const { execSync } = await import('child_process');
  execSync.mockReturnValue('');

  const fs = await import('fs');
  fs.default.readFileSync.mockImplementation((filePath) => {
    if (String(filePath).endsWith('sessions.json')) return '{}';
    if (String(filePath).endsWith('tasks.json')) return '{}';
    return '{}';
  });
  fs.default.writeFileSync.mockImplementation(() => {});
  fs.default.existsSync.mockReturnValue(false);

  process.env.TELEGRAM_BOT_TOKEN = 'test-token-123';
  process.env.TELEGRAM_ALLOWED_USERS = '';
  process.env.CLAUDE_WORKING_DIR = '/tmp/test-working-dir';

  // Import bot.js — triggers all top-level side effects and registers handlers
  await import('./bot.js');
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_USERS;
  delete process.env.CLAUDE_WORKING_DIR;
});

// --- Tests ---

describe('/status command', () => {
  describe('happy path — no user restrictions', () => {
    it('calls sendMessage with status report', async () => {
      const handler = getHandler(/\/status/);
      const msg = makeMockMsg(42);

      await handler(msg);

      expect(mockSendMessage).toHaveBeenCalledOnce();
      const [chatId, text] = mockSendMessage.mock.calls[0];
      expect(chatId).toBe(42);
      expect(text).toContain('Ruflo Bot Status');
    });

    it('includes uptime in seconds when bot just started', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(45);

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('45s');
    });

    it('includes uptime in minutes and seconds', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(125); // 2m 5s

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('2m 5s');
    });

    it('includes uptime in hours, minutes, and seconds', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(3661); // 1h 1m 1s

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('1h 1m 1s');
    });

    it('reports "No uncommitted changes" when git is clean', async () => {
      const { execSync } = await import('child_process');
      execSync.mockReturnValue('');

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('No uncommitted changes');
    });

    it('shows git status output in a code block when there are changes', async () => {
      const { execSync } = await import('child_process');
      execSync.mockReturnValue(' M src/index.ts\n?? newfile.ts\n');

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('```');
      expect(text).toContain('M src/index.ts');
      expect(text).toContain('newfile.ts');
    });

    it('shows user restriction as "None (all allowed)" when ALLOWED_USERS is empty', async () => {
      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('None (all allowed)');
    });

    it('includes working directory in output', async () => {
      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('/tmp/test-working-dir');
    });

    it('includes active sessions count', async () => {
      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toMatch(/Active sessions:\*\s*0/);
    });

    it('includes claude sessions count', async () => {
      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toMatch(/Claude sessions:\*\s*0/);
    });
  });

  describe('user restriction', () => {
    it('blocks unauthorized users and sends no message', async () => {
      process.env.TELEGRAM_ALLOWED_USERS = '100,200';
      vi.resetModules();
      await import('./bot.js');

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(999)); // not in allowed list

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('allows authorized users when ALLOWED_USERS is set', async () => {
      process.env.TELEGRAM_ALLOWED_USERS = '100,200';
      vi.resetModules();
      await import('./bot.js');

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(100)); // in allowed list

      expect(mockSendMessage).toHaveBeenCalledOnce();
      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('2 user(s)');
    });
  });

  describe('edge cases', () => {
    it('handles git not available (execSync throws)', async () => {
      const { execSync } = await import('child_process');
      execSync.mockImplementation(() => { throw new Error('git not found'); });

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      // Should not throw; getGitStatus catches errors and returns ''
      expect(mockSendMessage).toHaveBeenCalledOnce();
      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('No uncommitted changes');
    });

    it('handles git status with only whitespace as clean', async () => {
      const { execSync } = await import('child_process');
      execSync.mockReturnValue('   \n  \n');

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('No uncommitted changes');
    });

    it('uses parse_mode Markdown in the message options', async () => {
      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const [, , opts] = mockSendMessage.mock.calls[0];
      expect(opts?.parse_mode).toBe('Markdown');
    });

    it('sends to the correct chat ID', async () => {
      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(5, 99)); // userId=5, chatId=99

      const [chatId] = mockSendMessage.mock.calls[0];
      expect(chatId).toBe(99);
    });

    it('handles exactly 0 seconds uptime', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(0);

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('0s');
    });

    it('handles exactly 3600 seconds (1h 0m 0s)', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(3600);

      const handler = getHandler(/\/status/);
      await handler(makeMockMsg(1));

      const text = mockSendMessage.mock.calls[0][1];
      expect(text).toContain('1h 0m 0s');
    });
  });
});
