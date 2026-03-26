// "kokotko"
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
const BANKROLL_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bankroll.json');
const ALERTS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'alerts.json');
const HISTORY_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'parlay_history.json');
const CLV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'clv_tracker.json');
const ELO_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'elo_ratings.json');
const TIERS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'tiers.json');
const BIAS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bookmaker_bias.json');
const SIGNALS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'signals.json');
const ARB_PERSIST_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'arb_persistence.json');
const USER_SETTINGS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'user_settings.json');
const DAILY_REMINDER_HOUR = parseInt(process.env.REMINDER_HOUR || '9', 10);
const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR || '9', 10);
const WEEKLY_REPORT_DAY = 1; // Monday

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
    `*Ruflo Odds Intelligence Platform*\n\n` +
    `Professional sports odds intelligence for bettors & syndicates.\n\n` +
    `*Quick Start:*\n` +
    `/signals — unified signal dashboard\n` +
    `/odds soccer today — full odds + intelligence\n` +
    `/xarb — cross-market arbitrage scanner\n` +
    `/consensus — market consensus model\n` +
    `/predict — closing line predictions\n\n` +
    `*Core Intelligence:*\n` +
    `/value — +EV value bets vs sharp lines\n` +
    `/arb — h2h arbitrage scanner\n` +
    `/sharp — Pinnacle true probabilities\n` +
    `/moves — steam moves & odds tracking\n` +
    `/bias — bookmaker bias report\n` +
    `/liquidity — market liquidity scores\n\n` +
    `*Analysis:*\n` +
    `/compare <team> — bookmaker comparison\n` +
    `/form <team> — team form & results\n` +
    `/elo — ELO rankings & predictions\n` +
    `/kelly — optimal stake sizing\n\n` +
    `*Tracking:*\n` +
    `/bankroll — P/L, ROI, performance\n` +
    `/closing — closing line value tracker\n` +
    `/weekly — weekly performance report\n` +
    `/tier — subscription & settings\n\n` +
    `/help — full command list`,
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

// --- /status command ---
// Reports live bot health: uptime, session counts, working directory,
// allowed-user config, and current git working-tree state.
bot.onText(/\/status/, (msg) => {
  if (!isAllowed(msg.from.id)) return;

  // Format process uptime as "Xh Ym Zs", "Ym Zs", or "Zs"
  const uptimeSec = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = uptimeSec % 60;
  const uptime = hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;

  // getGitStatus() returns '' on error (e.g. not a git repo), so trim is safe
  const gitStatus = getGitStatus().trim();
  const gitSummary = gitStatus
    ? `\`\`\`\n${gitStatus}\n\`\`\``
    : 'No uncommitted changes';

  // Empty ALLOWED_USERS means the bot accepts messages from anyone
  const userRestriction = ALLOWED_USERS.length
    ? `${ALLOWED_USERS.length} user(s)`
    : 'None (all allowed)';

  const lines = [
    `*Ruflo Bot Status*`,
    ``,
    `*Uptime:* ${uptime}`,
    `*Active sessions:* ${activeSessions.size}`,   // in-progress Claude runs
    `*Claude sessions:* ${claudeSessions.size}`,   // persisted session IDs
    `*Working directory:* \`${WORKING_DIR}\``,
    `*User restriction:* ${userRestriction}`,
    ``,
    `*Git status:*`,
    gitSummary,
  ];

  sendResponse(msg.chat.id, lines.join('\n'));
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

// --- Betting / Odds Commands ---
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

const SPORT_ALIASES = {
  football: 'soccer_epl',
  soccer: 'soccer_epl',
  epl: 'soccer_epl',
  premier: 'soccer_epl',
  laliga: 'soccer_spain_la_liga',
  bundesliga: 'soccer_germany_bundesliga',
  seriea: 'soccer_italy_serie_a',
  ligue1: 'soccer_france_ligue_one',
  champions: 'soccer_uefa_champs_league',
  ucl: 'soccer_uefa_champs_league',
  nba: 'basketball_nba',
  nfl: 'americanfootball_nfl',
  nhl: 'icehockey_nhl',
  mlb: 'baseball_mlb',
  tennis: 'tennis_atp_french_open',
  mma: 'mma_mixed_martial_arts',
  ufc: 'mma_mixed_martial_arts',
};

async function fetchOdds(sport, market = 'h2h') {
  const sportKey = SPORT_ALIASES[sport.toLowerCase()] || sport;
  const url = `${ODDS_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=${market}&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchSports() {
  const res = await fetch(`${ODDS_BASE}/sports/?apiKey=${ODDS_API_KEY}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

function filterByDay(events, dayFilter) {
  if (!dayFilter) return events;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  const dayAfter = new Date(today.getTime() + 2 * 86400000);

  if (dayFilter === 'today') {
    return events.filter(ev => {
      const t = new Date(ev.commence_time);
      return t >= today && t < tomorrow;
    });
  } else if (dayFilter === 'tomorrow') {
    return events.filter(ev => {
      const t = new Date(ev.commence_time);
      return t >= tomorrow && t < dayAfter;
    });
  }
  return events;
}

function formatOddsMessage(events, sportName, dayLabel) {
  if (!events.length) return `No ${dayLabel || ''} ${sportName} events found.`.replace('  ', ' ');

  const header = dayLabel ? `${sportName} — ${dayLabel}` : `${sportName} — Upcoming`;
  const lines = [`*${header}*\n`];
  for (const ev of events.slice(0, 10)) {
    const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    lines.push(`*${ev.home_team} vs ${ev.away_team}*`);
    lines.push(`  ${time}`);

    if (ev.bookmakers?.length > 0) {
      // Get best odds across bookmakers
      const bestOdds = {};
      for (const bm of ev.bookmakers) {
        for (const mkt of bm.markets) {
          for (const outcome of mkt.outcomes) {
            const key = outcome.name;
            if (!bestOdds[key] || outcome.price > bestOdds[key].price) {
              bestOdds[key] = { price: outcome.price, bookmaker: bm.title };
            }
          }
        }
      }
      const oddsStr = Object.entries(bestOdds)
        .map(([name, { price, bookmaker }]) => `${name}: *${price.toFixed(2)}* (${bookmaker})`)
        .join(' | ');
      lines.push(`  ${oddsStr}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// --- Betting Intelligence (Phase 1) ---

// Odds cache for movement detection (persists to disk)
const ODDS_CACHE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'odds_cache.json');
function loadOddsCache() { try { return JSON.parse(fs.readFileSync(ODDS_CACHE_FILE, 'utf8')); } catch { return {}; } }
function saveOddsCache(cache) { fs.writeFileSync(ODDS_CACHE_FILE, JSON.stringify(cache)); }
const oddsCache = loadOddsCache(); // { eventId: { timestamp, odds: { outcomeName: { bookmaker: price } } } }

// Sharp bookmakers (their lines are most accurate)
const SHARP_BOOKS = ['Pinnacle', 'pinnacle', 'Betfair', 'betfair', 'BetFair Exchange'];
const SHARP_WEIGHT = 2.0; // Sharp lines count double in weighted average

// Remove vig to get true probabilities
function removeVig(outcomes) {
  // outcomes = [{ name, price }, ...]
  const totalImplied = outcomes.reduce((sum, o) => sum + (1 / o.price), 0);
  return outcomes.map(o => ({
    name: o.name,
    price: o.price,
    impliedProb: (1 / o.price) / totalImplied, // true probability (no-vig)
    rawImplied: 1 / o.price,
  }));
}

// Get weighted average odds (Pinnacle heavier)
function weightedAvgOdds(bookmakers, outcomeName) {
  let totalWeight = 0, weightedSum = 0;
  for (const bm of bookmakers) {
    for (const mkt of bm.markets) {
      for (const out of mkt.outcomes) {
        if (out.name === outcomeName) {
          const w = SHARP_BOOKS.includes(bm.title) ? SHARP_WEIGHT : 1.0;
          weightedSum += out.price * w;
          totalWeight += w;
        }
      }
    }
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

// Get Pinnacle odds specifically
function getPinnacleOdds(bookmakers) {
  const pin = bookmakers.find(bm => SHARP_BOOKS.includes(bm.title));
  if (!pin) return null;
  const h2h = pin.markets.find(m => m.key === 'h2h');
  if (!h2h) return null;
  return Object.fromEntries(h2h.outcomes.map(o => [o.name, o.price]));
}

// Detect arbitrage: sum of (1/best_odds) < 1.0 means guaranteed profit
function findArbitrage(event) {
  const bestOdds = {};
  for (const bm of (event.bookmakers || [])) {
    for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
      for (const out of mkt.outcomes) {
        if (!bestOdds[out.name] || out.price > bestOdds[out.name].price) {
          bestOdds[out.name] = { price: out.price, bookmaker: bm.title };
        }
      }
    }
  }
  const outcomes = Object.entries(bestOdds);
  if (outcomes.length < 2) return null;
  const totalImplied = outcomes.reduce((sum, [, { price }]) => sum + (1 / price), 0);
  if (totalImplied < 1.0) {
    const profit = ((1 / totalImplied) - 1) * 100;
    return { outcomes: bestOdds, totalImplied, profit };
  }
  return null;
}

// Find +EV bets (where best available odds beat sharp true probability)
function findValueBets(event) {
  const pinOdds = getPinnacleOdds(event.bookmakers || []);
  if (!pinOdds) return []; // need sharp line as baseline

  // Get true probs from Pinnacle (remove vig)
  const pinOutcomes = Object.entries(pinOdds).map(([name, price]) => ({ name, price }));
  const trueProbs = removeVig(pinOutcomes);
  const trueProbMap = Object.fromEntries(trueProbs.map(o => [o.name, o.impliedProb]));

  const valueBets = [];
  for (const bm of (event.bookmakers || [])) {
    if (SHARP_BOOKS.includes(bm.title)) continue; // skip sharp books themselves
    for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
      for (const out of mkt.outcomes) {
        const trueProb = trueProbMap[out.name];
        if (!trueProb) continue;
        const impliedFromBookmaker = 1 / out.price;
        const edge = trueProb - impliedFromBookmaker; // negative = +EV for us
        if (edge < -0.02) { // at least 2% edge
          valueBets.push({
            outcome: out.name,
            bookmaker: bm.title,
            odds: out.price,
            trueProb: trueProb,
            edge: -edge,
            ev: (-edge * out.price * 100).toFixed(1), // expected value per $100
          });
        }
      }
    }
  }
  return valueBets.sort((a, b) => b.edge - a.edge);
}

// Update odds cache and detect movements
function updateOddsCache(events) {
  const movements = [];
  const now = Date.now();
  for (const ev of events) {
    const key = ev.id;
    const prev = oddsCache[key];
    const current = {};
    for (const bm of (ev.bookmakers || [])) {
      for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
        for (const out of mkt.outcomes) {
          if (!current[out.name]) current[out.name] = {};
          current[out.name][bm.title] = out.price;
        }
      }
    }
    if (prev) {
      for (const [outcome, books] of Object.entries(current)) {
        for (const [bookmaker, price] of Object.entries(books)) {
          const oldPrice = prev.odds?.[outcome]?.[bookmaker];
          if (oldPrice && Math.abs(price - oldPrice) >= 0.05) {
            const isSteam = SHARP_BOOKS.includes(bookmaker);
            movements.push({
              event: `${ev.home_team} vs ${ev.away_team}`,
              outcome, bookmaker, oldPrice, newPrice: price,
              direction: price > oldPrice ? 'UP' : 'DOWN',
              change: price - oldPrice,
              isSteam,
              time: ev.commence_time,
            });
          }
        }
      }
    }
    oddsCache[key] = { timestamp: now, odds: current };
  }
  saveOddsCache(oddsCache);
  return movements;
}

// ============================================================
// --- CLIENT TIER SYSTEM (Monetization Infrastructure) ---
// ============================================================
const TIERS = {
  free:      { name: 'Free',               price: '€0/mo',   maxSignals: 3,  maxArbs: 1,  features: ['basic_odds', 'basic_value'] },
  pro:       { name: 'Pro',                price: '€50/mo',  maxSignals: 20, maxArbs: 10, features: ['basic_odds', 'basic_value', 'arb', 'sharp', 'moves', 'consensus', 'bias', 'kelly', 'signals', 'xarb', 'predict'] },
  syndicate: { name: 'Syndicate',          price: '€300/mo', maxSignals: -1, maxArbs: -1, features: ['*'] },
};

function loadTiers() { try { return JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8')); } catch { return {}; } }
function saveTiers(data) { fs.writeFileSync(TIERS_FILE, JSON.stringify(data, null, 2)); }
function getUserTier(chatId) { return loadTiers()[String(chatId)] || 'syndicate'; }
function setUserTier(chatId, tier) { const d = loadTiers(); d[String(chatId)] = tier; saveTiers(d); }
function hasFeature(chatId, feature) {
  const tier = getUserTier(chatId);
  const t = TIERS[tier];
  return t.features.includes('*') || t.features.includes(feature);
}
function tierGate(chatId, feature) {
  if (hasFeature(chatId, feature)) return null;
  const tier = getUserTier(chatId);
  return `This feature requires a higher tier. You're on *${TIERS[tier].name}* (${TIERS[tier].price}).\n\nUpgrade with /tier to unlock.`;
}

// --- User Settings (configurable EV threshold, etc.) ---
function loadUserSettings() { try { return JSON.parse(fs.readFileSync(USER_SETTINGS_FILE, 'utf8')); } catch { return {}; } }
function saveUserSettings(data) { fs.writeFileSync(USER_SETTINGS_FILE, JSON.stringify(data, null, 2)); }
function getUserSettings(chatId) {
  const all = loadUserSettings();
  return { minEdge: 0.02, minArbProfit: 0.1, ...all[String(chatId)] };
}
function setUserSetting(chatId, key, value) {
  const all = loadUserSettings();
  if (!all[String(chatId)]) all[String(chatId)] = {};
  all[String(chatId)][key] = value;
  saveUserSettings(all);
}

// ============================================================
// --- CROSS-MARKET ARBITRAGE (h2h + spreads + totals) ---
// ============================================================
function findCrossMarketArbitrage(event) {
  const arbs = [];
  const markets = {};
  // Collect best odds per market per outcome
  for (const bm of (event.bookmakers || [])) {
    for (const mkt of bm.markets) {
      if (!markets[mkt.key]) markets[mkt.key] = {};
      for (const out of mkt.outcomes) {
        const outKey = out.point != null ? `${out.name}|${out.point}` : out.name;
        if (!markets[mkt.key][outKey] || out.price > markets[mkt.key][outKey].price) {
          markets[mkt.key][outKey] = { price: out.price, bookmaker: bm.title, name: out.name, point: out.point };
        }
      }
    }
  }
  // Check each market individually for arb (2-way and 3-way)
  for (const [mktKey, outcomes] of Object.entries(markets)) {
    if (mktKey === 'h2h') continue; // already handled by findArbitrage
    const entries = Object.entries(outcomes);
    // For spreads/totals, group by complementary outcomes
    if (mktKey === 'totals') {
      // Over vs Under at same point
      const overs = entries.filter(([k]) => k.startsWith('Over'));
      for (const [overKey, overData] of overs) {
        const point = overData.point;
        const underEntry = entries.find(([k, d]) => k.startsWith('Under') && d.point === point);
        if (!underEntry) continue;
        const underData = underEntry[1];
        const totalImplied = (1 / overData.price) + (1 / underData.price);
        if (totalImplied < 1.0) {
          const profit = ((1 / totalImplied) - 1) * 100;
          arbs.push({
            market: 'totals',
            point,
            outcomes: { [`Over ${point}`]: overData, [`Under ${point}`]: underData },
            totalImplied, profit,
            match: `${event.home_team} vs ${event.away_team}`,
            time: event.commence_time,
          });
        }
      }
    } else if (mktKey === 'spreads') {
      // Home spread vs Away spread (complementary)
      const homeSpread = entries.find(([, d]) => d.name === event.home_team);
      const awaySpread = entries.find(([, d]) => d.name === event.away_team);
      if (homeSpread && awaySpread) {
        const totalImplied = (1 / homeSpread[1].price) + (1 / awaySpread[1].price);
        if (totalImplied < 1.0) {
          const profit = ((1 / totalImplied) - 1) * 100;
          arbs.push({
            market: 'spreads',
            outcomes: { [`${event.home_team} ${homeSpread[1].point > 0 ? '+' : ''}${homeSpread[1].point}`]: homeSpread[1], [`${event.away_team} ${awaySpread[1].point > 0 ? '+' : ''}${awaySpread[1].point}`]: awaySpread[1] },
            totalImplied, profit,
            match: `${event.home_team} vs ${event.away_team}`,
            time: event.commence_time,
          });
        }
      }
    }
  }
  return arbs;
}

// ============================================================
// --- GHOST ARB PERSISTENCE FILTER ---
// ============================================================
function loadArbPersistence() { try { return JSON.parse(fs.readFileSync(ARB_PERSIST_FILE, 'utf8')); } catch { return {}; } }
function saveArbPersistence(data) { fs.writeFileSync(ARB_PERSIST_FILE, JSON.stringify(data, null, 2)); }

function trackArbPersistence(arbs) {
  const persist = loadArbPersistence();
  const now = Date.now();
  const verified = [];

  for (const arb of arbs) {
    const key = `${arb.match || arb.home + ' vs ' + arb.away}|${Object.keys(arb.outcomes).sort().join(',')}`;
    if (persist[key]) {
      persist[key].lastSeen = now;
      persist[key].seenCount++;
      persist[key].profit = arb.profit;
      // Arb seen at least 2 times across 60+ seconds = likely real
      if (persist[key].seenCount >= 2 && (now - persist[key].firstSeen) > 60000) {
        verified.push({ ...arb, persistence: { seenCount: persist[key].seenCount, ageMinutes: Math.floor((now - persist[key].firstSeen) / 60000) } });
      }
    } else {
      persist[key] = { firstSeen: now, lastSeen: now, seenCount: 1, profit: arb.profit };
    }
  }

  // Clean up entries older than 2 hours
  for (const [k, v] of Object.entries(persist)) {
    if (now - v.lastSeen > 2 * 60 * 60 * 1000) delete persist[k];
  }
  saveArbPersistence(persist);
  return { all: arbs, verified };
}

// ============================================================
// --- BOOKMAKER BIAS DETECTOR ---
// ============================================================
function loadBias() { try { return JSON.parse(fs.readFileSync(BIAS_FILE, 'utf8')); } catch { return {}; } }
function saveBias(data) { fs.writeFileSync(BIAS_FILE, JSON.stringify(data, null, 2)); }

function updateBookmakerBias(events) {
  const bias = loadBias();
  for (const ev of events) {
    const pinOdds = getPinnacleOdds(ev.bookmakers || []);
    if (!pinOdds) continue;
    const pinOutcomes = Object.entries(pinOdds).map(([name, price]) => ({ name, price }));
    const trueProbs = removeVig(pinOutcomes);
    const trueProbMap = Object.fromEntries(trueProbs.map(o => [o.name, o.impliedProb]));

    for (const bm of (ev.bookmakers || [])) {
      if (SHARP_BOOKS.includes(bm.title)) continue;
      if (!bias[bm.title]) bias[bm.title] = { totalBias: 0, count: 0, favoriteBias: 0, underdogBias: 0, favCount: 0, undCount: 0 };
      for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
        for (const out of mkt.outcomes) {
          const trueProb = trueProbMap[out.name];
          if (!trueProb) continue;
          const impliedProb = 1 / out.price;
          const deviation = impliedProb - trueProb; // positive = bookmaker prices too low (overestimates probability)
          bias[bm.title].totalBias += deviation;
          bias[bm.title].count++;
          if (trueProb > 0.5) { bias[bm.title].favoriteBias += deviation; bias[bm.title].favCount++; }
          else { bias[bm.title].underdogBias += deviation; bias[bm.title].undCount++; }
        }
      }
    }
  }
  saveBias(bias);
  return bias;
}

function getBookmakerBiasReport() {
  const bias = loadBias();
  return Object.entries(bias)
    .filter(([, b]) => b.count >= 10)
    .map(([name, b]) => ({
      name,
      avgBias: b.totalBias / b.count,
      favBias: b.favCount > 0 ? b.favoriteBias / b.favCount : 0,
      undBias: b.undCount > 0 ? b.underdogBias / b.undCount : 0,
      samples: b.count,
    }))
    .sort((a, b) => Math.abs(b.avgBias) - Math.abs(a.avgBias));
}

// ============================================================
// --- CONSENSUS MARKET MODEL ---
// ============================================================
function calculateConsensus(event) {
  const outcomes = {};
  let totalBookmakers = 0;

  for (const bm of (event.bookmakers || [])) {
    totalBookmakers++;
    const isSharp = SHARP_BOOKS.includes(bm.title);
    const weight = isSharp ? 3.0 : 1.0;
    for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
      for (const out of mkt.outcomes) {
        if (!outcomes[out.name]) outcomes[out.name] = { weightedSum: 0, totalWeight: 0, prices: [], bookmakers: [] };
        outcomes[out.name].weightedSum += (1 / out.price) * weight;
        outcomes[out.name].totalWeight += weight;
        outcomes[out.name].prices.push(out.price);
        outcomes[out.name].bookmakers.push({ name: bm.title, price: out.price, sharp: isSharp });
      }
    }
  }

  // Normalize consensus probabilities
  let totalConsensusProb = 0;
  for (const [, data] of Object.entries(outcomes)) {
    data.rawConsensusProb = data.weightedSum / data.totalWeight;
    totalConsensusProb += data.rawConsensusProb;
  }

  const result = {};
  for (const [name, data] of Object.entries(outcomes)) {
    const consensusProb = data.rawConsensusProb / totalConsensusProb;
    const fairOdds = 1 / consensusProb;
    const bestPrice = Math.max(...data.prices);
    const worstPrice = Math.min(...data.prices);
    const spread = bestPrice - worstPrice;
    const disagreement = spread / ((bestPrice + worstPrice) / 2); // normalized spread
    result[name] = { consensusProb, fairOdds, bestPrice, worstPrice, spread, disagreement, bookmakerCount: data.bookmakers.length };
  }
  return { outcomes: result, totalBookmakers };
}

// ============================================================
// --- LIQUIDITY SCORING ---
// ============================================================
function scoreLiquidity(event) {
  const bmCount = event.bookmakers?.length || 0;
  if (bmCount === 0) return { score: 0, label: 'None', bmCount: 0, spread: 0 };

  // Calculate average odds spread across outcomes
  const outcomes = {};
  for (const bm of event.bookmakers) {
    for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
      for (const out of mkt.outcomes) {
        if (!outcomes[out.name]) outcomes[out.name] = [];
        outcomes[out.name].push(out.price);
      }
    }
  }

  let totalSpread = 0, outcomeCount = 0;
  for (const prices of Object.values(outcomes)) {
    if (prices.length < 2) continue;
    totalSpread += Math.max(...prices) - Math.min(...prices);
    outcomeCount++;
  }
  const avgSpread = outcomeCount > 0 ? totalSpread / outcomeCount : 0;

  // Score: 0-100
  // Bookmaker count: 0-50 points (10+ bms = 50)
  // Tight spread: 0-50 points (spread < 0.05 = 50)
  const bmScore = Math.min(bmCount / 10, 1) * 50;
  const spreadScore = Math.max(0, 1 - avgSpread / 0.5) * 50;
  const score = Math.round(bmScore + spreadScore);
  const label = score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : score >= 20 ? 'Low' : 'Very Low';

  return { score, label, bmCount, spread: avgSpread };
}

// ============================================================
// --- CLOSING LINE PREDICTOR ---
// ============================================================
function predictClosingLine(event) {
  const key = event.id;
  const cached = oddsCache[key];
  if (!cached) return null;

  const consensus = calculateConsensus(event);
  const predictions = {};

  for (const [name, data] of Object.entries(consensus.outcomes)) {
    // Use consensus + movement trend to predict closing
    const currentBest = data.bestPrice;

    // Check if there's cached movement data
    const prevOdds = cached.odds?.[name] || {};
    const prevPrices = Object.values(prevOdds);
    const avgPrev = prevPrices.length > 0 ? prevPrices.reduce((a, b) => a + b, 0) / prevPrices.length : currentBest;

    // Movement direction and magnitude
    const drift = currentBest - avgPrev;
    const momentum = drift * 0.3; // 30% continuation assumed

    // Predicted closing = consensus fair odds with momentum adjustment
    const predictedClosing = data.fairOdds + momentum;
    const edgeVsClosing = ((currentBest / predictedClosing) - 1) * 100;

    predictions[name] = {
      currentBest,
      fairOdds: data.fairOdds,
      predictedClosing: Math.max(1.01, predictedClosing),
      momentum: drift,
      edgeVsClosing,
      consensusProb: data.consensusProb,
    };
  }
  return predictions;
}

// ============================================================
// --- UNIFIED SIGNAL RANKING ---
// ============================================================
function rankSignals(events) {
  const signals = [];
  const now = Date.now();

  for (const ev of events) {
    const timeToStart = new Date(ev.commence_time).getTime() - now;
    const liquidity = scoreLiquidity(ev);
    const consensus = calculateConsensus(ev);

    // Value bet signals
    const valueBets = findValueBets(ev);
    for (const vb of valueBets) {
      const timeScore = timeToStart > 0 && timeToStart < 24 * 60 * 60 * 1000 ? 1.0 : 0.5;
      const liqScore = liquidity.score / 100;
      const edgeScore = Math.min(vb.edge * 10, 1.0); // cap at 10% edge
      const score = (edgeScore * 0.5 + liqScore * 0.3 + timeScore * 0.2) * 100;

      signals.push({
        type: 'VALUE',
        emoji: '💎',
        match: `${ev.home_team} vs ${ev.away_team}`,
        time: ev.commence_time,
        outcome: vb.outcome,
        bookmaker: vb.bookmaker,
        odds: vb.odds,
        edge: vb.edge,
        ev: vb.ev,
        liquidity: liquidity.label,
        score: Math.round(score),
        detail: `${(vb.edge * 100).toFixed(1)}% edge @ ${vb.odds.toFixed(2)}`,
      });
    }

    // Arbitrage signals
    const arb = findArbitrage(ev);
    if (arb) {
      const liqScore = liquidity.score / 100;
      const profitScore = Math.min(arb.profit / 5, 1.0);
      const score = (profitScore * 0.6 + liqScore * 0.4) * 100;

      signals.push({
        type: 'ARB',
        emoji: '🔒',
        match: `${ev.home_team} vs ${ev.away_team}`,
        time: ev.commence_time,
        profit: arb.profit,
        outcomes: arb.outcomes,
        liquidity: liquidity.label,
        score: Math.round(score),
        detail: `${arb.profit.toFixed(2)}% guaranteed`,
      });
    }

    // Cross-market arb signals
    const xarbs = findCrossMarketArbitrage(ev);
    for (const xa of xarbs) {
      signals.push({
        type: 'XARB',
        emoji: '🔄',
        match: xa.match,
        time: xa.time,
        market: xa.market,
        profit: xa.profit,
        outcomes: xa.outcomes,
        liquidity: liquidity.label,
        score: Math.round(xa.profit * 10 + liquidity.score * 0.3),
        detail: `${xa.market} ${xa.profit.toFixed(2)}%`,
      });
    }

    // Steam move signals (from cache)
    const movements = updateOddsCache([ev]);
    const steamMoves = movements.filter(m => m.isSteam);
    for (const sm of steamMoves) {
      const changeScore = Math.min(Math.abs(sm.change) / 0.5, 1.0);
      signals.push({
        type: 'STEAM',
        emoji: '🚨',
        match: sm.event,
        time: sm.time,
        outcome: sm.outcome,
        bookmaker: sm.bookmaker,
        oldPrice: sm.oldPrice,
        newPrice: sm.newPrice,
        direction: sm.direction,
        liquidity: liquidity.label,
        score: Math.round(changeScore * 80 + 20),
        detail: `${sm.oldPrice.toFixed(2)} → ${sm.newPrice.toFixed(2)} (${sm.bookmaker})`,
      });
    }

    // Consensus disagreement signals
    for (const [outName, outData] of Object.entries(consensus.outcomes)) {
      if (outData.disagreement > 0.15) { // >15% disagreement between bookmakers
        signals.push({
          type: 'DISAGREE',
          emoji: '⚡',
          match: `${ev.home_team} vs ${ev.away_team}`,
          time: ev.commence_time,
          outcome: outName,
          disagreement: outData.disagreement,
          bestPrice: outData.bestPrice,
          worstPrice: outData.worstPrice,
          liquidity: liquidity.label,
          score: Math.round(outData.disagreement * 200),
          detail: `${outData.worstPrice.toFixed(2)}-${outData.bestPrice.toFixed(2)} spread`,
        });
      }
    }
  }

  // Sort by score descending
  signals.sort((a, b) => b.score - a.score);
  return signals;
}

// Multi-sharp weighting: weight by accuracy track record
const SHARP_BOOK_WEIGHTS = {
  'Pinnacle': 3.0,
  'pinnacle': 3.0,
  'Betfair': 2.5,
  'betfair': 2.5,
  'BetFair Exchange': 2.5,
  'Matchbook': 2.0,
  'Smarkets': 1.8,
};

function getSharpWeight(bookmaker) {
  return SHARP_BOOK_WEIGHTS[bookmaker] || (SHARP_BOOKS.includes(bookmaker) ? SHARP_WEIGHT : 1.0);
}

// Enhanced value bet finder with configurable threshold and multi-sharp weighting
function findValueBetsEnhanced(event, minEdge = 0.02) {
  // Build true probabilities from ALL sharp bookmakers (multi-sharp weighted)
  let sharpWeightedProbs = {};
  let hasSharp = false;

  for (const bm of (event.bookmakers || [])) {
    const w = getSharpWeight(bm.title);
    if (w <= 1.0) continue; // not a sharp book
    hasSharp = true;
    for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
      const outcomes = mkt.outcomes.map(o => ({ name: o.name, price: o.price }));
      const devigged = removeVig(outcomes);
      for (const d of devigged) {
        if (!sharpWeightedProbs[d.name]) sharpWeightedProbs[d.name] = { weightedProb: 0, totalWeight: 0 };
        sharpWeightedProbs[d.name].weightedProb += d.impliedProb * w;
        sharpWeightedProbs[d.name].totalWeight += w;
      }
    }
  }

  if (!hasSharp) return findValueBets(event); // fallback to Pinnacle-only

  // Normalize
  const trueProbs = {};
  let totalProb = 0;
  for (const [name, data] of Object.entries(sharpWeightedProbs)) {
    trueProbs[name] = data.weightedProb / data.totalWeight;
    totalProb += trueProbs[name];
  }
  // Re-normalize to sum to 1
  for (const name of Object.keys(trueProbs)) trueProbs[name] /= totalProb;

  const valueBets = [];
  for (const bm of (event.bookmakers || [])) {
    if (getSharpWeight(bm.title) > 1.0) continue; // skip sharp books
    for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
      for (const out of mkt.outcomes) {
        const trueProb = trueProbs[out.name];
        if (!trueProb) continue;
        const impliedFromBm = 1 / out.price;
        const edge = trueProb - impliedFromBm;
        if (edge < -minEdge) {
          valueBets.push({
            outcome: out.name, bookmaker: bm.title, odds: out.price,
            trueProb, edge: -edge,
            ev: (-edge * out.price * 100).toFixed(1),
            multiSharp: true,
          });
        }
      }
    }
  }
  return valueBets.sort((a, b) => b.edge - a.edge);
}

// Build suggested parlays from events
// Picks: safe parlay (high prob favorites), value parlay (+EV picks), risky parlay (higher odds)
function buildParlays(events, stake = 10) {
  const scored = [];
  for (const ev of events) {
    const pinOdds = getPinnacleOdds(ev.bookmakers || []);
    const bestOdds = {};
    let bmCount = 0;
    for (const bm of (ev.bookmakers || [])) {
      bmCount++;
      for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
        for (const out of mkt.outcomes) {
          if (!bestOdds[out.name] || out.price > bestOdds[out.name].price) {
            bestOdds[out.name] = { price: out.price, bookmaker: bm.title };
          }
        }
      }
    }
    if (Object.keys(bestOdds).length < 2) continue;

    // Get true probs if Pinnacle available
    let trueProbs = null;
    if (pinOdds) {
      const pinOut = Object.entries(pinOdds).map(([n, p]) => ({ name: n, price: p }));
      trueProbs = Object.fromEntries(removeVig(pinOut).map(o => [o.name, o.impliedProb]));
    }

    // Find the favorite (lowest best odds = highest probability)
    let favName = null, favOdds = 999, favProb = 0;
    for (const [name, { price }] of Object.entries(bestOdds)) {
      if (name === 'Draw') continue; // skip draws for parlays
      if (price < favOdds) { favOdds = price; favName = name; favProb = trueProbs?.[name] || (1 / price); }
    }

    // Find best value pick (highest edge vs sharp)
    let valuePick = null;
    if (trueProbs) {
      for (const [name, { price, bookmaker }] of Object.entries(bestOdds)) {
        if (name === 'Draw') continue;
        const tp = trueProbs[name];
        if (!tp) continue;
        const edge = tp - (1 / price);
        if (!valuePick || edge < valuePick.edge) {
          valuePick = { name, price, bookmaker, edge: -edge, trueProb: tp };
        }
      }
    }

    scored.push({
      match: `${ev.home_team} vs ${ev.away_team}`,
      time: ev.commence_time,
      bmCount,
      favorite: { name: favName, odds: favOdds, prob: favProb, bookmaker: bestOdds[favName]?.bookmaker },
      valuePick,
      bestOdds,
    });
  }

  // Sort by popularity (bookmaker count) and probability
  scored.sort((a, b) => (b.bmCount * b.favorite.prob) - (a.bmCount * a.favorite.prob));

  const parlays = [];

  // 1. SAFE PARLAY: top 3-4 biggest favorites (high prob, low odds)
  const safePicks = scored
    .filter(s => s.favorite.prob >= 0.50 && s.favorite.odds >= 1.15 && s.favorite.odds <= 1.80)
    .slice(0, 4);
  if (safePicks.length >= 2) {
    const combinedOdds = safePicks.reduce((acc, p) => acc * p.favorite.odds, 1);
    const combinedProb = safePicks.reduce((acc, p) => acc * p.favorite.prob, 1);
    parlays.push({
      type: 'SAFE',
      emoji: '🛡️',
      label: 'Safe Parlay',
      desc: 'Heavy favorites, lower payout',
      picks: safePicks.map(s => ({ match: s.match, pick: s.favorite.name, odds: s.favorite.odds, prob: s.favorite.prob, bookmaker: s.favorite.bookmaker })),
      combinedOdds,
      combinedProb,
      payout: (stake * combinedOdds).toFixed(2),
      profit: (stake * combinedOdds - stake).toFixed(2),
    });
  }

  // 2. VALUE PARLAY: top 3 +EV picks (edge over sharp line)
  const valuePicks = scored
    .filter(s => s.valuePick && s.valuePick.edge > 0.01)
    .sort((a, b) => b.valuePick.edge - a.valuePick.edge)
    .slice(0, 3);
  if (valuePicks.length >= 2) {
    const combinedOdds = valuePicks.reduce((acc, p) => acc * p.valuePick.price, 1);
    const combinedProb = valuePicks.reduce((acc, p) => acc * p.valuePick.trueProb, 1);
    parlays.push({
      type: 'VALUE',
      emoji: '💎',
      label: 'Value Parlay',
      desc: 'Best edge vs sharp lines',
      picks: valuePicks.map(s => ({ match: s.match, pick: s.valuePick.name, odds: s.valuePick.price, prob: s.valuePick.trueProb, edge: s.valuePick.edge, bookmaker: s.valuePick.bookmaker })),
      combinedOdds,
      combinedProb,
      payout: (stake * combinedOdds).toFixed(2),
      profit: (stake * combinedOdds - stake).toFixed(2),
    });
  }

  // 3. RISKY PARLAY: 2-3 moderate underdogs with decent probability
  const riskyPicks = scored
    .filter(s => s.favorite.odds >= 1.80 && s.favorite.odds <= 4.00 && s.favorite.prob >= 0.25)
    .sort((a, b) => b.favorite.odds - a.favorite.odds)
    .slice(0, 3);
  if (riskyPicks.length >= 2) {
    const combinedOdds = riskyPicks.reduce((acc, p) => acc * p.favorite.odds, 1);
    const combinedProb = riskyPicks.reduce((acc, p) => acc * p.favorite.prob, 1);
    parlays.push({
      type: 'RISKY',
      emoji: '🔥',
      label: 'Risky Parlay',
      desc: 'Higher odds, bigger payout',
      picks: riskyPicks.map(s => ({ match: s.match, pick: s.favorite.name, odds: s.favorite.odds, prob: s.favorite.prob, bookmaker: s.favorite.bookmaker })),
      combinedOdds,
      combinedProb,
      payout: (stake * combinedOdds).toFixed(2),
      profit: (stake * combinedOdds - stake).toFixed(2),
    });
  }

  return parlays;
}

// Fetch all soccer odds (reusable)
async function fetchAllSoccer() {
  const url = `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// /value [today] — find +EV bets vs sharp lines
bot.onText(/\/value\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;

  bot.sendMessage(msg.chat.id, 'Scanning for value bets...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const filtered = filterByDay(events, dayFilter);
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      const allValue = [];
      for (const ev of filtered) {
        const vb = findValueBets(ev);
        for (const v of vb) {
          allValue.push({ ...v, home: ev.home_team, away: ev.away_team, time: ev.commence_time });
        }
      }

      if (!allValue.length) {
        bot.sendMessage(msg.chat.id, 'No +EV bets found right now. Pinnacle lines and bookmaker odds are too close.');
        return;
      }

      allValue.sort((a, b) => b.edge - a.edge);
      const lines = [`*+EV Value Bets* (vs Pinnacle sharp line)\n`];
      for (const v of allValue.slice(0, 15)) {
        const time = new Date(v.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        lines.push(`*${v.home} vs ${v.away}*`);
        lines.push(`  ${v.outcome} @ *${v.odds.toFixed(2)}* (${v.bookmaker})`);
        lines.push(`  Edge: *${(v.edge * 100).toFixed(1)}%* | True prob: ${(v.trueProb * 100).toFixed(1)}% | EV: +$${v.ev}/100`);
        lines.push(`  ${time}\n`);
      }
      lines.push(`_${allValue.length} value bets found across ${filtered.length} events_`);
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// /arb [today] — scan for arbitrage opportunities
bot.onText(/\/arb\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;

  bot.sendMessage(msg.chat.id, 'Scanning for arbitrage...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const filtered = filterByDay(events, dayFilter);
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      // Update cache while we're at it
      updateOddsCache(filtered);

      const arbs = [];
      for (const ev of filtered) {
        const arb = findArbitrage(ev);
        if (arb) arbs.push({ ...arb, home: ev.home_team, away: ev.away_team, time: ev.commence_time });
      }

      if (!arbs.length) {
        bot.sendMessage(msg.chat.id, 'No arbitrage opportunities found. Markets are efficient right now.');
        return;
      }

      arbs.sort((a, b) => b.profit - a.profit);
      const lines = [`*Arbitrage Opportunities*\n`];
      for (const arb of arbs.slice(0, 10)) {
        const time = new Date(arb.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        lines.push(`*${arb.home} vs ${arb.away}* — *${arb.profit.toFixed(2)}% profit*`);
        for (const [name, { price, bookmaker }] of Object.entries(arb.outcomes)) {
          const stake = ((1 / price) / arb.totalImplied * 100).toFixed(1);
          lines.push(`  ${name}: *${price.toFixed(2)}* @ ${bookmaker} (stake ${stake}%)`);
        }
        lines.push(`  ${time}\n`);
      }
      lines.push(`_${arbs.length} arb(s) found across ${filtered.length} events_`);
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// /moves [today] — show odds movements since last check
bot.onText(/\/moves\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;

  bot.sendMessage(msg.chat.id, 'Checking odds movements...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const filtered = filterByDay(events, dayFilter);
      const movements = updateOddsCache(filtered);
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!movements.length) {
        bot.sendMessage(msg.chat.id, 'No significant odds movements detected since last check.\nRun again later to track changes.');
        return;
      }

      // Steam moves first (sharp bookmaker moves)
      const steam = movements.filter(m => m.isSteam);
      const regular = movements.filter(m => !m.isSteam);

      const lines = [`*Odds Movements*\n`];
      if (steam.length) {
        lines.push(`*STEAM MOVES (sharp books)*`);
        for (const m of steam.slice(0, 10)) {
          const arrow = m.direction === 'UP' ? '📈' : '📉';
          lines.push(`${arrow} *${m.event}*`);
          lines.push(`  ${m.outcome}: ${m.oldPrice.toFixed(2)} → *${m.newPrice.toFixed(2)}* (${m.bookmaker})`);
        }
        lines.push('');
      }
      if (regular.length) {
        lines.push(`*Other movements*`);
        for (const m of regular.slice(0, 15)) {
          const arrow = m.direction === 'UP' ? '↑' : '↓';
          lines.push(`${arrow} ${m.event} | ${m.outcome}: ${m.oldPrice.toFixed(2)} → ${m.newPrice.toFixed(2)} (${m.bookmaker})`);
        }
      }
      lines.push(`\n_${movements.length} movements (${steam.length} steam) across ${filtered.length} events_`);
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// /sharp [today] — show Pinnacle lines with true probabilities
bot.onText(/\/sharp\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;

  bot.sendMessage(msg.chat.id, 'Fetching sharp lines...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const filtered = filterByDay(events, dayFilter);
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      const lines = [`*Sharp Lines (Pinnacle/Betfair)*\n`];
      let count = 0;
      for (const ev of filtered.slice(0, 15)) {
        const pinOdds = getPinnacleOdds(ev.bookmakers || []);
        if (!pinOdds) continue;
        count++;
        const pinOutcomes = Object.entries(pinOdds).map(([name, price]) => ({ name, price }));
        const trueProbs = removeVig(pinOutcomes);
        const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

        lines.push(`*${ev.home_team} vs ${ev.away_team}* — ${time}`);
        for (const tp of trueProbs) {
          lines.push(`  ${tp.name}: ${tp.price.toFixed(2)} → true *${(tp.impliedProb * 100).toFixed(1)}%*`);
        }
        lines.push('');
      }

      if (!count) {
        bot.sendMessage(msg.chat.id, 'No Pinnacle/Betfair lines found in current events.');
        return;
      }
      lines.push(`_${count} events with sharp lines_`);
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// /odds <sport> [today|tomorrow] — get odds filtered by day
bot.onText(/\/odds\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) {
    bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first. Get one free at the-odds-api.com', { parse_mode: 'Markdown' });
    return;
  }
  const parts = (match[1] || 'soccer').trim().split(/\s+/);
  let dayFilter = null;
  let dayLabel = null;

  // Extract today/tomorrow from the end
  const last = parts[parts.length - 1]?.toLowerCase();
  if (last === 'today') { dayFilter = 'today'; dayLabel = 'Today'; parts.pop(); }
  else if (last === 'tomorrow') { dayFilter = 'tomorrow'; dayLabel = 'Tomorrow'; parts.pop(); }

  const sport = parts.join(' ') || 'soccer';

  // "soccer" without a specific league fetches all major soccer leagues
  const ALL_SOCCER = [
    'soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_italy_serie_a',
    'soccer_france_ligue_one', 'soccer_uefa_champs_league', 'soccer_uefa_europa_league',
    'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga', 'soccer_brazil_campeonato',
    'soccer_usa_mls', 'soccer_mexico_ligamx', 'soccer_argentina_primera_division',
    'soccer_conmebol_copa_libertadores', 'soccer_efl_champ', 'soccer_spl',
    'soccer_belgium_first_div', 'soccer_austria_bundesliga', 'soccer_switzerland_superleague',
    'soccer_denmark_superliga', 'soccer_sweden_allsvenskan', 'soccer_norway_eliteserien',
    'soccer_fifa_world_cup_qualifiers_europe', 'soccer_uefa_nations_league',
  ];
  const sportLower = sport.toLowerCase();
  const isSoccerGeneric = sportLower === 'soccer' || sportLower === 'football' || sportLower === 'all';
  const sportKeys = isSoccerGeneric ? ALL_SOCCER : [SPORT_ALIASES[sportLower] || sport];

  bot.sendMessage(msg.chat.id, `Fetching ${sport} odds${dayLabel ? ` for ${dayLabel.toLowerCase()}` : ''}...`).then(async (thinking) => {
    try {
      let allEvents = [];
      if (isSoccerGeneric) {
        allEvents = await fetchAllSoccer();
      } else {
        for (const sk of sportKeys) {
          try { allEvents.push(...await fetchOdds(sk)); } catch {}
        }
      }
      allEvents = filterByDay(allEvents, dayFilter);
      allEvents.sort((a, b) => new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime());

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!allEvents.length) {
        bot.sendMessage(msg.chat.id, `No ${dayLabel ? dayLabel.toLowerCase() + "'s " : ''}${sport} events found.`);
        return;
      }

      // --- Part 1: Games with odds ---
      const header = dayLabel ? `${sport} — ${dayLabel}` : `${sport} — Upcoming`;
      const lines = [`*${header}*\n`];
      for (const ev of allEvents.slice(0, 12)) {
        const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const bestOdds = {};
        for (const bm of (ev.bookmakers || [])) {
          for (const mkt of bm.markets) {
            for (const out of mkt.outcomes) {
              if (!bestOdds[out.name] || out.price > bestOdds[out.name].price) {
                bestOdds[out.name] = { price: out.price, bookmaker: bm.title };
              }
            }
          }
        }
        // True prob from Pinnacle
        const pinOdds = getPinnacleOdds(ev.bookmakers || []);
        let probStr = '';
        if (pinOdds) {
          const pinOut = Object.entries(pinOdds).map(([n, p]) => ({ name: n, price: p }));
          const trueProbs = removeVig(pinOut);
          probStr = trueProbs.map(tp => `${(tp.impliedProb * 100).toFixed(0)}%`).join('/');
        }

        lines.push(`*${ev.home_team} vs ${ev.away_team}*`);
        const oddsStr = Object.entries(bestOdds)
          .map(([name, { price, bookmaker }]) => `${name}: *${price.toFixed(2)}* (${bookmaker})`)
          .join(' | ');
        lines.push(`  ${time}${probStr ? ` — true: ${probStr}` : ''}`);
        lines.push(`  ${oddsStr}`);
        lines.push('');
      }

      // --- Part 2: Intelligence summary ---
      const movements = updateOddsCache(allEvents);
      const allValue = [];
      const arbs = [];
      for (const ev of allEvents) {
        const vb = findValueBets(ev);
        for (const v of vb) allValue.push({ ...v, match: `${ev.home_team} vs ${ev.away_team}` });
        const arb = findArbitrage(ev);
        if (arb) arbs.push({ ...arb, match: `${ev.home_team} vs ${ev.away_team}` });
      }

      lines.push('━━━━━━━━━━━━━━━━━━━━━━━');
      lines.push('*BETTING INTELLIGENCE*\n');

      // Arb
      if (arbs.length) {
        lines.push(`*Arbitrage (${arbs.length})*`);
        for (const arb of arbs.slice(0, 3)) {
          lines.push(`  ${arb.match} — *${arb.profit.toFixed(2)}% profit*`);
          for (const [name, { price, bookmaker }] of Object.entries(arb.outcomes)) {
            const stake = ((1 / price) / arb.totalImplied * 100).toFixed(0);
            lines.push(`    ${name}: ${price.toFixed(2)} @ ${bookmaker} (${stake}%)`);
          }
        }
        lines.push('');
      } else {
        lines.push('*Arbitrage:* None found');
      }

      // Value bets
      if (allValue.length) {
        allValue.sort((a, b) => b.edge - a.edge);
        lines.push(`\n*+EV Value Bets (${allValue.length})*`);
        for (const v of allValue.slice(0, 5)) {
          lines.push(`  ${v.match}`);
          lines.push(`    ${v.outcome} @ *${v.odds.toFixed(2)}* (${v.bookmaker}) — edge *${(v.edge * 100).toFixed(1)}%*, EV +$${v.ev}/100`);
        }
        lines.push('');
      } else {
        lines.push('*Value Bets:* No +EV found vs sharp lines');
      }

      // Steam moves
      const steam = movements.filter(m => m.isSteam);
      if (movements.length) {
        lines.push(`\n*Odds Moves (${movements.length}${steam.length ? `, ${steam.length} steam` : ''})*`);
        const top = steam.length ? steam : movements;
        for (const m of top.slice(0, 4)) {
          const arrow = m.direction === 'UP' ? '📈' : '📉';
          lines.push(`  ${arrow} ${m.event} | ${m.outcome}: ${m.oldPrice.toFixed(2)} → *${m.newPrice.toFixed(2)}* (${m.bookmaker})`);
        }
      } else {
        lines.push('\n*Odds Moves:* First scan cached, run again to track');
      }

      // Suggested parlays
      const parlays = buildParlays(allEvents);
      if (parlays.length) recordParlays(parlays);
      if (parlays.length) {
        lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push('*SUGGESTED PARLAYS (€10 stake)*\n');
        for (const p of parlays) {
          lines.push(`${p.emoji} *${p.label}* — ${p.desc}`);
          lines.push(`  Combined odds: *${p.combinedOdds.toFixed(2)}* | Win prob: ${(p.combinedProb * 100).toFixed(1)}%`);
          lines.push(`  Payout: *€${p.payout}* (profit €${p.profit})\n`);
          for (const pick of p.picks) {
            const edgeStr = pick.edge ? ` | edge ${(pick.edge * 100).toFixed(1)}%` : '';
            lines.push(`  • ${pick.match}`);
            lines.push(`    ${pick.pick} @ *${pick.odds.toFixed(2)}* (${pick.bookmaker})${edgeStr}`);
          }
          lines.push('');
        }
      }

      const leagueCount = new Set(allEvents.map(ev => ev.sport_key)).size;
      lines.push(`\n_${allEvents.length} events across ${leagueCount} leagues_`);

      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// /sports — list available sports
bot.onText(/\/sports/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) {
    bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' });
    return;
  }

  fetchSports().then(sports => {
    const active = sports.filter(s => s.active);
    const grouped = {};
    for (const s of active) {
      const group = s.group || 'Other';
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(`\`${s.key}\` — ${s.title}`);
    }
    const lines = ['*Available Sports*\n'];
    for (const [group, items] of Object.entries(grouped).sort()) {
      lines.push(`*${group}:*`);
      lines.push(...items.slice(0, 8));
      if (items.length > 8) lines.push(`  ...and ${items.length - 8} more`);
      lines.push('');
    }
    lines.push('_Use: /odds <sport\\_key>_');
    sendResponse(msg.chat.id, lines.join('\n'));
  }).catch(err => {
    bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
  });
});

// /soccer [today] — today's soccer matches with 1X2, handicap, and over/under odds.
// Fetches h2h + spreads + totals markets in one call and filters to games
// kicking off within the current calendar day (UTC).
bot.onText(/\/soccer/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) {
    bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first. Get one free at the-odds-api.com', { parse_mode: 'Markdown' });
    return;
  }

  bot.sendMessage(msg.chat.id, 'Fetching today\'s soccer matches...').then(async (thinking) => {
    try {
      const url = `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h,spreads,totals&oddsFormat=decimal`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
      const events = await res.json();

      // Filter to games starting today (UTC)
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const todayEnd = new Date(todayStart);
      todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);

      const todayEvents = events.filter(ev => {
        const t = new Date(ev.commence_time);
        return t >= todayStart && t < todayEnd;
      });

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!todayEvents.length) {
        await sendResponse(msg.chat.id, '*Soccer Today*\n\nNo matches found for today.');
        return;
      }

      const lines = [`*Soccer Today — ${todayStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}*\n`];

      for (const ev of todayEvents) {
        const time = new Date(ev.commence_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
        lines.push(`*${ev.home_team} vs ${ev.away_team}*  _(${time} UTC)_`);

        if (!ev.bookmakers?.length) {
          lines.push('  _No odds available_');
          lines.push('');
          continue;
        }

        // Collect best price per market+outcome across all bookmakers
        const best = {}; // key: `${market}|${outcomeName}` -> { price, point? }
        for (const bm of ev.bookmakers) {
          for (const mkt of bm.markets) {
            for (const outcome of mkt.outcomes) {
              const key = `${mkt.key}|${outcome.name}`;
              if (!best[key] || outcome.price > best[key].price) {
                best[key] = { price: outcome.price, point: outcome.point };
              }
            }
          }
        }

        // 1X2
        const home = best[`h2h|${ev.home_team}`];
        const draw = best['h2h|Draw'];
        const away = best[`h2h|${ev.away_team}`];
        if (home && draw && away) {
          lines.push(`  *1X2:* 1 ${home.price.toFixed(2)}  X ${draw.price.toFixed(2)}  2 ${away.price.toFixed(2)}`);
        }

        // Handicap (spreads)
        const hHome = best[`spreads|${ev.home_team}`];
        const hAway = best[`spreads|${ev.away_team}`];
        if (hHome && hAway) {
          const hSign = hHome.point > 0 ? '+' : '';
          const aSign = hAway.point > 0 ? '+' : '';
          lines.push(`  *Handicap:* ${ev.home_team} ${hSign}${hHome.point} @ ${hHome.price.toFixed(2)}  |  ${ev.away_team} ${aSign}${hAway.point} @ ${hAway.price.toFixed(2)}`);
        }

        // Over/Under (totals)
        const over = best['totals|Over'];
        const under = best['totals|Under'];
        if (over && under) {
          lines.push(`  *O/U ${over.point}:* Over ${over.price.toFixed(2)}  |  Under ${under.price.toFixed(2)}`);
        }

        lines.push('');
      }

      lines.push('_Best odds across all bookmakers. Bet responsibly._');
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// /hot — most popular upcoming events (most bookmakers covering them)
bot.onText(/\/hot/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) {
    bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' });
    return;
  }

  bot.sendMessage(msg.chat.id, 'Finding hottest events...').then(async (thinking) => {
    try {
      // Check a few popular sports
      const sportKeys = ['soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_uefa_champs_league', 'basketball_nba', 'icehockey_nhl', 'mma_mixed_martial_arts'];
      const allEvents = [];

      for (const sk of sportKeys) {
        try {
          const events = await fetchOdds(sk);
          for (const ev of events) {
            allEvents.push({ ...ev, sport: sk, bookmakerCount: ev.bookmakers?.length || 0 });
          }
        } catch {}
      }

      // Filter to next 48 hours, then sort by soonest first, then by bookmaker count
      const now = Date.now();
      const cutoff = now + 48 * 60 * 60 * 1000;
      const upcoming = allEvents.filter(ev => {
        const t = new Date(ev.commence_time).getTime();
        return t >= now - 2 * 60 * 60 * 1000 && t <= cutoff; // include live (started up to 2h ago)
      });
      const sorted = (upcoming.length > 0 ? upcoming : allEvents).sort((a, b) => {
        // Soonest first, then by bookmaker count
        const timeDiff = new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime();
        if (Math.abs(timeDiff) < 3600000) return b.bookmakerCount - a.bookmakerCount; // within 1h, sort by popularity
        return timeDiff;
      });
      allEvents.length = 0;
      allEvents.push(...sorted);

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (allEvents.length === 0) {
        bot.sendMessage(msg.chat.id, 'No events found.');
        return;
      }

      const lines = ['*Hottest Events Right Now*\n'];
      for (const ev of allEvents.slice(0, 10)) {
        const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const bestOdds = {};
        for (const bm of (ev.bookmakers || [])) {
          for (const mkt of bm.markets) {
            for (const outcome of mkt.outcomes) {
              if (!bestOdds[outcome.name] || outcome.price > bestOdds[outcome.name]) {
                bestOdds[outcome.name] = outcome.price;
              }
            }
          }
        }
        const oddsStr = Object.entries(bestOdds).map(([n, p]) => `${n}: *${p.toFixed(2)}*`).join(' | ');
        lines.push(`*${ev.home_team} vs ${ev.away_team}*`);
        lines.push(`  ${time} | ${ev.bookmakerCount} bookmakers`);
        if (oddsStr) lines.push(`  ${oddsStr}`);
        lines.push('');
      }

      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// /analyze [sport] — betting analysis summary
bot.onText(/\/analyze\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) {
    bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' });
    return;
  }

  const parts = (match[1] || 'soccer').trim().toLowerCase().split(/\s+/);
  let dayFilter = null;
  let dayLabel = null;
  const last = parts[parts.length - 1];
  if (last === 'today') { dayFilter = 'today'; dayLabel = 'Today'; parts.pop(); }
  else if (last === 'tomorrow') { dayFilter = 'tomorrow'; dayLabel = 'Tomorrow'; parts.pop(); }

  const sport = parts.join(' ') || 'soccer';
  const isSoccer = sport === 'soccer' || sport === 'football';

  bot.sendMessage(msg.chat.id, 'Analyzing betting data...').then(async (thinking) => {
    try {
      let allEvents = [];
      if (isSoccer) {
        // Use generic "soccer" group key — returns ALL leagues in one call (same as /hot)
        const url = `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
        const res = await fetch(url);
        if (res.ok) allEvents = await res.json();
      } else {
        const sportKeys = [SPORT_ALIASES[sport] || sport];
        for (const sk of sportKeys) {
          try {
            const events = await fetchOdds(sk);
            allEvents.push(...events);
          } catch {}
        }
      }

      // Filter by day if specified
      const filtered = filterByDay(allEvents, dayFilter);

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (filtered.length === 0) {
        bot.sendMessage(msg.chat.id, `No ${dayLabel ? dayLabel.toLowerCase() + "'s " : ''}${sport} events found.`);
        return;
      }

      // Analyze each event
      const analyzed = filtered.map(ev => {
        const bmCount = ev.bookmakers?.length || 0;
        const outcomes = {};
        const allOdds = {};

        for (const bm of (ev.bookmakers || [])) {
          for (const mkt of bm.markets) {
            for (const out of mkt.outcomes) {
              if (!allOdds[out.name]) allOdds[out.name] = [];
              allOdds[out.name].push(out.price);
              if (!outcomes[out.name] || out.price > outcomes[out.name].best) {
                outcomes[out.name] = { best: out.price, worst: outcomes[out.name]?.worst || out.price, bm: bm.title };
              }
              if (outcomes[out.name] && out.price < outcomes[out.name].worst) {
                outcomes[out.name].worst = out.price;
              }
            }
          }
        }

        // Find biggest favorite (lowest odds)
        let biggestFav = null;
        let lowestOdds = 999;
        for (const [name, odds] of Object.entries(allOdds)) {
          const avg = odds.reduce((a, b) => a + b, 0) / odds.length;
          if (avg < lowestOdds) { lowestOdds = avg; biggestFav = name; }
        }

        // Odds spread (difference between best and worst = movement indicator)
        let maxSpread = 0;
        let spreadOutcome = '';
        for (const [name, info] of Object.entries(outcomes)) {
          const spread = info.best - info.worst;
          if (spread > maxSpread) { maxSpread = spread; spreadOutcome = name; }
        }

        // Implied probability for favorite
        const impliedProb = lowestOdds > 0 ? (1 / lowestOdds * 100) : 0;

        return {
          home: ev.home_team, away: ev.away_team,
          time: ev.commence_time, bmCount,
          favorite: biggestFav, favOdds: lowestOdds, impliedProb,
          maxSpread, spreadOutcome, outcomes,
        };
      });

      // Sort by popularity (bookmaker count)
      analyzed.sort((a, b) => b.bmCount - a.bmCount);

      const header = dayLabel ? `${sport} — ${dayLabel}` : sport;
      const lines = [`*Betting Analysis — ${header}*\n`];

      // Most covered events
      lines.push('*Most Popular (most bookmakers):*');
      for (const ev of analyzed.slice(0, 5)) {
        const time = new Date(ev.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        lines.push(`  *${ev.home} vs ${ev.away}* — ${ev.bmCount} bookmakers`);
        lines.push(`  ${time}`);
      }

      // Biggest favorites
      lines.push('\n*Biggest Favorites (highest implied probability):*');
      const byProb = [...analyzed].sort((a, b) => b.impliedProb - a.impliedProb);
      for (const ev of byProb.slice(0, 5)) {
        lines.push(`  *${ev.favorite}* — ${ev.impliedProb.toFixed(0)}% implied (odds ${ev.favOdds.toFixed(2)})`);
        lines.push(`  ${ev.home} vs ${ev.away}`);
      }

      // Biggest upsets potential (highest underdog odds)
      lines.push('\n*Best Value Underdogs (highest odds):*');
      const underdogs = analyzed.map(ev => {
        let maxOdds = 0; let underdogName = '';
        for (const [name, info] of Object.entries(ev.outcomes)) {
          if (info.best > maxOdds) { maxOdds = info.best; underdogName = name; }
        }
        return { ...ev, underdogName, underdogOdds: maxOdds };
      }).sort((a, b) => b.underdogOdds - a.underdogOdds);
      for (const ev of underdogs.slice(0, 5)) {
        lines.push(`  *${ev.underdogName}* — ${ev.underdogOdds.toFixed(2)} odds`);
        lines.push(`  ${ev.home} vs ${ev.away}`);
      }

      // Biggest odds spread (most movement)
      lines.push('\n*Biggest Odds Movement (disagreement between bookmakers):*');
      const bySpread = [...analyzed].sort((a, b) => b.maxSpread - a.maxSpread);
      for (const ev of bySpread.slice(0, 5)) {
        if (ev.maxSpread < 0.05) continue;
        lines.push(`  *${ev.spreadOutcome}* — spread: ${ev.maxSpread.toFixed(2)}`);
        lines.push(`  ${ev.home} vs ${ev.away}`);
      }

      const leagueCount = new Set(filtered.map(ev => ev.sport_key)).size;
      lines.push(`\n_${filtered.length} events analyzed across ${leagueCount} leagues_`);

      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// --- Workflow Pipelines ---
const WORKFLOWS = {
  ship: {
    name: 'Ship Feature',
    steps: [
      { label: 'Planning', prompt: (desc) => `Plan the implementation for: ${desc}. List the files to create/modify, the approach, and any edge cases. Do NOT write code yet.` },
      { label: 'Coding', prompt: (desc) => `Now implement the feature based on the plan above. Write clean, production-ready code.` },
      { label: 'Testing', prompt: (desc) => `Write tests for the code you just created. Cover happy paths and edge cases.` },
      { label: 'Docs', prompt: (desc) => `Add inline documentation and update any relevant docs for the changes you made.` },
      { label: 'Commit', prompt: (desc) => `Suggest a git commit message for all the changes. Format: type(scope): description. Do NOT actually commit.` },
    ],
  },
  fix: {
    name: 'Bug Fix',
    steps: [
      { label: 'Investigate', prompt: (desc) => `Investigate this bug: ${desc}. Read relevant code, identify the root cause. Do NOT fix yet.` },
      { label: 'Fix', prompt: (desc) => `Now fix the bug based on your investigation above. Make minimal, targeted changes.` },
      { label: 'Test', prompt: (desc) => `Write a test that reproduces the bug and verifies your fix works.` },
      { label: 'Commit', prompt: (desc) => `Suggest a git commit message for the bug fix. Format: fix(scope): description. Do NOT actually commit.` },
    ],
  },
  refactor: {
    name: 'Refactor',
    steps: [
      { label: 'Analyze', prompt: (desc) => `Analyze this code for refactoring: ${desc}. Identify code smells, duplication, and improvement opportunities. Do NOT change code yet.` },
      { label: 'Refactor', prompt: (desc) => `Now refactor the code based on your analysis. Keep behavior identical.` },
      { label: 'Verify', prompt: (desc) => `Run any existing tests or verify the refactored code still works correctly.` },
      { label: 'Commit', prompt: (desc) => `Suggest a git commit message for the refactor. Format: refactor(scope): description. Do NOT actually commit.` },
    ],
  },
  review: {
    name: 'Code Review',
    steps: [
      { label: 'Read', prompt: (desc) => `Read and analyze this code: ${desc}. Understand what it does.` },
      { label: 'Review', prompt: (desc) => `Provide a detailed code review. Check for bugs, security issues, performance, readability, and best practices.` },
      { label: 'Suggestions', prompt: (desc) => `List specific, actionable improvements with code examples for the most important issues found.` },
    ],
  },
};

async function runWorkflow(chatId, workflowName, description, originalMsgId) {
  const workflow = WORKFLOWS[workflowName];
  if (!workflow) return;

  let cancelled = false;

  const statusMsg = await bot.sendMessage(chatId,
    `*${workflow.name} Pipeline*\n\n` +
    workflow.steps.map((s, i) => `${i === 0 ? '▶️' : '⏸️'} ${s.label}`).join('\n'),
    { parse_mode: 'Markdown', reply_to_message_id: originalMsgId }
  );

  const beforeState = captureWorkingTreeState();

  for (let i = 0; i < workflow.steps.length; i++) {
    if (cancelled) break;
    const step = workflow.steps[i];

    // Update status message
    const statusLines = workflow.steps.map((s, j) => {
      if (j < i) return `✅ ${s.label}`;
      if (j === i) return `▶️ ${s.label}...`;
      return `⏸️ ${s.label}`;
    });
    await bot.editMessageText(
      `*${workflow.name} Pipeline*\n\n${statusLines.join('\n')}`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});

    console.log(`[workflow] ${workflowName} step ${i + 1}/${workflow.steps.length}: ${step.label}`);

    try {
      const response = await runClaude(step.prompt(description), chatId);
      console.log(`[workflow] ${step.label} done, response length: ${response.length}`);
      await sendResponse(chatId, `*${step.label}:*\n\n${response}`, originalMsgId);
    } catch (err) {
      console.log(`[workflow] ${step.label} error: ${err.message}`);
      await bot.sendMessage(chatId, `Error in ${step.label}: ${err.message}`, { reply_to_message_id: originalMsgId });
      cancelled = true;
      break;
    }
  }

  // Final status
  const finalLines = workflow.steps.map(s => `✅ ${s.label}`);
  await bot.editMessageText(
    `*${workflow.name} Pipeline — Complete*\n\n${finalLines.join('\n')}`,
    { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
  ).catch(() => {});

  // Detect and show changes
  const changes = detectClaudeChanges(beforeState);
  if (changes.hasChanges) {
    const fileList = [
      ...changes.claudeChangedFiles.map(f => `📝 ${f}`),
      ...changes.newFiles.map(f => `➕ ${f}`),
    ].join('\n');

    let diffText = changes.diffText;
    const MAX_DIFF = 3500;
    if (diffText.length > MAX_DIFF) diffText = diffText.slice(0, MAX_DIFF) + '\n... (truncated)';

    pendingChanges.set(chatId, changes);

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Apply', callback_data: `apply:${chatId}` },
        { text: '❌ Revert', callback_data: `revert:${chatId}` },
      ]],
    };

    try {
      await bot.sendMessage(chatId, `*Changed files:*\n${fileList}\n\n\`\`\`diff\n${diffText}\n\`\`\``, {
        parse_mode: 'Markdown', reply_to_message_id: originalMsgId, reply_markup: keyboard,
      });
    } catch {
      await bot.sendMessage(chatId, `Changed files:\n${fileList}\n\n${diffText}`, {
        reply_to_message_id: originalMsgId, reply_markup: keyboard,
      });
    }
  }
}

// /ship <description>
bot.onText(/\/ship\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, 'Already processing. Use /stop to cancel.');
    return;
  }
  runWorkflow(msg.chat.id, 'ship', match[1].trim(), msg.message_id);
});

// /fix <description>
bot.onText(/\/fix\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, 'Already processing. Use /stop to cancel.');
    return;
  }
  runWorkflow(msg.chat.id, 'fix', match[1].trim(), msg.message_id);
});

// /refactor <description>
bot.onText(/\/refactor\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, 'Already processing. Use /stop to cancel.');
    return;
  }
  runWorkflow(msg.chat.id, 'refactor', match[1].trim(), msg.message_id);
});

// /review <description>
bot.onText(/\/review\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, 'Already processing. Use /stop to cancel.');
    return;
  }
  runWorkflow(msg.chat.id, 'review', match[1].trim(), msg.message_id);
});

// /workflows — list available workflows
bot.onText(/\/workflows/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const lines = ['*Available Workflows:*\n'];
  for (const [cmd, wf] of Object.entries(WORKFLOWS)) {
    lines.push(`/${cmd} <description> — ${wf.name} (${wf.steps.length} steps: ${wf.steps.map(s => s.label).join(' → ')})`);
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

// --- Bankroll Tracker ---
function loadBankroll() { try { return JSON.parse(fs.readFileSync(BANKROLL_FILE, 'utf8')); } catch { return {}; } }
function saveBankroll(data) { fs.writeFileSync(BANKROLL_FILE, JSON.stringify(data, null, 2)); }

function getUserBankroll(chatId) {
  const data = loadBankroll();
  if (!data[chatId]) data[chatId] = { balance: 0, bets: [], startBalance: 0 };
  return data[chatId];
}

function saveUserBankroll(chatId, bankroll) {
  const data = loadBankroll();
  data[chatId] = bankroll;
  saveBankroll(data);
}

// /bankroll — show bankroll stats
bot.onText(/\/bankroll$/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const br = getUserBankroll(msg.chat.id);
  if (!br.bets.length) {
    bot.sendMessage(msg.chat.id, '*Bankroll Tracker*\n\nNo bets recorded yet.\n\n`/bet <stake> <odds> <team/match>` — record a bet\n`/betwin <id>` — mark bet as won\n`/betloss <id>` — mark bet as lost\n`/setbank <amount>` — set starting bankroll', { parse_mode: 'Markdown' });
    return;
  }
  const won = br.bets.filter(b => b.result === 'win');
  const lost = br.bets.filter(b => b.result === 'loss');
  const pending = br.bets.filter(b => !b.result);
  const totalStaked = br.bets.reduce((s, b) => s + b.stake, 0);
  const totalReturn = won.reduce((s, b) => s + (b.stake * b.odds), 0);
  const profit = totalReturn - totalStaked + lost.reduce((s, b) => s + 0, 0) + pending.reduce((s, b) => s + b.stake, 0);
  const netProfit = totalReturn - (won.length + lost.length > 0 ? (won.reduce((s, b) => s + b.stake, 0) + lost.reduce((s, b) => s + b.stake, 0)) : 0);
  const roi = totalStaked > 0 ? (netProfit / totalStaked * 100) : 0;
  const winRate = (won.length + lost.length) > 0 ? (won.length / (won.length + lost.length) * 100) : 0;
  const avgOdds = br.bets.length > 0 ? br.bets.reduce((s, b) => s + b.odds, 0) / br.bets.length : 0;

  const lines = ['*Bankroll Tracker*\n'];
  if (br.startBalance) lines.push(`Starting: €${br.startBalance.toFixed(2)}`);
  lines.push(`Current: *€${(br.startBalance + netProfit).toFixed(2)}*`);
  lines.push(`Net P/L: *${netProfit >= 0 ? '+' : ''}€${netProfit.toFixed(2)}*`);
  lines.push(`ROI: *${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%*`);
  lines.push(`\nWin rate: ${winRate.toFixed(0)}% (${won.length}W / ${lost.length}L)`);
  lines.push(`Total staked: €${totalStaked.toFixed(2)}`);
  lines.push(`Avg odds: ${avgOdds.toFixed(2)}`);
  if (pending.length) {
    lines.push(`\n*Pending (${pending.length}):*`);
    for (const b of pending.slice(-5)) {
      lines.push(`  #${b.id} — €${b.stake} @ ${b.odds.toFixed(2)} — ${b.desc}`);
    }
  }
  // Last 5 settled
  const settled = br.bets.filter(b => b.result).slice(-5);
  if (settled.length) {
    lines.push(`\n*Recent:*`);
    for (const b of settled.reverse()) {
      const icon = b.result === 'win' ? '✅' : '❌';
      const pnl = b.result === 'win' ? `+€${(b.stake * b.odds - b.stake).toFixed(2)}` : `-€${b.stake.toFixed(2)}`;
      lines.push(`  ${icon} #${b.id} — ${b.desc} (${pnl})`);
    }
  }
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// /setbank <amount>
bot.onText(/\/setbank\s+(\d+(?:\.\d+)?)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const br = getUserBankroll(msg.chat.id);
  br.startBalance = parseFloat(match[1]);
  saveUserBankroll(msg.chat.id, br);
  bot.sendMessage(msg.chat.id, `Starting bankroll set to *€${br.startBalance.toFixed(2)}*`, { parse_mode: 'Markdown' });
});

// /bet <stake> <odds> <description>
bot.onText(/\/bet\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const br = getUserBankroll(msg.chat.id);
  const bet = {
    id: br.bets.length + 1,
    stake: parseFloat(match[1]),
    odds: parseFloat(match[2]),
    desc: match[3].trim(),
    date: new Date().toISOString(),
    result: null,
  };
  br.bets.push(bet);
  saveUserBankroll(msg.chat.id, br);
  const potWin = (bet.stake * bet.odds).toFixed(2);
  bot.sendMessage(msg.chat.id, `Bet #${bet.id} recorded\n€${bet.stake} @ ${bet.odds.toFixed(2)} on *${bet.desc}*\nPotential win: *€${potWin}*`, { parse_mode: 'Markdown' });
});

// /betwin <id>
bot.onText(/\/betwin\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const br = getUserBankroll(msg.chat.id);
  const bet = br.bets.find(b => b.id === parseInt(match[1]));
  if (!bet) { bot.sendMessage(msg.chat.id, 'Bet not found.'); return; }
  bet.result = 'win';
  bet.settledAt = new Date().toISOString();
  saveUserBankroll(msg.chat.id, br);
  const profit = (bet.stake * bet.odds - bet.stake).toFixed(2);
  bot.sendMessage(msg.chat.id, `✅ Bet #${bet.id} won! Profit: *+€${profit}*`, { parse_mode: 'Markdown' });
});

// /betloss <id>
bot.onText(/\/betloss\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const br = getUserBankroll(msg.chat.id);
  const bet = br.bets.find(b => b.id === parseInt(match[1]));
  if (!bet) { bot.sendMessage(msg.chat.id, 'Bet not found.'); return; }
  bet.result = 'loss';
  bet.settledAt = new Date().toISOString();
  saveUserBankroll(msg.chat.id, br);
  bot.sendMessage(msg.chat.id, `❌ Bet #${bet.id} lost. -€${bet.stake.toFixed(2)}`, { parse_mode: 'Markdown' });
});

// --- Kelly Criterion ---
// /kelly <your_prob> <odds> [bankroll]
bot.onText(/\/kelly\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*(\d+(?:\.\d+)?)?/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const prob = parseFloat(match[1]) > 1 ? parseFloat(match[1]) / 100 : parseFloat(match[1]);
  const odds = parseFloat(match[2]);
  const bankrollAmt = match[3] ? parseFloat(match[3]) : getUserBankroll(msg.chat.id).startBalance || 100;

  const b = odds - 1; // net odds (decimal odds - 1)
  const q = 1 - prob;
  const kelly = (b * prob - q) / b;
  const halfKelly = kelly / 2;
  const quarterKelly = kelly / 4;

  if (kelly <= 0) {
    bot.sendMessage(msg.chat.id, `*Kelly says: NO BET*\n\nEdge is negative at ${(prob * 100).toFixed(1)}% prob / ${odds.toFixed(2)} odds.\nExpected value is negative.`, { parse_mode: 'Markdown' });
    return;
  }

  const lines = ['*Kelly Criterion*\n'];
  lines.push(`Probability: *${(prob * 100).toFixed(1)}%*`);
  lines.push(`Odds: *${odds.toFixed(2)}*`);
  lines.push(`Bankroll: €${bankrollAmt.toFixed(2)}\n`);
  lines.push(`Full Kelly: *${(kelly * 100).toFixed(1)}%* — €${(kelly * bankrollAmt).toFixed(2)}`);
  lines.push(`Half Kelly: *${(halfKelly * 100).toFixed(1)}%* — €${(halfKelly * bankrollAmt).toFixed(2)} (recommended)`);
  lines.push(`Quarter Kelly: *${(quarterKelly * 100).toFixed(1)}%* — €${(quarterKelly * bankrollAmt).toFixed(2)} (conservative)`);
  lines.push(`\nExpected value: *+${((prob * b - q) * 100).toFixed(1)}%* per bet`);
  lines.push(`\n_Half Kelly is recommended — same long-term growth with 75% less variance_`);
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// --- Compare: side-by-side bookmaker odds for one match ---
// /compare <team name or partial>
bot.onText(/\/compare\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }
  const query = match[1].trim().toLowerCase();

  bot.sendMessage(msg.chat.id, `Searching for "${match[1].trim()}"...`).then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const found = events.find(ev =>
        ev.home_team.toLowerCase().includes(query) ||
        ev.away_team.toLowerCase().includes(query) ||
        `${ev.home_team} vs ${ev.away_team}`.toLowerCase().includes(query)
      );
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!found) {
        bot.sendMessage(msg.chat.id, `No match found for "${match[1].trim()}". Try a team name.`);
        return;
      }

      const time = new Date(found.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const lines = [`*${found.home_team} vs ${found.away_team}*\n${time}\n`];

      // Get Pinnacle true probs
      const pinOdds = getPinnacleOdds(found.bookmakers || []);
      if (pinOdds) {
        const pinOut = Object.entries(pinOdds).map(([n, p]) => ({ name: n, price: p }));
        const trueProbs = removeVig(pinOut);
        lines.push('*True probabilities (no-vig):*');
        for (const tp of trueProbs) {
          lines.push(`  ${tp.name}: *${(tp.impliedProb * 100).toFixed(1)}%*`);
        }
        lines.push('');
      }

      // Collect all outcomes
      const outcomeNames = new Set();
      for (const bm of (found.bookmakers || [])) {
        for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
          for (const out of mkt.outcomes) outcomeNames.add(out.name);
        }
      }

      // Best odds per outcome
      const best = {};
      for (const name of outcomeNames) {
        for (const bm of found.bookmakers) {
          for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
            const out = mkt.outcomes.find(o => o.name === name);
            if (out && (!best[name] || out.price > best[name])) best[name] = out.price;
          }
        }
      }

      lines.push('*Bookmaker Comparison:*');
      // Header
      const names = [...outcomeNames];
      lines.push(`${'Bookmaker'.padEnd(20)} ${names.map(n => n.substring(0, 12).padEnd(12)).join(' ')}`);
      lines.push('─'.repeat(20 + names.length * 13));

      for (const bm of (found.bookmakers || []).slice(0, 15)) {
        const h2h = bm.markets.find(m => m.key === 'h2h');
        if (!h2h) continue;
        const isSharp = SHARP_BOOKS.includes(bm.title);
        const prefix = isSharp ? '★ ' : '  ';
        const cols = names.map(name => {
          const out = h2h.outcomes.find(o => o.name === name);
          if (!out) return '  -'.padEnd(12);
          const isBest = out.price === best[name];
          return isBest ? `*${out.price.toFixed(2)}*`.padEnd(12) : `${out.price.toFixed(2)}`.padEnd(12);
        });
        lines.push(`\`${prefix}${bm.title.substring(0, 17).padEnd(18)}\` ${cols.join(' ')}`);
      }

      lines.push(`\n_★ = sharp bookmaker | *bold* = best odds_`);
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// --- Live Scores + Odds ---
// /live — show in-play and about-to-start matches
bot.onText(/\/live/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }

  bot.sendMessage(msg.chat.id, 'Fetching live matches...').then(async (thinking) => {
    try {
      // Fetch scores for live events
      const scoresUrl = `${ODDS_BASE}/sports/soccer/scores/?apiKey=${ODDS_API_KEY}&daysFrom=1`;
      const scoresRes = await fetch(scoresUrl);
      let scores = [];
      if (scoresRes.ok) scores = await scoresRes.json();

      // Also fetch odds for context
      const events = await fetchAllSoccer();
      const now = Date.now();

      // Live = already started (commenced) or starting within 30 min
      const liveAndSoon = events.filter(ev => {
        const start = new Date(ev.commence_time).getTime();
        return start <= now + 30 * 60 * 1000; // started or within 30 min
      }).sort((a, b) => new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime());

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!liveAndSoon.length) {
        bot.sendMessage(msg.chat.id, 'No live or imminent matches right now.');
        return;
      }

      const lines = ['*Live & Starting Soon*\n'];
      for (const ev of liveAndSoon.slice(0, 15)) {
        const start = new Date(ev.commence_time).getTime();
        const isLive = start <= now;
        const score = scores.find(s => s.id === ev.id);
        const minsAgo = Math.floor((now - start) / 60000);

        let status = '';
        if (isLive && score?.scores) {
          const home = score.scores.find(s => s.name === ev.home_team)?.score || '?';
          const away = score.scores.find(s => s.name === ev.away_team)?.score || '?';
          status = `LIVE ${minsAgo}' — ${home}:${away}`;
        } else if (isLive) {
          status = `LIVE ${minsAgo}'`;
        } else {
          const minsTo = Math.floor((start - now) / 60000);
          status = `Starts in ${minsTo}min`;
        }

        // Best odds
        const bestOdds = {};
        for (const bm of (ev.bookmakers || [])) {
          for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
            for (const out of mkt.outcomes) {
              if (!bestOdds[out.name] || out.price > bestOdds[out.name]) bestOdds[out.name] = out.price;
            }
          }
        }
        const oddsStr = Object.entries(bestOdds).map(([n, p]) => `${n}: ${p.toFixed(2)}`).join(' | ');

        lines.push(`${isLive ? '🔴' : '🟡'} *${ev.home_team} vs ${ev.away_team}*`);
        lines.push(`  ${status}`);
        if (oddsStr) lines.push(`  ${oddsStr}`);
        lines.push('');
      }
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// --- Alerts System ---
function loadAlerts() { try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch { return {}; } }
function saveAlerts(data) { fs.writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2)); }

// /alert <team> — get notified when odds change for this team
bot.onText(/\/alert\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const query = match[1].trim().toLowerCase();

  if (query === 'list') {
    const alerts = loadAlerts();
    const userAlerts = alerts[msg.chat.id] || [];
    if (!userAlerts.length) { bot.sendMessage(msg.chat.id, 'No active alerts. Use `/alert <team>` to add one.', { parse_mode: 'Markdown' }); return; }
    const lines = ['*Active Alerts:*\n'];
    for (const a of userAlerts) {
      lines.push(`  #${a.id} — ${a.query} (set ${new Date(a.created).toLocaleDateString('en-GB')})`);
    }
    lines.push('\n_Use /alertdel <id> to remove_');
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  const alerts = loadAlerts();
  if (!alerts[msg.chat.id]) alerts[msg.chat.id] = [];
  const id = alerts[msg.chat.id].length + 1;
  alerts[msg.chat.id].push({ id, query, created: new Date().toISOString(), lastOdds: null });
  saveAlerts(alerts);
  bot.sendMessage(msg.chat.id, `Alert #${id} set for *${match[1].trim()}*\nYou'll be notified when odds move significantly.`, { parse_mode: 'Markdown' });
});

// /alertdel <id>
bot.onText(/\/alertdel\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const alerts = loadAlerts();
  const userAlerts = alerts[msg.chat.id] || [];
  const idx = userAlerts.findIndex(a => a.id === parseInt(match[1]));
  if (idx === -1) { bot.sendMessage(msg.chat.id, 'Alert not found.'); return; }
  userAlerts.splice(idx, 1);
  alerts[msg.chat.id] = userAlerts;
  saveAlerts(alerts);
  bot.sendMessage(msg.chat.id, `Alert #${match[1]} removed.`);
});

// Alert checker — runs every 5 minutes
async function checkAlerts() {
  if (!ODDS_API_KEY) return;
  const alerts = loadAlerts();
  let events = null; // lazy fetch

  for (const [chatId, userAlerts] of Object.entries(alerts)) {
    for (const alert of userAlerts) {
      try {
        if (!events) events = await fetchAllSoccer();
        const found = events.find(ev =>
          ev.home_team.toLowerCase().includes(alert.query) ||
          ev.away_team.toLowerCase().includes(alert.query)
        );
        if (!found) continue;

        // Get current best odds
        const current = {};
        for (const bm of (found.bookmakers || [])) {
          for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
            for (const out of mkt.outcomes) {
              if (!current[out.name] || out.price > current[out.name]) current[out.name] = out.price;
            }
          }
        }

        // Compare with last check
        if (alert.lastOdds) {
          const changes = [];
          for (const [name, price] of Object.entries(current)) {
            const prev = alert.lastOdds[name];
            if (prev && Math.abs(price - prev) >= 0.10) {
              const arrow = price > prev ? '📈' : '📉';
              changes.push(`${arrow} ${name}: ${prev.toFixed(2)} → *${price.toFixed(2)}*`);
            }
          }
          if (changes.length) {
            const time = new Date(found.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            bot.sendMessage(parseInt(chatId),
              `*ODDS ALERT: ${found.home_team} vs ${found.away_team}*\n${time}\n\n${changes.join('\n')}`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          }
        }

        alert.lastOdds = current;
      } catch {}
    }
  }
  saveAlerts(alerts);
}

setInterval(checkAlerts, 5 * 60 * 1000); // every 5 minutes

// --- Parlay History Tracking ---
function loadHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return { parlays: [] }; } }
function saveHistory(data) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2)); }

// Save suggested parlays for tracking (called from /odds)
function recordParlays(parlays) {
  const history = loadHistory();
  for (const p of parlays) {
    history.parlays.push({
      type: p.type,
      date: new Date().toISOString(),
      picks: p.picks.map(pk => ({
        match: pk.match,
        pick: pk.pick,
        odds: pk.odds,
      })),
      combinedOdds: p.combinedOdds,
      stake: 10,
      result: null, // will be updated when settled
    });
  }
  // Keep last 100
  if (history.parlays.length > 100) history.parlays = history.parlays.slice(-100);
  saveHistory(history);
}

// /history — show parlay suggestion track record
bot.onText(/\/history/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const history = loadHistory();
  if (!history.parlays.length) {
    bot.sendMessage(msg.chat.id, 'No parlay history yet. Run `/odds soccer today` to generate suggestions.', { parse_mode: 'Markdown' });
    return;
  }

  const won = history.parlays.filter(p => p.result === 'win');
  const lost = history.parlays.filter(p => p.result === 'loss');
  const pending = history.parlays.filter(p => !p.result);
  const totalStaked = (won.length + lost.length) * 10;
  const totalReturn = won.reduce((s, p) => s + p.combinedOdds * 10, 0);
  const roi = totalStaked > 0 ? ((totalReturn - totalStaked) / totalStaked * 100) : 0;

  const lines = ['*Parlay Suggestion History*\n'];
  lines.push(`Total: ${history.parlays.length} suggestions`);
  lines.push(`Settled: ${won.length}W / ${lost.length}L`);
  lines.push(`Pending: ${pending.length}`);
  if (totalStaked > 0) {
    lines.push(`ROI: *${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%*`);
    lines.push(`P/L: *${totalReturn - totalStaked >= 0 ? '+' : ''}€${(totalReturn - totalStaked).toFixed(2)}*`);
  }

  // Recent
  const recent = history.parlays.slice(-5).reverse();
  lines.push('\n*Recent:*');
  for (const p of recent) {
    const date = new Date(p.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const icon = p.result === 'win' ? '✅' : p.result === 'loss' ? '❌' : '⏳';
    lines.push(`  ${icon} ${p.type} — ${p.combinedOdds.toFixed(2)}x — ${date}`);
    for (const pk of p.picks) lines.push(`    ${pk.pick} (${pk.match})`);
  }
  lines.push('\n_Use `/parlaywin <n>` or `/parlayloss <n>` to update results (n = count from recent)_');
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// /parlaywin <n> and /parlayloss <n> — mark recent parlays
bot.onText(/\/parlay(win|loss)\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const result = match[1];
  const n = parseInt(match[2]);
  const history = loadHistory();
  const pending = history.parlays.filter(p => !p.result);
  if (n < 1 || n > pending.length) {
    bot.sendMessage(msg.chat.id, `Invalid. ${pending.length} pending parlays.`);
    return;
  }
  pending[n - 1].result = result === 'win' ? 'win' : 'loss';
  saveHistory(history);
  const icon = result === 'win' ? '✅' : '❌';
  bot.sendMessage(msg.chat.id, `${icon} Parlay marked as ${result}.`);
});

// --- Daily Betting Digest ---
let lastDigestDate = '';
async function sendDailyDigest() {
  if (!ODDS_API_KEY) return;
  try {
    const events = await fetchAllSoccer();
    const today = filterByDay(events, 'today');
    if (!today.length) return;

    // Build intelligence
    const allValue = [];
    const arbs = [];
    for (const ev of today) {
      const vb = findValueBets(ev);
      for (const v of vb) allValue.push({ ...v, match: `${ev.home_team} vs ${ev.away_team}` });
      const arb = findArbitrage(ev);
      if (arb) arbs.push({ ...arb, match: `${ev.home_team} vs ${ev.away_team}` });
    }
    const parlays = buildParlays(today);
    updateOddsCache(today);

    // Record parlays for tracking
    if (parlays.length) recordParlays(parlays);

    const lines = ['*Daily Betting Digest*\n'];
    lines.push(`${today.length} soccer events today\n`);

    if (arbs.length) {
      lines.push(`*Arbitrage (${arbs.length}):*`);
      for (const arb of arbs.slice(0, 2)) {
        lines.push(`  ${arb.match} — *${arb.profit.toFixed(2)}%*`);
      }
      lines.push('');
    }

    if (allValue.length) {
      allValue.sort((a, b) => b.edge - a.edge);
      lines.push(`*Top Value Bets (${allValue.length}):*`);
      for (const v of allValue.slice(0, 3)) {
        lines.push(`  ${v.match} — ${v.outcome} @ ${v.odds.toFixed(2)} (${(v.edge * 100).toFixed(1)}% edge)`);
      }
      lines.push('');
    }

    if (parlays.length) {
      lines.push('*Suggested Parlays (€10):*');
      for (const p of parlays) {
        lines.push(`${p.emoji} *${p.label}* — ${p.combinedOdds.toFixed(2)}x → €${p.payout}`);
        for (const pk of p.picks) lines.push(`  • ${pk.pick} (${pk.match})`);
        lines.push('');
      }
    }

    lines.push('_Use /odds soccer today for full breakdown_');

    // Send to all users who have used the bot
    for (const chatId of claudeSessions.keys()) {
      bot.sendMessage(parseInt(chatId), lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (err) {
    console.log('[digest] Error:', err.message);
  }
}

// Check for digest time
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() === DIGEST_HOUR && now.getMinutes() === 0 && lastDigestDate !== today) {
    lastDigestDate = today;
    sendDailyDigest();
  }
}, 60_000);

// /digest — manually trigger daily digest
bot.onText(/\/digest/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  sendDailyDigest();
});

// --- Multi-sport Parlay ---
// /parlay <sport1> <sport2> ... — build cross-sport accumulator
bot.onText(/\/parlay\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }

  const sports = match[1].trim().toLowerCase().split(/[\s,]+/);

  bot.sendMessage(msg.chat.id, `Building multi-sport parlay (${sports.join(', ')})...`).then(async (thinking) => {
    try {
      const allEvents = [];
      for (const sport of sports) {
        try {
          if (sport === 'soccer' || sport === 'football') {
            const events = await fetchAllSoccer();
            const today = filterByDay(events, 'today');
            allEvents.push(...today.map(ev => ({ ...ev, sportLabel: 'Soccer' })));
          } else {
            const key = SPORT_ALIASES[sport] || sport;
            const events = await fetchOdds(key);
            const today = filterByDay(events, 'today');
            allEvents.push(...today.map(ev => ({ ...ev, sportLabel: sport.toUpperCase() })));
          }
        } catch {}
      }

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (allEvents.length < 2) {
        bot.sendMessage(msg.chat.id, 'Not enough events to build a multi-sport parlay. Try: `/parlay soccer nba`', { parse_mode: 'Markdown' });
        return;
      }

      // Pick best favorite from each sport
      const bySport = {};
      for (const ev of allEvents) {
        if (!bySport[ev.sportLabel]) bySport[ev.sportLabel] = [];
        const pinOdds = getPinnacleOdds(ev.bookmakers || []);
        const bestOdds = {};
        for (const bm of (ev.bookmakers || [])) {
          for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
            for (const out of mkt.outcomes) {
              if (out.name === 'Draw') continue;
              if (!bestOdds[out.name] || out.price > bestOdds[out.name].price) {
                bestOdds[out.name] = { price: out.price, bookmaker: bm.title };
              }
            }
          }
        }
        let trueProbs = null;
        if (pinOdds) {
          const po = Object.entries(pinOdds).map(([n, p]) => ({ name: n, price: p }));
          trueProbs = Object.fromEntries(removeVig(po).map(o => [o.name, o.impliedProb]));
        }
        // Find favorite
        let fav = null, favProb = 0;
        for (const [name, info] of Object.entries(bestOdds)) {
          const prob = trueProbs?.[name] || (1 / info.price);
          if (prob > favProb) { favProb = prob; fav = { name, ...info, prob, match: `${ev.home_team} vs ${ev.away_team}` }; }
        }
        if (fav && fav.prob >= 0.45) bySport[ev.sportLabel].push(fav);
      }

      // Pick top 1-2 from each sport
      const picks = [];
      for (const [sport, favs] of Object.entries(bySport)) {
        favs.sort((a, b) => b.prob - a.prob);
        picks.push(...favs.slice(0, 2));
      }

      if (picks.length < 2) {
        bot.sendMessage(msg.chat.id, 'Not enough strong picks for a multi-sport parlay.');
        return;
      }

      const combinedOdds = picks.reduce((acc, p) => acc * p.price, 1);
      const combinedProb = picks.reduce((acc, p) => acc * p.prob, 1);
      const payout = (10 * combinedOdds).toFixed(2);

      const lines = ['*Multi-Sport Parlay (€10)*\n'];
      lines.push(`Combined odds: *${combinedOdds.toFixed(2)}*`);
      lines.push(`Win prob: *${(combinedProb * 100).toFixed(1)}%*`);
      lines.push(`Payout: *€${payout}*\n`);
      for (const p of picks) {
        lines.push(`  • ${p.match}`);
        lines.push(`    ${p.name} @ *${p.price.toFixed(2)}* (${p.bookmaker}) — ${(p.prob * 100).toFixed(0)}%`);
      }
      lines.push('\n_Picks: strongest favorites from each sport_');
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// --- Telegram Inline Mode ---
bot.on('inline_query', async (query) => {
  const text = (query.query || '').trim().toLowerCase();
  if (!ODDS_API_KEY) return;

  try {
    const events = await fetchAllSoccer();
    let filtered = filterByDay(events, 'today');
    if (text) {
      filtered = filtered.filter(ev =>
        ev.home_team.toLowerCase().includes(text) ||
        ev.away_team.toLowerCase().includes(text)
      );
    }

    const results = filtered.slice(0, 10).map((ev, i) => {
      const bestOdds = {};
      for (const bm of (ev.bookmakers || [])) {
        for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
          for (const out of mkt.outcomes) {
            if (!bestOdds[out.name] || out.price > bestOdds[out.name]) bestOdds[out.name] = out.price;
          }
        }
      }
      const oddsStr = Object.entries(bestOdds).map(([n, p]) => `${n}: ${p.toFixed(2)}`).join(' | ');
      const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

      return {
        type: 'article',
        id: String(i),
        title: `${ev.home_team} vs ${ev.away_team}`,
        description: `${time} — ${oddsStr}`,
        input_message_content: {
          message_text: `*${ev.home_team} vs ${ev.away_team}*\n${time}\n${oddsStr}`,
          parse_mode: 'Markdown',
        },
      };
    });

    await bot.answerInlineQuery(query.id, results, { cache_time: 60 });
  } catch {}
});

// --- Team Form (last results via scores API) ---
// /form <team> — show recent results
bot.onText(/\/form\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }
  const query = match[1].trim().toLowerCase();

  bot.sendMessage(msg.chat.id, `Looking up form for "${match[1].trim()}"...`).then(async (thinking) => {
    try {
      // Fetch completed scores (last 3 days)
      const scoresUrl = `${ODDS_BASE}/sports/soccer/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3&dateFormat=iso`;
      const scoresRes = await fetch(scoresUrl);
      if (!scoresRes.ok) throw new Error(`API error ${scoresRes.status}`);
      const allScores = await scoresRes.json();

      // Filter completed matches for this team
      const teamMatches = allScores.filter(ev =>
        ev.completed &&
        (ev.home_team.toLowerCase().includes(query) || ev.away_team.toLowerCase().includes(query))
      ).sort((a, b) => new Date(b.commence_time).getTime() - new Date(a.commence_time).getTime());

      // Also fetch upcoming for next match
      const upcoming = await fetchAllSoccer();
      const nextMatch = upcoming.find(ev =>
        ev.home_team.toLowerCase().includes(query) || ev.away_team.toLowerCase().includes(query)
      );

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!teamMatches.length && !nextMatch) {
        bot.sendMessage(msg.chat.id, `No recent matches found for "${match[1].trim()}".`);
        return;
      }

      const teamName = teamMatches.length > 0
        ? (teamMatches[0].home_team.toLowerCase().includes(query) ? teamMatches[0].home_team : teamMatches[0].away_team)
        : (nextMatch.home_team.toLowerCase().includes(query) ? nextMatch.home_team : nextMatch.away_team);

      const lines = [`*${teamName} — Form*\n`];

      // Recent results
      if (teamMatches.length) {
        let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
        let streak = '', streakCount = 0, lastResult = '';

        lines.push('*Recent Results:*');
        for (const m of teamMatches.slice(0, 8)) {
          const homeScore = m.scores?.find(s => s.name === m.home_team)?.score;
          const awayScore = m.scores?.find(s => s.name === m.away_team)?.score;
          if (homeScore == null || awayScore == null) continue;
          const h = parseInt(homeScore), a = parseInt(awayScore);
          const isHome = m.home_team.toLowerCase().includes(query);
          const gf = isHome ? h : a;
          const ga = isHome ? a : h;
          goalsFor += gf; goalsAgainst += ga;

          let result, icon;
          if (gf > ga) { result = 'W'; icon = '🟢'; wins++; }
          else if (gf < ga) { result = 'L'; icon = '🔴'; losses++; }
          else { result = 'D'; icon = '🟡'; draws++; }

          if (result === lastResult || !lastResult) { streakCount++; streak = result; }
          if (!lastResult) lastResult = result;

          const date = new Date(m.commence_time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
          const opponent = isHome ? m.away_team : m.home_team;
          const venue = isHome ? 'H' : 'A';
          lines.push(`  ${icon} ${h}-${a} vs ${opponent} (${venue}) — ${date}`);
        }

        const total = wins + draws + losses;
        lines.push(`\n*Record:* ${wins}W ${draws}D ${losses}L (${total} games)`);
        lines.push(`*Goals:* ${goalsFor} scored, ${goalsAgainst} conceded (${(goalsFor / Math.max(total, 1)).toFixed(1)} avg)`);
        if (streakCount >= 2) {
          const streakLabel = streak === 'W' ? 'wins' : streak === 'L' ? 'losses' : 'draws';
          lines.push(`*Streak:* ${streakCount} ${streakLabel}`);
        }
        lines.push(`*Form:* ${teamMatches.slice(0, 5).map(m => {
          const hs = parseInt(m.scores?.find(s => s.name === m.home_team)?.score || 0);
          const as = parseInt(m.scores?.find(s => s.name === m.away_team)?.score || 0);
          const isH = m.home_team.toLowerCase().includes(query);
          const gf = isH ? hs : as, ga = isH ? as : hs;
          return gf > ga ? 'W' : gf < ga ? 'L' : 'D';
        }).join('')}`);
      }

      // Next match with odds
      if (nextMatch) {
        const time = new Date(nextMatch.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        lines.push(`\n*Next:* ${nextMatch.home_team} vs ${nextMatch.away_team}`);
        lines.push(`  ${time}`);
        const pinOdds = getPinnacleOdds(nextMatch.bookmakers || []);
        if (pinOdds) {
          const pinOut = Object.entries(pinOdds).map(([n, p]) => ({ name: n, price: p }));
          const trueProbs = removeVig(pinOut);
          const probStr = trueProbs.map(tp => `${tp.name}: ${(tp.impliedProb * 100).toFixed(0)}%`).join(' | ');
          lines.push(`  True prob: ${probStr}`);
        }
      }

      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// --- Closing Line Value (CLV) Tracker ---
function loadCLV() { try { return JSON.parse(fs.readFileSync(CLV_FILE, 'utf8')); } catch { return { bets: [] }; } }
function saveCLV(data) { fs.writeFileSync(CLV_FILE, JSON.stringify(data, null, 2)); }

// Auto-record closing odds for tracked bets
async function updateClosingOdds() {
  if (!ODDS_API_KEY) return;
  const clv = loadCLV();
  const br = loadBankroll();
  let events = null;

  for (const chatId of Object.keys(br)) {
    const userBets = br[chatId]?.bets?.filter(b => !b.result && !b.closingOdds) || [];
    for (const bet of userBets) {
      try {
        if (!events) events = await fetchAllSoccer();
        // Try to match bet description to an event
        const desc = bet.desc.toLowerCase();
        const ev = events.find(e => {
          const start = new Date(e.commence_time).getTime();
          // Match if event starts within 2 hours (near kickoff = closing line)
          return (start - Date.now()) < 2 * 60 * 60 * 1000 && (start - Date.now()) > 0 &&
            (e.home_team.toLowerCase().includes(desc) || e.away_team.toLowerCase().includes(desc) || desc.includes(e.home_team.toLowerCase()) || desc.includes(e.away_team.toLowerCase()));
        });
        if (ev) {
          const bestOdds = {};
          for (const bm of (ev.bookmakers || [])) {
            for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
              for (const out of mkt.outcomes) {
                if (!bestOdds[out.name] || out.price > bestOdds[out.name]) bestOdds[out.name] = out.price;
              }
            }
          }
          bet.closingOdds = bestOdds;
          bet.closingTime = new Date().toISOString();
          // Record in CLV tracker
          clv.bets.push({
            betId: bet.id, chatId, desc: bet.desc,
            betOdds: bet.odds, closingOdds: bestOdds,
            match: `${ev.home_team} vs ${ev.away_team}`,
            closingTime: bet.closingTime,
          });
        }
      } catch {}
    }
  }
  saveBankroll(br);
  saveCLV(clv);
}

// Run CLV check every 15 minutes
setInterval(updateClosingOdds, 15 * 60 * 1000);

// /closing — show CLV stats
bot.onText(/\/closing/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const clv = loadCLV();
  if (!clv.bets.length) {
    bot.sendMessage(msg.chat.id, '*Closing Line Value*\n\nNo CLV data yet. Place bets with `/bet` and the bot will automatically track closing odds near kickoff.\n\n_CLV = did you beat the closing line? Positive CLV = long-term edge._', { parse_mode: 'Markdown' });
    return;
  }

  let totalCLV = 0, count = 0;
  const lines = ['*Closing Line Value Tracker*\n'];

  const recent = clv.bets.slice(-10).reverse();
  for (const b of recent) {
    // Find what the closing odds were for their pick
    // Compare bet odds vs closing odds
    const closingBest = Math.max(...Object.values(b.closingOdds));
    const clvPct = ((b.betOdds / closingBest) - 1) * 100;
    totalCLV += clvPct;
    count++;
    const icon = clvPct > 0 ? '✅' : '❌';
    lines.push(`${icon} ${b.desc}`);
    lines.push(`  Bet @ ${b.betOdds.toFixed(2)} | Close @ ~${closingBest.toFixed(2)} | CLV: *${clvPct >= 0 ? '+' : ''}${clvPct.toFixed(1)}%*`);
  }

  const avgCLV = count > 0 ? totalCLV / count : 0;
  lines.push(`\n*Average CLV: ${avgCLV >= 0 ? '+' : ''}${avgCLV.toFixed(1)}%*`);
  lines.push(`_${count} bets tracked_`);
  lines.push('\n_Positive CLV = you consistently beat the market. This is the #1 metric pros use._');
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// --- ELO Rating System ---
function loadElo() { try { return JSON.parse(fs.readFileSync(ELO_FILE, 'utf8')); } catch { return {}; } }
function saveElo(data) { fs.writeFileSync(ELO_FILE, JSON.stringify(data, null, 2)); }

const ELO_K = 32; // K-factor
const ELO_DEFAULT = 1500;

function getElo(team) {
  const data = loadElo();
  return data[team] || ELO_DEFAULT;
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function updateElo(homeTeam, awayTeam, homeGoals, awayGoals) {
  const data = loadElo();
  const homeElo = data[homeTeam] || ELO_DEFAULT;
  const awayElo = data[awayTeam] || ELO_DEFAULT;
  const homeAdv = 65; // home advantage in ELO points

  const expHome = expectedScore(homeElo + homeAdv, awayElo);
  const expAway = 1 - expHome;

  let actualHome, actualAway;
  if (homeGoals > awayGoals) { actualHome = 1; actualAway = 0; }
  else if (homeGoals < awayGoals) { actualHome = 0; actualAway = 1; }
  else { actualHome = 0.5; actualAway = 0.5; }

  // Goal difference multiplier
  const goalDiff = Math.abs(homeGoals - awayGoals);
  const gdMultiplier = goalDiff <= 1 ? 1 : goalDiff === 2 ? 1.5 : (1.75 + (goalDiff - 3) * 0.375);

  data[homeTeam] = Math.round(homeElo + ELO_K * gdMultiplier * (actualHome - expHome));
  data[awayTeam] = Math.round(awayElo + ELO_K * gdMultiplier * (actualAway - expAway));
  saveElo(data);
  return { homeElo: data[homeTeam], awayElo: data[awayTeam], expHome, expAway };
}

// Update ELO from completed scores periodically
async function updateEloFromScores() {
  if (!ODDS_API_KEY) return;
  try {
    const scoresUrl = `${ODDS_BASE}/sports/soccer/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3&dateFormat=iso`;
    const res = await fetch(scoresUrl);
    if (!res.ok) return;
    const scores = await res.json();
    const elo = loadElo();
    if (!elo._processed) elo._processed = [];

    for (const m of scores) {
      if (!m.completed || elo._processed.includes(m.id)) continue;
      const hs = m.scores?.find(s => s.name === m.home_team)?.score;
      const as = m.scores?.find(s => s.name === m.away_team)?.score;
      if (hs == null || as == null) continue;
      updateElo(m.home_team, m.away_team, parseInt(hs), parseInt(as));
      elo._processed.push(m.id);
    }
    // Keep only last 500 processed IDs
    if (elo._processed.length > 500) elo._processed = elo._processed.slice(-500);
    saveElo(elo);
  } catch {}
}

setInterval(updateEloFromScores, 30 * 60 * 1000); // every 30 min
setTimeout(updateEloFromScores, 10_000); // first run 10s after startup

// /elo [team] — show ELO ratings or predict a match
bot.onText(/\/elo\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const query = (match[1] || '').trim().toLowerCase();
  const data = loadElo();
  const teams = Object.entries(data).filter(([k]) => k !== '_processed');

  if (!query || query === 'top') {
    // Show top rated teams
    const sorted = teams.sort(([, a], [, b]) => b - a);
    const lines = ['*ELO Rankings (Top 20)*\n'];
    for (const [team, rating] of sorted.slice(0, 20)) {
      const rank = sorted.indexOf(sorted.find(([t]) => t === team)) + 1;
      lines.push(`  ${rank}. ${team} — *${rating}*`);
    }
    if (!sorted.length) lines.push('No ratings yet. Ratings build automatically from match results.');
    lines.push('\n_Use `/elo <team>` for team rating or `/elo <team1> vs <team2>` for prediction_');
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // Check if it's a "team vs team" query
  const vsMatch = query.match(/(.+?)\s+vs?\s+(.+)/);
  if (vsMatch) {
    const t1q = vsMatch[1].trim();
    const t2q = vsMatch[2].trim();
    const t1 = teams.find(([t]) => t.toLowerCase().includes(t1q));
    const t2 = teams.find(([t]) => t.toLowerCase().includes(t2q));

    if (!t1 || !t2) {
      bot.sendMessage(msg.chat.id, `Couldn't find both teams. Available: ${teams.slice(0, 10).map(([t]) => t).join(', ')}...`);
      return;
    }

    const homeElo = t1[1] + 65; // home advantage
    const awayElo = t2[1];
    const expHome = expectedScore(homeElo, awayElo);
    const expDraw = 0.25 * (1 - Math.abs(expHome - 0.5) * 2); // approximate
    const expAway = 1 - expHome - expDraw;

    const lines = [`*ELO Prediction*\n`];
    lines.push(`*${t1[0]}* (${t1[1]}) vs *${t2[0]}* (${t2[1]})\n`);
    lines.push(`  ${t1[0]}: *${(expHome * 100).toFixed(1)}%* (ELO: ${t1[1]} + 65 home)`);
    lines.push(`  Draw: *${(expDraw * 100).toFixed(1)}%*`);
    lines.push(`  ${t2[0]}: *${(expAway * 100).toFixed(1)}%* (ELO: ${t2[1]})`);

    // Fair odds
    lines.push(`\n*Fair Odds (no vig):*`);
    lines.push(`  ${t1[0]}: ${(1 / expHome).toFixed(2)} | Draw: ${(1 / expDraw).toFixed(2)} | ${t2[0]}: ${(1 / expAway).toFixed(2)}`);
    lines.push('\n_Compare with bookmaker odds to find value_');
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // Single team lookup
  const found = teams.find(([t]) => t.toLowerCase().includes(query));
  if (!found) {
    bot.sendMessage(msg.chat.id, `No ELO data for "${match[1].trim()}". Ratings build from completed matches.`);
    return;
  }
  const rank = teams.sort(([, a], [, b]) => b - a).findIndex(([t]) => t === found[0]) + 1;
  bot.sendMessage(msg.chat.id, `*${found[0]}*\nELO: *${found[1]}* (rank #${rank} of ${teams.length})`, { parse_mode: 'Markdown' });
});

// --- Trending: biggest movers right now ---
// /trending — show which odds are moving most across all events
bot.onText(/\/trending/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }

  bot.sendMessage(msg.chat.id, 'Scanning odds movements...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const today = filterByDay(events, 'today');
      const target = today.length >= 3 ? today : events.slice(0, 30);
      const movements = updateOddsCache(target);

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!movements.length) {
        bot.sendMessage(msg.chat.id, 'No odds movements detected. Run again in a few minutes to build history.');
        return;
      }

      // Sort by absolute change
      movements.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
      const steam = movements.filter(m => m.isSteam);

      const lines = ['*Trending — Biggest Odds Moves*\n'];
      if (steam.length) {
        lines.push('*STEAM MOVES (sharp money):*');
        for (const m of steam.slice(0, 5)) {
          const arrow = m.direction === 'UP' ? '📈' : '📉';
          const pct = ((m.change / m.oldPrice) * 100).toFixed(1);
          lines.push(`${arrow} *${m.event}*`);
          lines.push(`  ${m.outcome}: ${m.oldPrice.toFixed(2)} → *${m.newPrice.toFixed(2)}* (${pct}%) — ${m.bookmaker}`);
        }
        lines.push('');
      }

      lines.push('*All Movements:*');
      for (const m of movements.slice(0, 10)) {
        const arrow = m.direction === 'UP' ? '↑' : '↓';
        const pct = ((m.change / m.oldPrice) * 100).toFixed(1);
        lines.push(`  ${arrow} ${m.event} — ${m.outcome}: ${m.oldPrice.toFixed(2)} → ${m.newPrice.toFixed(2)} (${pct}%)`);
      }

      lines.push(`\n_${movements.length} total moves detected, ${steam.length} from sharp books_`);
      lines.push('_Run frequently to catch steam moves early_');
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// --- Surebets (arb with exact stake calculation) ---
// /surebets [bankroll] — find arbs with exact stake breakdown
bot.onText(/\/surebets\s*(\d+(?:\.\d+)?)?/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }
  const bankroll = match[1] ? parseFloat(match[1]) : (getUserBankroll(msg.chat.id).startBalance || 100);

  bot.sendMessage(msg.chat.id, `Scanning for surebets (€${bankroll.toFixed(0)} bankroll)...`).then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const today = filterByDay(events, 'today');
      const target = today.length >= 3 ? today : events;

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      const arbs = [];
      for (const ev of target) {
        const arb = findArbitrage(ev);
        if (arb) arbs.push({ ...arb, match: `${ev.home_team} vs ${ev.away_team}`, time: ev.commence_time });
      }

      if (!arbs.length) {
        bot.sendMessage(msg.chat.id, `No surebets found. Markets are efficient right now.\n\n_Tip: surebets are rare in soccer. Check back closer to kickoff when bookmakers diverge._`);
        return;
      }

      arbs.sort((a, b) => b.profit - a.profit);
      const lines = [`*Surebets (€${bankroll.toFixed(0)} bankroll)*\n`];

      for (const arb of arbs.slice(0, 5)) {
        const time = new Date(arb.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const profitAmt = (bankroll * arb.profit / 100).toFixed(2);
        lines.push(`*${arb.match}* — *€${profitAmt} guaranteed profit*`);
        lines.push(`  ${time} | ${arb.profit.toFixed(2)}%\n`);

        for (const [name, { price, bookmaker }] of Object.entries(arb.outcomes)) {
          const stakePercent = (1 / price) / arb.totalImplied;
          const stakeAmt = (bankroll * stakePercent).toFixed(2);
          const potReturn = (stakeAmt * price).toFixed(2);
          lines.push(`  ${name} @ *${price.toFixed(2)}* (${bookmaker})`);
          lines.push(`    Stake: *€${stakeAmt}* → Return: €${potReturn}`);
        }
        lines.push('');
      }

      lines.push(`_${arbs.length} surebet(s) found. Place ALL legs or none — partial bets = risk._`);
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// --- Bet Slip Buttons (inline betting from /odds) ---
// Adds "Quick Bet €5/€10" buttons to /compare results
// Handled via callback_query below

// --- Auto-settle Bets (check scores and auto-resolve) ---
async function autoSettleBets() {
  if (!ODDS_API_KEY) return;
  try {
    const scoresUrl = `${ODDS_BASE}/sports/soccer/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3&dateFormat=iso`;
    const res = await fetch(scoresUrl);
    if (!res.ok) return;
    const completed = (await res.json()).filter(m => m.completed);
    const bankrollData = loadBankroll();
    let settled = 0;

    for (const [chatId, br] of Object.entries(bankrollData)) {
      for (const bet of br.bets) {
        if (bet.result) continue; // already settled
        const desc = bet.desc.toLowerCase();

        for (const match of completed) {
          const homeL = match.home_team.toLowerCase();
          const awayL = match.away_team.toLowerCase();
          if (!desc.includes(homeL) && !desc.includes(awayL) && !homeL.includes(desc) && !awayL.includes(desc)) continue;

          const hs = parseInt(match.scores?.find(s => s.name === match.home_team)?.score || '0');
          const as = parseInt(match.scores?.find(s => s.name === match.away_team)?.score || '0');

          // Try to determine if bet won
          // Match team name in description to winner
          let betWon = null;
          if (desc.includes(homeL) || desc.includes(match.home_team.toLowerCase().split(' ')[0])) {
            betWon = hs > as;
          } else if (desc.includes(awayL) || desc.includes(match.away_team.toLowerCase().split(' ')[0])) {
            betWon = as > hs;
          } else if (desc.includes('draw')) {
            betWon = hs === as;
          }

          if (betWon !== null) {
            bet.result = betWon ? 'win' : 'loss';
            bet.settledAt = new Date().toISOString();
            bet.autoSettled = true;
            settled++;

            const icon = betWon ? '✅' : '❌';
            const pnl = betWon ? `+€${(bet.stake * bet.odds - bet.stake).toFixed(2)}` : `-€${bet.stake.toFixed(2)}`;
            const scoreStr = `${match.home_team} ${hs}-${as} ${match.away_team}`;
            bot.sendMessage(parseInt(chatId),
              `${icon} *Auto-settled:* Bet #${bet.id}\n${bet.desc} — ${pnl}\nFinal: ${scoreStr}`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
            break;
          }
        }
      }
    }
    if (settled > 0) saveBankroll(bankrollData);
  } catch {}
}

setInterval(autoSettleBets, 10 * 60 * 1000); // every 10 minutes
setTimeout(autoSettleBets, 30_000); // first run 30s after startup

// --- Weekly Report ---
let lastWeeklyDate = '';
async function sendWeeklyReport() {
  const bankrollData = loadBankroll();
  const history = loadHistory();
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const [chatId, br] of Object.entries(bankrollData)) {
    const weekBets = br.bets.filter(b => b.result && new Date(b.settledAt || b.date).getTime() > oneWeekAgo);
    if (!weekBets.length) continue;

    const won = weekBets.filter(b => b.result === 'win');
    const lost = weekBets.filter(b => b.result === 'loss');
    const totalStaked = weekBets.reduce((s, b) => s + b.stake, 0);
    const totalReturn = won.reduce((s, b) => s + b.stake * b.odds, 0);
    const netPL = totalReturn - totalStaked;
    const roi = totalStaked > 0 ? (netPL / totalStaked * 100) : 0;
    const winRate = weekBets.length > 0 ? (won.length / weekBets.length * 100) : 0;

    // Best and worst bet
    const best = won.sort((a, b) => (b.stake * b.odds - b.stake) - (a.stake * a.odds - a.stake))[0];
    const worst = lost.sort((a, b) => b.stake - a.stake)[0];

    const lines = ['*Weekly Betting Report*\n'];
    lines.push(`*P/L: ${netPL >= 0 ? '+' : ''}€${netPL.toFixed(2)}*`);
    lines.push(`ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
    lines.push(`Record: ${won.length}W / ${lost.length}L (${winRate.toFixed(0)}%)`);
    lines.push(`Staked: €${totalStaked.toFixed(2)}`);

    if (best) lines.push(`\n*Best:* ${best.desc} (+€${(best.stake * best.odds - best.stake).toFixed(2)})`);
    if (worst) lines.push(`*Worst:* ${worst.desc} (-€${worst.stake.toFixed(2)})`);

    // Average odds
    const avgOdds = weekBets.reduce((s, b) => s + b.odds, 0) / weekBets.length;
    lines.push(`\nAvg odds: ${avgOdds.toFixed(2)}`);

    // Parlay record this week
    const weekParlays = history.parlays.filter(p => p.result && new Date(p.date).getTime() > oneWeekAgo);
    if (weekParlays.length) {
      const pWon = weekParlays.filter(p => p.result === 'win').length;
      lines.push(`Parlays: ${pWon}/${weekParlays.length} hit`);
    }

    // CLV
    const clv = loadCLV();
    const weekCLV = clv.bets.filter(b => new Date(b.closingTime).getTime() > oneWeekAgo);
    if (weekCLV.length) {
      const avgCLV = weekCLV.reduce((s, b) => {
        const closingBest = Math.max(...Object.values(b.closingOdds));
        return s + ((b.betOdds / closingBest) - 1) * 100;
      }, 0) / weekCLV.length;
      lines.push(`Avg CLV: ${avgCLV >= 0 ? '+' : ''}${avgCLV.toFixed(1)}%`);
    }

    // Current bankroll
    const allWon = br.bets.filter(b => b.result === 'win');
    const allLost = br.bets.filter(b => b.result === 'loss');
    const totalNetPL = allWon.reduce((s, b) => s + b.stake * b.odds - b.stake, 0) - allLost.reduce((s, b) => s + b.stake, 0);
    if (br.startBalance) lines.push(`\n*Bankroll: €${(br.startBalance + totalNetPL).toFixed(2)}*`);

    lines.push('\n_Weekly report every Monday at 9am_');
    bot.sendMessage(parseInt(chatId), lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
  }
}

// Weekly report check (Monday at DIGEST_HOUR)
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getDay() === WEEKLY_REPORT_DAY && now.getHours() === DIGEST_HOUR && now.getMinutes() === 0 && lastWeeklyDate !== today) {
    lastWeeklyDate = today;
    sendWeeklyReport();
  }
}, 60_000);

// /weekly — trigger weekly report manually
bot.onText(/\/weekly/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  sendWeeklyReport();
});

// --- Quick Bet Buttons (extend callback handler) ---
// Adds bet recording from inline keyboard buttons

// --- Enhanced /compare with bet buttons ---
// We'll extend the callback_query handler to support quick bets

// ============================================================
// --- /tier — View or change subscription tier ---
// ============================================================
bot.onText(/\/tier\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const arg = (match[1] || '').trim().toLowerCase();
  const chatId = String(msg.chat.id);

  if (arg && ['free', 'pro', 'syndicate'].includes(arg)) {
    setUserTier(chatId, arg);
    const t = TIERS[arg];
    bot.sendMessage(msg.chat.id, `Tier set to *${t.name}* (${t.price})\n\nFeatures: ${t.features.join(', ')}`, { parse_mode: 'Markdown' });
    return;
  }

  const current = getUserTier(chatId);
  const t = TIERS[current];
  const lines = ['*Subscription Tiers*\n', `Current: *${t.name}* (${t.price})\n`];
  for (const [key, tier] of Object.entries(TIERS)) {
    const active = key === current ? ' ← current' : '';
    lines.push(`*${tier.name}* — ${tier.price}${active}`);
    lines.push(`  Signals: ${tier.maxSignals === -1 ? 'Unlimited' : tier.maxSignals} | Arbs: ${tier.maxArbs === -1 ? 'Unlimited' : tier.maxArbs}`);
    lines.push(`  Features: ${tier.features.includes('*') ? 'All' : tier.features.join(', ')}\n`);
  }
  lines.push('_Use `/tier <free|pro|syndicate>` to change_');
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// ============================================================
// --- /setedge <percent> — Set minimum EV threshold ---
// ============================================================
bot.onText(/\/setedge\s+(\d+(?:\.\d+)?)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const pct = parseFloat(match[1]);
  const edge = pct > 1 ? pct / 100 : pct; // accept both 2 and 0.02
  setUserSetting(String(msg.chat.id), 'minEdge', edge);
  bot.sendMessage(msg.chat.id, `Minimum EV edge set to *${(edge * 100).toFixed(1)}%*\nValue bets below this threshold will be filtered out.`, { parse_mode: 'Markdown' });
});

// ============================================================
// --- /signals — Unified ranked signals dashboard ---
// ============================================================
bot.onText(/\/signals\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }
  const gate = tierGate(msg.chat.id, 'signals');
  if (gate) { bot.sendMessage(msg.chat.id, gate, { parse_mode: 'Markdown' }); return; }

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;
  const settings = getUserSettings(String(msg.chat.id));
  const tier = getUserTier(String(msg.chat.id));
  const maxSignals = TIERS[tier].maxSignals;

  bot.sendMessage(msg.chat.id, 'Scanning all markets for signals...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const filtered = filterByDay(events, dayFilter);
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!filtered.length) { bot.sendMessage(msg.chat.id, 'No events found.'); return; }

      // Update bias data
      updateBookmakerBias(filtered);

      const signals = rankSignals(filtered);
      const limited = maxSignals > 0 ? signals.slice(0, maxSignals) : signals;

      if (!limited.length) {
        bot.sendMessage(msg.chat.id, 'No actionable signals found right now. Markets are efficient.');
        return;
      }

      const lines = ['*SIGNAL DASHBOARD*\n'];
      lines.push(`_${signals.length} signals found, showing top ${limited.length}_\n`);

      for (const sig of limited) {
        const time = new Date(sig.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        lines.push(`${sig.emoji} *[${sig.type}]* Score: *${sig.score}* — ${sig.match}`);
        lines.push(`  ${sig.detail} | Liquidity: ${sig.liquidity}`);
        if (sig.type === 'VALUE') {
          lines.push(`  ${sig.outcome} @ *${sig.odds.toFixed(2)}* (${sig.bookmaker}) — edge ${(sig.edge * 100).toFixed(1)}%`);
        } else if (sig.type === 'ARB') {
          for (const [name, { price, bookmaker }] of Object.entries(sig.outcomes)) {
            lines.push(`  ${name}: ${price.toFixed(2)} @ ${bookmaker}`);
          }
        } else if (sig.type === 'STEAM') {
          lines.push(`  ${sig.outcome}: ${sig.oldPrice.toFixed(2)} → *${sig.newPrice.toFixed(2)}*`);
        }
        lines.push(`  ${time}\n`);
      }

      if (maxSignals > 0 && signals.length > maxSignals) {
        lines.push(`\n_${signals.length - maxSignals} more signals available on higher tiers. /tier_`);
      }

      lines.push('_Signal score: 0-100 (edge weight 50%, liquidity 30%, timing 20%)_');
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// ============================================================
// --- /xarb — Cross-market arbitrage scanner ---
// ============================================================
bot.onText(/\/xarb\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }
  const gate = tierGate(msg.chat.id, 'xarb');
  if (gate) { bot.sendMessage(msg.chat.id, gate, { parse_mode: 'Markdown' }); return; }

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;

  bot.sendMessage(msg.chat.id, 'Scanning cross-market arbitrage (h2h + spreads + totals)...').then(async (thinking) => {
    try {
      // Fetch with multiple markets
      const url = `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h,spreads,totals&oddsFormat=decimal`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      let events = await res.json();
      events = filterByDay(events, dayFilter);
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      const allArbs = [];
      for (const ev of events) {
        // Standard h2h arbs
        const h2hArb = findArbitrage(ev);
        if (h2hArb) allArbs.push({ ...h2hArb, market: 'h2h', match: `${ev.home_team} vs ${ev.away_team}`, time: ev.commence_time });
        // Cross-market arbs
        const xarbs = findCrossMarketArbitrage(ev);
        allArbs.push(...xarbs);
      }

      // Apply ghost arb filter
      const { all, verified } = trackArbPersistence(allArbs);

      if (!all.length) {
        bot.sendMessage(msg.chat.id, 'No cross-market arbitrage found. Markets are tight.\n\n_Tip: check closer to kickoff when bookmakers diverge._');
        return;
      }

      all.sort((a, b) => b.profit - a.profit);
      const lines = ['*Cross-Market Arbitrage Scanner*\n'];
      lines.push(`Found: ${all.length} total | ${verified.length} verified (persistent)\n`);

      // Show verified first
      if (verified.length) {
        lines.push('*VERIFIED (persistent arbs):*');
        for (const arb of verified.slice(0, 5)) {
          lines.push(`✅ *${arb.match}* — ${arb.market.toUpperCase()} — *${arb.profit.toFixed(2)}%*`);
          lines.push(`  Seen ${arb.persistence.seenCount}x over ${arb.persistence.ageMinutes}min`);
          for (const [name, { price, bookmaker }] of Object.entries(arb.outcomes)) {
            const stake = ((1 / price) / arb.totalImplied * 100).toFixed(0);
            lines.push(`  ${name}: *${price.toFixed(2)}* @ ${bookmaker} (${stake}%)`);
          }
          lines.push('');
        }
      }

      // Show unverified
      const unverified = all.filter(a => !verified.includes(a));
      if (unverified.length) {
        lines.push(`*UNVERIFIED (may be ghost arbs — ${unverified.length}):*`);
        for (const arb of unverified.slice(0, 5)) {
          lines.push(`⚠️ *${arb.match}* — ${arb.market || 'h2h'} — *${arb.profit.toFixed(2)}%*`);
          for (const [name, { price, bookmaker }] of Object.entries(arb.outcomes)) {
            lines.push(`  ${name}: ${price.toFixed(2)} @ ${bookmaker}`);
          }
          lines.push('');
        }
      }

      lines.push('_Run /xarb again in 2-3 min to verify persistence_');
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// ============================================================
// --- /bias — Bookmaker bias report ---
// ============================================================
bot.onText(/\/bias/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const gate = tierGate(msg.chat.id, 'bias');
  if (gate) { bot.sendMessage(msg.chat.id, gate, { parse_mode: 'Markdown' }); return; }

  const report = getBookmakerBiasReport();
  if (!report.length) {
    bot.sendMessage(msg.chat.id, '*Bookmaker Bias Report*\n\nNot enough data yet. Run `/odds`, `/value`, or `/signals` a few times to build bias data.\n\n_The bot tracks how each bookmaker deviates from sharp (Pinnacle) true probabilities._', { parse_mode: 'Markdown' });
    return;
  }

  const lines = ['*Bookmaker Bias Report*\n'];
  lines.push('_How each bookmaker deviates from sharp lines_\n');

  for (const b of report.slice(0, 15)) {
    const direction = b.avgBias > 0 ? '📈 Overprices favorites' : '📉 Overprices underdogs';
    const icon = Math.abs(b.avgBias) > 0.03 ? '🔴' : Math.abs(b.avgBias) > 0.01 ? '🟡' : '🟢';
    lines.push(`${icon} *${b.name}*`);
    lines.push(`  Avg bias: *${(b.avgBias * 100).toFixed(2)}%* (${direction})`);
    lines.push(`  Fav bias: ${(b.favBias * 100).toFixed(2)}% | Und bias: ${(b.undBias * 100).toFixed(2)}%`);
    lines.push(`  Samples: ${b.samples}\n`);
  }

  lines.push('_Negative bias = bookmaker gives better odds than sharp lines (exploit these)_');
  lines.push('_Positive bias = bookmaker prices too tight (avoid for value bets)_');
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// ============================================================
// --- /consensus — Market consensus view ---
// ============================================================
bot.onText(/\/consensus\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }
  const gate = tierGate(msg.chat.id, 'consensus');
  if (gate) { bot.sendMessage(msg.chat.id, gate, { parse_mode: 'Markdown' }); return; }

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;

  bot.sendMessage(msg.chat.id, 'Calculating market consensus...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const filtered = filterByDay(events, dayFilter);
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!filtered.length) { bot.sendMessage(msg.chat.id, 'No events found.'); return; }

      const lines = ['*Market Consensus Model*\n'];
      lines.push('_Weighted consensus from all bookmakers (sharp books 3x weight)_\n');

      for (const ev of filtered.slice(0, 10)) {
        const consensus = calculateConsensus(ev);
        const liquidity = scoreLiquidity(ev);
        const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

        lines.push(`*${ev.home_team} vs ${ev.away_team}*`);
        lines.push(`  ${time} | ${consensus.totalBookmakers} bookmakers | Liquidity: ${liquidity.label} (${liquidity.score})`);

        for (const [name, data] of Object.entries(consensus.outcomes)) {
          const arrow = data.disagreement > 0.10 ? '⚡' : '';
          lines.push(`  ${name}: *${(data.consensusProb * 100).toFixed(1)}%* (fair ${data.fairOdds.toFixed(2)}) | best ${data.bestPrice.toFixed(2)} | spread ${data.spread.toFixed(2)} ${arrow}`);
        }
        lines.push('');
      }

      lines.push(`_${filtered.length} events analyzed | ⚡ = high disagreement (>10%)_`);
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// ============================================================
// --- /predict — Closing line prediction ---
// ============================================================
bot.onText(/\/predict\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }
  const gate = tierGate(msg.chat.id, 'predict');
  if (gate) { bot.sendMessage(msg.chat.id, gate, { parse_mode: 'Markdown' }); return; }

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;

  bot.sendMessage(msg.chat.id, 'Predicting closing lines...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const filtered = filterByDay(events, dayFilter);
      // Need cached data for predictions, update cache first
      updateOddsCache(filtered);
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!filtered.length) { bot.sendMessage(msg.chat.id, 'No events found.'); return; }

      const lines = ['*Closing Line Predictions*\n'];
      lines.push('_Based on consensus + movement momentum_\n');

      let predictCount = 0;
      for (const ev of filtered.slice(0, 12)) {
        const pred = predictClosingLine(ev);
        if (!pred) continue;
        predictCount++;

        const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        lines.push(`*${ev.home_team} vs ${ev.away_team}* — ${time}`);

        for (const [name, p] of Object.entries(pred)) {
          const edgeIcon = p.edgeVsClosing > 1 ? '✅' : p.edgeVsClosing > 0 ? '🟡' : '🔴';
          const momIcon = p.momentum > 0.05 ? '📈' : p.momentum < -0.05 ? '📉' : '➡️';
          lines.push(`  ${name}: now *${p.currentBest.toFixed(2)}* → predicted close *${p.predictedClosing.toFixed(2)}* ${momIcon}`);
          lines.push(`    ${edgeIcon} Edge vs closing: *${p.edgeVsClosing >= 0 ? '+' : ''}${p.edgeVsClosing.toFixed(1)}%* | Consensus: ${(p.consensusProb * 100).toFixed(1)}%`);
        }
        lines.push('');
      }

      if (!predictCount) {
        lines.push('No predictions available. Run `/odds` first to build cached data, then run `/predict` again.');
      }
      lines.push('_✅ = value at current price vs predicted closing | Run frequently for better momentum data_');
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// ============================================================
// --- /liquidity — Liquidity scores for upcoming events ---
// ============================================================
bot.onText(/\/liquidity\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!ODDS_API_KEY) { bot.sendMessage(msg.chat.id, 'Set ODDS\\_API\\_KEY in .env first.', { parse_mode: 'Markdown' }); return; }

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;

  bot.sendMessage(msg.chat.id, 'Scoring market liquidity...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const filtered = filterByDay(events, dayFilter);
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!filtered.length) { bot.sendMessage(msg.chat.id, 'No events found.'); return; }

      const scored = filtered.map(ev => ({ ev, liq: scoreLiquidity(ev) }))
        .sort((a, b) => b.liq.score - a.liq.score);

      const lines = ['*Liquidity Scores*\n'];
      lines.push('_Higher score = more bookmakers + tighter spreads = safer to bet_\n');

      for (const { ev, liq } of scored.slice(0, 15)) {
        const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const bar = '█'.repeat(Math.round(liq.score / 10)) + '░'.repeat(10 - Math.round(liq.score / 10));
        lines.push(`*${ev.home_team} vs ${ev.away_team}*`);
        lines.push(`  ${bar} *${liq.score}/100* (${liq.label})`);
        lines.push(`  ${liq.bmCount} bookmakers | Avg spread: ${liq.spread.toFixed(3)} | ${time}\n`);
      }

      lines.push(`_${filtered.length} events scored_`);
      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });
});

// --- Help: updated command list ---
bot.onText(/\/help/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const lines = [
    '*Ruflo Odds Intelligence Platform*\n',
    '*Signal Intelligence:*',
    '  /signals [today] — *UNIFIED SIGNAL DASHBOARD*',
    '  /consensus [today] — market consensus model',
    '  /predict [today] — closing line predictions',
    '  /liquidity [today] — market liquidity scores',
    '  /bias — bookmaker bias report',
    '',
    '*Arbitrage:*',
    '  /arb [today] — h2h arbitrage scanner',
    '  /xarb [today] — cross-market arb (h2h+spreads+totals)',
    '  /surebets [bankroll] — arb with exact stakes',
    '',
    '*Value & Sharp:*',
    '  /value [today] — +EV bets vs sharp lines',
    '  /sharp [today] — Pinnacle true probabilities',
    '  /moves [today] — odds movement / steam moves',
    '  /trending — biggest movers right now',
    '',
    '*Odds & Analysis:*',
    '  /odds <sport> [today] — full dashboard + parlays',
    '  /soccer — 1X2 + handicap + O/U odds',
    '  /compare <team> — bookmakers side-by-side',
    '  /analyze [sport] [today] — deep analysis',
    '  /hot — most popular events',
    '  /live — live matches with scores',
    '',
    '*Team & Predictions:*',
    '  /form <team> — recent results & streak',
    '  /elo — ELO rankings / team / vs prediction',
    '',
    '*Bet Sizing:*',
    '  /kelly <prob%> <odds> [bank] — optimal stake',
    '  /parlay <sport1> <sport2> — multi-sport acca',
    '  /sports — list available sports',
    '',
    '*Bankroll & Tracking:*',
    '  /setbank / /bet / /betwin / /betloss',
    '  /bankroll — stats, ROI, P/L',
    '  /closing — closing line value stats',
    '  /history — parlay track record',
    '  /weekly — weekly performance report',
    '',
    '*Alerts & Auto:*',
    '  /alert <team> — odds change alerts',
    '  /digest — daily picks (auto at 9am)',
    '',
    '*Settings:*',
    '  /tier — view/change subscription tier',
    '  /setedge <pct> — min EV threshold (default 2%)',
    '',
    '*Dev:*',
    '  /ship /fix /refactor /review <desc>',
    '',
    '_Inline: type @botname in any chat_',
  ];
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  saveSessionsToFile();
  bot.stopPolling();
  for (const controller of activeSessions.values()) controller.abort();
  process.exit(0);
});
