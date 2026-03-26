// Ruflo Telegram Bot v1.0
// abcd
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// --- Configuration ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USERS
  ? process.env.TELEGRAM_ALLOWED_USERS.split(',').map(Number)
  : []; // empty = allow all
const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../..'
);
const MAX_MSG_LENGTH = 4096;
const TASKS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'tasks.json');
const SESSIONS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sessions.json');
const DAILY_REMINDER_HOUR = parseInt(process.env.REMINDER_HOUR || '9', 10);

// --- Task persistence ---
function loadTasks() {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function getUserTasks(chatId) {
  const tasks = loadTasks();
  return tasks[chatId] || [];
}

function setUserTasks(chatId, list) {
  const tasks = loadTasks();
  tasks[chatId] = list;
  saveTasks(tasks);
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function isOverdue(deadline) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return new Date(deadline) < now;
}

if (!TOKEN) {
  console.error('Error: Set TELEGRAM_BOT_TOKEN environment variable');
  console.error('  Get one from @BotFather on Telegram');
  process.exit(1);
}

// --- Bot setup ---
const bot = new TelegramBot(TOKEN, { polling: true });
const activeSessions = new Map(); // chatId -> abort controller
const claudeSessions = new Map(); // chatId -> claude session ID
const pendingChanges = new Map(); // chatId -> { claudeChangedFiles, newFiles, beforeSnapshot }

console.log(`Ruflo Telegram Bot started`);
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`User restriction: ${ALLOWED_USERS.length ? ALLOWED_USERS.join(', ') : 'none (all allowed)'}`);

// --- Session persistence ---
function loadSessionsFromFile() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessionsToFile() {
  const obj = {};
  for (const [k, v] of claudeSessions.entries()) obj[k] = v;
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2)); } catch {}
}

// Load persisted sessions on startup
for (const [k, v] of Object.entries(loadSessionsFromFile())) {
  claudeSessions.set(k, v);
}
console.log(`Loaded ${claudeSessions.size} persisted session(s)`);

// --- Auth check ---
function isAllowed(userId) {
  return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(userId);
}

// --- Split long messages ---
function splitMessage(text) {
  if (text.length <= MAX_MSG_LENGTH) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) { chunks.push(remaining); break; }
    let splitIdx = remaining.lastIndexOf('\n', MAX_MSG_LENGTH);
    if (splitIdx < MAX_MSG_LENGTH / 2) splitIdx = MAX_MSG_LENGTH;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

// --- Send response with optional threading and markdown fallback ---
async function sendResponse(chatId, text, replyToMsgId = null) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const opts = replyToMsgId ? { parse_mode: 'Markdown', reply_to_message_id: replyToMsgId } : { parse_mode: 'Markdown' };
    try {
      await bot.sendMessage(chatId, chunk, opts);
    } catch {
      const plainOpts = replyToMsgId ? { reply_to_message_id: replyToMsgId } : {};
      await bot.sendMessage(chatId, chunk, plainOpts);
    }
  }
}

// --- Git utilities ---
function getGitStatus() {
  try {
    return execSync('git status --porcelain', { cwd: WORKING_DIR, encoding: 'utf8', timeout: 5000 });
  } catch {
    return '';
  }
}

// Snapshot files that are already in git status (modified/untracked)
// so we can restore them if the user rejects Claude's changes.
function captureWorkingTreeState() {
  const statusOutput = getGitStatus();
  const files = {};
  for (const line of statusOutput.split('\n').filter(Boolean)) {
    const file = line.slice(3).trim();
    const fullPath = path.join(WORKING_DIR, file);
    try {
      files[file] = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
    } catch {
      files[file] = null;
    }
  }
  return { statusOutput, files };
}

function detectClaudeChanges(before) {
  const afterStatus = getGitStatus();
  const beforeFileSet = new Set(
    before.statusOutput.split('\n').filter(Boolean).map(l => l.slice(3).trim())
  );

  const claudeChangedFiles = []; // tracked files Claude modified
  const newFiles = [];           // untracked files Claude created

  for (const line of afterStatus.split('\n').filter(Boolean)) {
    const status = line.slice(0, 2).trim();
    const file = line.slice(3).trim();

    if (!beforeFileSet.has(file)) {
      // File wasn't in before-status at all
      if (status === '??') {
        newFiles.push(file);
      } else {
        claudeChangedFiles.push(file);
      }
    } else {
      // File was already in before-status — check if content changed
      const fullPath = path.join(WORKING_DIR, file);
      try {
        const afterContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
        const beforeContent = before.files[file];
        if (afterContent !== beforeContent) {
          if (status === '??') {
            newFiles.push(file); // was untracked before, still untracked, content changed
          } else {
            claudeChangedFiles.push(file);
          }
        }
      } catch {}
    }
  }

  // Build diff text
  const diffParts = [];
  for (const file of claudeChangedFiles) {
    try {
      const diff = execSync(`git diff HEAD -- "${file}"`, { cwd: WORKING_DIR, encoding: 'utf8', timeout: 5000 });
      if (diff.trim()) diffParts.push(diff.trim());
      else {
        // Maybe staged
        const staged = execSync(`git diff --cached -- "${file}"`, { cwd: WORKING_DIR, encoding: 'utf8', timeout: 5000 });
        if (staged.trim()) diffParts.push(staged.trim());
      }
    } catch {}
  }
  for (const file of newFiles) {
    try {
      const content = fs.readFileSync(path.join(WORKING_DIR, file), 'utf8');
      const lines = content.split('\n').map(l => `+${l}`).join('\n');
      diffParts.push(`--- /dev/null\n+++ b/${file}\n${lines}`);
    } catch {}
  }

  const diffText = diffParts.join('\n\n---\n');
  const hasChanges = claudeChangedFiles.length > 0 || newFiles.length > 0;

  return { hasChanges, claudeChangedFiles, newFiles, diffText, beforeSnapshot: before.files };
}

function revertClaudeChanges(changes) {
  for (const file of changes.claudeChangedFiles) {
    const fullPath = path.join(WORKING_DIR, file);
    const original = changes.beforeSnapshot[file];
    if (original !== undefined && original !== null) {
      // Was already modified before Claude — restore to that state
      try { fs.writeFileSync(fullPath, original, 'utf8'); } catch {}
    } else {
      // Was clean before Claude — restore to HEAD
      try {
        execSync(`git checkout HEAD -- "${file}"`, { cwd: WORKING_DIR, timeout: 5000 });
      } catch {}
    }
  }
  for (const file of changes.newFiles) {
    try { fs.unlinkSync(path.join(WORKING_DIR, file)); } catch {}
  }
}

// --- Run claude -p with persistent session ---
function spawnClaude(prompt, chatId) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    activeSessions.set(chatId, controller);

    const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions',
      '--model', 'sonnet',
      '--max-turns', '15',
      '--setting-sources', 'user',
      '--append-system-prompt', `You are a helpful coding assistant with full access to the Ruflo project at ${WORKING_DIR}. You can read, edit, and create files there. You can run bash commands. Always respond to the user, even to brief messages. Be concise.`,
    ];

    const sessionId = claudeSessions.get(String(chatId));
    if (sessionId) args.push('--resume', sessionId);

    args.push(prompt);

    const proc = spawn('claude', args, {
      cwd: WORKING_DIR,
      signal: controller.signal,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      controller.abort();
      activeSessions.delete(chatId);
    }, 300_000);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      activeSessions.delete(chatId);
      let result = '';
      let newSessionId = null;
      try {
        const json = JSON.parse(stdout);
        result = json.result || '';
        newSessionId = json.session_id || null;
      } catch {
        result = stdout.trim();
      }
      if (newSessionId) {
        claudeSessions.set(String(chatId), newSessionId);
        saveSessionsToFile(); // persist across restarts
      }
      resolve({ result, code, stderr: stderr.trim() });
    });

    proc.on('error', (err) => {
      activeSessions.delete(chatId);
      reject(err);
    });
  });
}

async function runClaude(prompt, chatId) {
  const res = await spawnClaude(prompt, chatId);
  if (res.result) return res.result;

  if (claudeSessions.has(String(chatId))) {
    claudeSessions.delete(String(chatId));
    saveSessionsToFile();
    const retry = await spawnClaude(prompt, chatId);
    if (retry.result) return retry.result;
  }

  throw new Error(res.stderr || 'No response — try rephrasing your message');
}

// --- /start command ---
bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    `*Ruflo Terminal Bot*\n\n` +
    `Send me any message and I'll process it with Claude Code in:\n` +
    `\`${WORKING_DIR}\`\n\n` +
    `Commands:\n` +
    `/addtask <text> [YYYY-MM-DD] — add a task\n` +
    `/tasks — list all tasks\n` +
    `/done <id> — mark task as completed\n` +
    `/deltask <id> — delete a task\n` +
    `/overdue — show overdue tasks\n` +
    `/clearsession — start a fresh Claude conversation\n` +
    `/stop — cancel running request\n` +
    `/dir — show working directory\n` +
    `/id — show your Telegram user ID\n\n` +
    `Daily reminders at ${DAILY_REMINDER_HOUR}:00`,
    { parse_mode: 'Markdown' }
  );
});

// --- /stop command ---
bot.onText(/\/stop/, (msg) => {
  const controller = activeSessions.get(msg.chat.id);
  if (controller) {
    controller.abort();
    activeSessions.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Request cancelled.');
  } else {
    bot.sendMessage(msg.chat.id, 'No active request to cancel.');
  }
});

// --- /clearsession command ---
bot.onText(/\/clearsession/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  claudeSessions.delete(String(msg.chat.id));
  saveSessionsToFile();
  bot.sendMessage(msg.chat.id, 'Session cleared. Next message starts a fresh conversation.');
});

// --- /dir command ---
bot.onText(/\/dir/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, `Working directory: \`${WORKING_DIR}\``, { parse_mode: 'Markdown' });
});

// --- /id command ---
bot.onText(/\/id/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your user ID: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
});

// --- Task Manager Commands ---

bot.onText(/\/addtask\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const chatId = String(msg.chat.id);
  const input = match[1].trim();
  const dateMatch = input.match(/\s+(\d{4}-\d{2}-\d{2})$/);
  let text, deadline;
  if (dateMatch) {
    deadline = dateMatch[1];
    text = input.slice(0, -dateMatch[0].length).trim();
  } else {
    text = input;
    deadline = null;
  }
  if (!text) {
    bot.sendMessage(msg.chat.id, 'Usage: `/addtask Task description YYYY-MM-DD`\nDeadline is optional.', { parse_mode: 'Markdown' });
    return;
  }
  const list = getUserTasks(chatId);
  const id = list.length > 0 ? Math.max(...list.map(t => t.id)) + 1 : 1;
  list.push({ id, text, deadline, done: false, createdAt: new Date().toISOString() });
  setUserTasks(chatId, list);
  let reply = `Task *#${id}* added: ${text}`;
  if (deadline) reply += `\nDeadline: ${formatDate(deadline)}`;
  bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
});

bot.onText(/\/tasks/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const chatId = String(msg.chat.id);
  const list = getUserTasks(chatId);
  if (list.length === 0) {
    bot.sendMessage(msg.chat.id, 'No tasks yet. Add one with `/addtask`', { parse_mode: 'Markdown' });
    return;
  }
  const pending = list.filter(t => !t.done);
  const completed = list.filter(t => t.done);
  const lines = ['*Your Tasks*\n'];
  if (pending.length > 0) {
    lines.push('*Pending:*');
    for (const t of pending) {
      const overdue = t.deadline && isOverdue(t.deadline) ? ' ⚠️ OVERDUE' : '';
      const dl = t.deadline ? ` (due ${formatDate(t.deadline)})` : '';
      lines.push(`  #${t.id} — ${t.text}${dl}${overdue}`);
    }
  }
  if (completed.length > 0) {
    lines.push('\n*Completed:*');
    for (const t of completed.slice(-5)) {
      lines.push(`  ~#${t.id} — ${t.text}~`);
    }
    if (completed.length > 5) lines.push(`  ...and ${completed.length - 5} more`);
  }
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/done\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const chatId = String(msg.chat.id);
  const taskId = parseInt(match[1], 10);
  const list = getUserTasks(chatId);
  const task = list.find(t => t.id === taskId);
  if (!task) { bot.sendMessage(msg.chat.id, `Task #${taskId} not found.`); return; }
  if (task.done) { bot.sendMessage(msg.chat.id, `Task #${taskId} is already done.`); return; }
  task.done = true;
  task.completedAt = new Date().toISOString();
  setUserTasks(chatId, list);
  bot.sendMessage(msg.chat.id, `Task *#${taskId}* marked as done: ~${task.text}~`, { parse_mode: 'Markdown' });
});

bot.onText(/\/deltask\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const chatId = String(msg.chat.id);
  const taskId = parseInt(match[1], 10);
  const list = getUserTasks(chatId);
  const idx = list.findIndex(t => t.id === taskId);
  if (idx === -1) { bot.sendMessage(msg.chat.id, `Task #${taskId} not found.`); return; }
  const removed = list.splice(idx, 1)[0];
  setUserTasks(chatId, list);
  bot.sendMessage(msg.chat.id, `Deleted task *#${taskId}*: ${removed.text}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/overdue/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const chatId = String(msg.chat.id);
  const list = getUserTasks(chatId);
  const overdue = list.filter(t => !t.done && t.deadline && isOverdue(t.deadline));
  if (overdue.length === 0) { bot.sendMessage(msg.chat.id, 'No overdue tasks.'); return; }
  const lines = [`*⚠️ ${overdue.length} Overdue Task${overdue.length > 1 ? 's' : ''}:*\n`];
  for (const t of overdue) {
    const days = Math.floor((Date.now() - new Date(t.deadline).getTime()) / 86400000);
    lines.push(`  #${t.id} — ${t.text} (${days}d overdue, due ${formatDate(t.deadline)})`);
  }
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// --- Daily Reminder ---
function sendDailyReminders() {
  const allTasks = loadTasks();
  for (const [chatId, list] of Object.entries(allTasks)) {
    const pending = list.filter(t => !t.done);
    if (pending.length === 0) continue;
    const overdue = pending.filter(t => t.deadline && isOverdue(t.deadline));
    const dueToday = pending.filter(t => {
      if (!t.deadline) return false;
      const d = new Date(t.deadline);
      const now = new Date();
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    });
    const upcoming = pending.filter(t => {
      if (!t.deadline) return false;
      const d = new Date(t.deadline);
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const diff = (d.getTime() - now.getTime()) / 86400000;
      return diff > 0 && diff <= 3;
    });
    const noDeadline = pending.filter(t => !t.deadline);
    const lines = ['*Daily Task Summary*\n'];
    if (overdue.length > 0) {
      lines.push(`*⚠️ Overdue (${overdue.length}):*`);
      for (const t of overdue) {
        const days = Math.floor((Date.now() - new Date(t.deadline).getTime()) / 86400000);
        lines.push(`  #${t.id} — ${t.text} (${days}d overdue)`);
      }
    }
    if (dueToday.length > 0) {
      lines.push(`\n*Due Today (${dueToday.length}):*`);
      for (const t of dueToday) lines.push(`  #${t.id} — ${t.text}`);
    }
    if (upcoming.length > 0) {
      lines.push(`\n*Upcoming (next 3 days):*`);
      for (const t of upcoming) lines.push(`  #${t.id} — ${t.text} (due ${formatDate(t.deadline)})`);
    }
    if (noDeadline.length > 0) {
      lines.push(`\n*No deadline (${noDeadline.length}):*`);
      for (const t of noDeadline) lines.push(`  #${t.id} — ${t.text}`);
    }
    lines.push(`\n_${pending.length} pending total_`);
    bot.sendMessage(parseInt(chatId), lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
  }
}

let lastReminderDate = '';
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() === DAILY_REMINDER_HOUR && now.getMinutes() === 0 && lastReminderDate !== today) {
    lastReminderDate = today;
    sendDailyReminders();
  }
}, 60_000);

// --- Inline keyboard callback handler (apply / revert) ---
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const [action, chatIdStr] = data.split(':');
  const cid = parseInt(chatIdStr, 10);

  if (action === 'apply') {
    pendingChanges.delete(cid);
    await bot.answerCallbackQuery(query.id, { text: 'Changes applied!' });
    // Remove the inline keyboard from the diff message
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    ).catch(() => {});
    await bot.sendMessage(cid, '✅ Changes applied.', {
      reply_to_message_id: query.message.message_id,
    }).catch(() => {});

  } else if (action === 'revert') {
    const changes = pendingChanges.get(cid);
    if (changes) {
      revertClaudeChanges(changes);
      pendingChanges.delete(cid);
    }
    await bot.answerCallbackQuery(query.id, { text: 'Changes reverted.' });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    ).catch(() => {});
    await bot.sendMessage(cid, '❌ Changes reverted.', {
      reply_to_message_id: query.message.message_id,
    }).catch(() => {});
  }
});

// --- Handle messages ---
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  if (!msg.text) return;
  if (!isAllowed(msg.from.id)) {
    bot.sendMessage(msg.chat.id, 'Unauthorized. Use /id to get your user ID and add it to TELEGRAM_ALLOWED_USERS.');
    return;
  }

  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, 'Still processing previous request. Use /stop to cancel it.');
    return;
  }

  const originalMsgId = msg.message_id;
  const thinking = await bot.sendMessage(msg.chat.id, '⏳ Processing...', {
    reply_to_message_id: originalMsgId,
  });

  // Snapshot working tree state before Claude runs
  const beforeState = captureWorkingTreeState();

  try {
    const response = await runClaude(msg.text, msg.chat.id);
    await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

    // Send Claude's text response (threaded)
    await sendResponse(msg.chat.id, response, originalMsgId);

    // Detect file changes Claude made
    const changes = detectClaudeChanges(beforeState);

    if (changes.hasChanges) {
      const fileList = [
        ...changes.claudeChangedFiles.map(f => `📝 ${f}`),
        ...changes.newFiles.map(f => `➕ ${f}`),
      ].join('\n');

      // Send diff (truncated if too long)
      let diffText = changes.diffText;
      const MAX_DIFF = 3500;
      const truncated = diffText.length > MAX_DIFF;
      if (truncated) diffText = diffText.slice(0, MAX_DIFF) + '\n... (truncated)';

      const diffMsg = `*Changed files:*\n${fileList}\n\n\`\`\`diff\n${diffText}\n\`\`\``;

      // Store pending changes for revert
      pendingChanges.set(msg.chat.id, changes);

      const keyboard = {
        inline_keyboard: [[
          { text: '✅ Apply', callback_data: `apply:${msg.chat.id}` },
          { text: '❌ Revert', callback_data: `revert:${msg.chat.id}` },
        ]],
      };

      const chunks = splitMessage(diffMsg);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const opts = {
          parse_mode: 'Markdown',
          reply_to_message_id: originalMsgId,
          ...(isLast ? { reply_markup: keyboard } : {}),
        };
        try {
          await bot.sendMessage(msg.chat.id, chunks[i], opts);
        } catch {
          await bot.sendMessage(msg.chat.id, chunks[i], {
            reply_to_message_id: originalMsgId,
            ...(isLast ? { reply_markup: keyboard } : {}),
          });
        }
      }
    }
  } catch (err) {
    await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
    if (err.name === 'AbortError') {
      await bot.sendMessage(msg.chat.id, 'Request was cancelled.', { reply_to_message_id: originalMsgId });
    } else {
      await bot.sendMessage(msg.chat.id, `Error: ${err.message}`, { reply_to_message_id: originalMsgId });
    }
  }
});

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  saveSessionsToFile();
  bot.stopPolling();
  for (const controller of activeSessions.values()) controller.abort();
  process.exit(0);
});
