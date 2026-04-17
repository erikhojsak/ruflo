// Ruflo Telegram Bot v1.1
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { spawn, spawnSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import Stripe from 'stripe';
import express from 'express';

// --- Configuration ---
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').replace(/[^\x20-\x7E]/g, '').trim();
const ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USERS
  ? process.env.TELEGRAM_ALLOWED_USERS.split(',').map(Number)
  : []; // empty = allow all
const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../..'
);
const MAX_MSG_LENGTH = 4096;

// --- State directory (persistent JSON files) ---
// All state files live under STATE_DIR. Default: <app-dir>/data (matches Docker
// volume mount at /app/data). Override via STATE_DIR env for custom deploys.
// On first boot after upgrade, files at the old app-root location are migrated
// into STATE_DIR automatically.
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(APP_DIR, 'data'));
try { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
function stateFile(name) { return path.join(STATE_DIR, name); }
// DATA_DIR kept for backward compat — alias to STATE_DIR now
const DATA_DIR = STATE_DIR;

// One-time migration: move state files from legacy app-root locations into STATE_DIR.
// Safe to run on every boot — only moves files that exist at the old path and
// aren't already present at the new path.
const LEGACY_STATE_FILES = [
  'tasks.json', 'sessions.json', 'bankroll.json', 'alerts.json', 'parlay_history.json',
  'clv_tracker.json', 'elo_ratings.json', 'tiers.json', 'bookmaker_bias.json', 'signals.json',
  'arb_persistence.json', 'user_settings.json', 'briefing_state.json', 'signal_track.json',
  'subscriptions.json', 'stripe_events.json', 'referrals.json', 'odds_cache.json', 'scanner_state.json',
];
function migrateLegacyState() {
  if (path.resolve(STATE_DIR) === path.resolve(APP_DIR)) return; // nothing to do
  let moved = 0;
  for (const name of LEGACY_STATE_FILES) {
    const oldPath = path.join(APP_DIR, name);
    const newPath = path.join(STATE_DIR, name);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.renameSync(oldPath, newPath);
        moved++;
      }
    } catch (err) {
      // Cross-device rename fails → fall back to copy + unlink
      try {
        fs.copyFileSync(oldPath, newPath);
        fs.unlinkSync(oldPath);
        moved++;
      } catch {}
    }
  }
  if (moved > 0) console.log(`[startup] Migrated ${moved} state file(s) from app root to ${STATE_DIR}`);
}
migrateLegacyState();

const TASKS_FILE = stateFile('tasks.json');
const SESSIONS_FILE = stateFile('sessions.json');
const BANKROLL_FILE = stateFile('bankroll.json');
const ALERTS_FILE = stateFile('alerts.json');
const HISTORY_FILE = stateFile('parlay_history.json');
const CLV_FILE = stateFile('clv_tracker.json');
const ELO_FILE = stateFile('elo_ratings.json');
const TIERS_FILE = stateFile('tiers.json');
const BIAS_FILE = stateFile('bookmaker_bias.json');
const SIGNALS_FILE = stateFile('signals.json');
const ARB_PERSIST_FILE = stateFile('arb_persistence.json');
const USER_SETTINGS_FILE = stateFile('user_settings.json');
const DAILY_REMINDER_HOUR = parseInt(process.env.REMINDER_HOUR || '9', 10);
const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR || '9', 10);
const WEEKLY_REPORT_DAY = 1; // Monday
const BRIEFING_INTERVAL_HOURS = parseInt(process.env.BRIEFING_INTERVAL || '6', 10);
const BRIEFING_STATE_FILE = stateFile('briefing_state.json');
const SIGNAL_TRACK_FILE = stateFile('signal_track.json');
const SUBSCRIPTIONS_FILE = stateFile('subscriptions.json');
const STRIPE_EVENTS_FILE = stateFile('stripe_events.json');
const REFERRALS_FILE = stateFile('referrals.json');
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || 'RufloBot').replace(/^@/, '');
const STRIPE_REFERRAL_COUPON = process.env.STRIPE_REFERRAL_COUPON || '';

// --- Stripe Configuration ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_WEBHOOK_PORT = parseInt(process.env.STRIPE_WEBHOOK_PORT || '3456', 10);
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || 'https://t.me';
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || 'https://t.me';
// Create price IDs in your Stripe dashboard and set these:
const STRIPE_PRICES = {
  plus:      process.env.STRIPE_PRICE_PLUS || process.env.STRIPE_PRICE_PRO || '',       // €50/mo recurring
  plusmax:   process.env.STRIPE_PRICE_PLUSMAX || process.env.STRIPE_PRICE_SYNDICATE || '',  // €300/mo recurring
};
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// --- Atomic file helpers ---
// Prevents state corruption when process is killed mid-write. Writes to a tmp
// file then renames (POSIX rename is atomic). Use for every JSON state file.
function atomicWriteJson(file, data, pretty = true) {
  const dir = path.dirname(file);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, file);
}

// --- Task persistence ---
function loadTasks() {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTasks(tasks) {
  atomicWriteJson(TASKS_FILE, tasks);
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

const _hasOddsKey = !!(process.env.ODDS_API_KEY || '').trim();

// --- Bookmaker registry ---
// Maps country codes to local bookmakers. affiliate_url placeholders use {EVENT} for match deep links.
// Add your real affiliate tracking IDs/URLs once you have them.
const BOOKMAKERS = {
  sk: [
    { id: 'nike', name: 'Niké', flag: '🇸🇰', url: 'https://www.nike.sk', affiliate: '' },
    { id: 'tipsport_sk', name: 'Tipsport', flag: '🇸🇰', url: 'https://www.tipsport.sk', affiliate: '' },
    { id: 'fortuna_sk', name: 'Fortuna', flag: '🇸🇰', url: 'https://www.ifortuna.sk', affiliate: '' },
    { id: 'doxxbet', name: 'DOXXbet', flag: '🇸🇰', url: 'https://www.doxxbet.sk', affiliate: '' },
  ],
  hr: [
    { id: 'supersport', name: 'SuperSport', flag: '🇭🇷', url: 'https://www.supersport.hr', affiliate: '' },
    { id: 'germania', name: 'Germania', flag: '🇭🇷', url: 'https://www.germania-sport.hr', affiliate: '' },
    { id: 'mozzart_hr', name: 'Mozzart', flag: '🇭🇷', url: 'https://www.mozzartbet.hr', affiliate: '' },
    { id: 'psk', name: 'PSK', flag: '🇭🇷', url: 'https://www.psk.hr', affiliate: '' },
  ],
  cs: [
    { id: 'tipsport_cz', name: 'Tipsport', flag: '🇨🇿', url: 'https://www.tipsport.cz', affiliate: '' },
    { id: 'fortuna_cz', name: 'Fortuna', flag: '🇨🇿', url: 'https://www.ifortuna.cz', affiliate: '' },
    { id: 'chance', name: 'Chance', flag: '🇨🇿', url: 'https://www.chance.cz', affiliate: '' },
  ],
  pl: [
    { id: 'sts', name: 'STS', flag: '🇵🇱', url: 'https://www.sts.pl', affiliate: '' },
    { id: 'fortuna_pl', name: 'Fortuna', flag: '🇵🇱', url: 'https://www.efortuna.pl', affiliate: '' },
    { id: 'betclic', name: 'Betclic', flag: '🇵🇱', url: 'https://www.betclic.pl', affiliate: '' },
  ],
  de: [
    { id: 'tipico', name: 'Tipico', flag: '🇩🇪', url: 'https://www.tipico.de', affiliate: '' },
    { id: 'bwin', name: 'bwin', flag: '🇩🇪', url: 'https://www.bwin.de', affiliate: '' },
    { id: 'bet365_de', name: 'Bet365', flag: '🇩🇪', url: 'https://www.bet365.de', affiliate: '' },
  ],
  tr: [
    { id: 'misli', name: 'Misli', flag: '🇹🇷', url: 'https://www.misli.com', affiliate: '' },
    { id: 'nesine', name: 'Nesine', flag: '🇹🇷', url: 'https://www.nesine.com', affiliate: '' },
    { id: 'bilyoner', name: 'Bilyoner', flag: '🇹🇷', url: 'https://www.bilyoner.com', affiliate: '' },
  ],
  ro: [
    { id: 'superbet', name: 'Superbet', flag: '🇷🇴', url: 'https://www.superbet.ro', affiliate: '' },
    { id: 'betano', name: 'Betano', flag: '🇷🇴', url: 'https://www.betano.ro', affiliate: '' },
    { id: 'fortuna_ro', name: 'Fortuna', flag: '🇷🇴', url: 'https://www.efortuna.ro', affiliate: '' },
  ],
  it: [
    { id: 'snai', name: 'SNAI', flag: '🇮🇹', url: 'https://www.snai.it', affiliate: '' },
    { id: 'sisal', name: 'Sisal', flag: '🇮🇹', url: 'https://www.sisal.it', affiliate: '' },
    { id: 'bet365_it', name: 'Bet365', flag: '🇮🇹', url: 'https://www.bet365.it', affiliate: '' },
  ],
  // International fallback
  _default: [
    { id: 'bet365', name: 'Bet365', flag: '🌍', url: 'https://www.bet365.com', affiliate: '' },
    { id: 'betfair', name: 'Betfair', flag: '🌍', url: 'https://www.betfair.com', affiliate: '' },
    { id: 'pinnacle', name: 'Pinnacle', flag: '🌍', url: 'https://www.pinnacle.com', affiliate: '' },
  ],
};

// User's preferred bookmakers (persisted in user_settings)
function getUserBookmakers(chatId) {
  const s = loadUserSettings()[String(chatId)] || {};
  return s.bookmakers || null; // null = use country default
}
function setUserBookmakers(chatId, bookmakerIds) {
  const all = loadUserSettings();
  const key = String(chatId);
  if (!all[key]) all[key] = {};
  all[key].bookmakers = bookmakerIds;
  saveUserSettings(all);
}
function getBookmakersForUser(chatId) {
  // User-specific prefs first, then country-based, then international fallback
  const prefs = getUserBookmakers(chatId);
  if (prefs && prefs.length > 0) {
    const all = Object.values(BOOKMAKERS).flat();
    return prefs.map(id => all.find(b => b.id === id)).filter(Boolean);
  }
  const lang = getUserLang(chatId);
  return BOOKMAKERS[lang] || BOOKMAKERS._default;
}
function formatBookmakerButtons(chatId) {
  const books = getBookmakersForUser(chatId);
  return books.slice(0, 3).map(b => ({ text: `${b.flag} ${b.name}`, url: b.affiliate || b.url }));
}

// ============================================================
// --- STRUCTURED LOGGER ---
// ============================================================
// Leveled logger with timestamps. Use instead of raw console.log going forward.
// Level priority: debug < info < warn < error. Set LOG_LEVEL env var to filter.
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 1;
function _logAt(level, ...args) {
  if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}
const log = {
  debug: (...a) => _logAt('debug', ...a),
  info:  (...a) => _logAt('info', ...a),
  warn:  (...a) => _logAt('warn', ...a),
  error: (...a) => _logAt('error', ...a),
};

log.info(`Ruflo Telegram Bot v1.1`);
log.info(`Odds API: ${_hasOddsKey ? 'LIVE' : 'DEMO (no API key)'}`);
log.info(`AI Understanding: ${ANTHROPIC_API_KEY ? 'ON (multilingual)' : 'OFF (pattern matching only)'}`);
log.info(`Stripe: ${STRIPE_SECRET_KEY ? 'configured' : 'not configured'}`);
log.info(`State dir: ${STATE_DIR}`);
log.info(`Working directory: ${WORKING_DIR}`);

// --- Startup env audit ---
// Warns about missing env vars so operators can fix misconfigurations before
// they cause silent failures (e.g. webhook signature rejection, broken referral links).
(function auditEnv() {
  const critical = [
    ['TELEGRAM_BOT_TOKEN', !!TOKEN, 'bot will not start'],
    ['STRIPE_WEBHOOK_SECRET', !STRIPE_SECRET_KEY || !!STRIPE_WEBHOOK_SECRET, 'Stripe webhooks will be rejected — subscriptions never activate'],
    ['STRIPE_PRICE_PLUS', !STRIPE_SECRET_KEY || !!STRIPE_PRICES.plus, '/subscribe plus will fail'],
    ['STRIPE_PRICE_PLUSMAX', !STRIPE_SECRET_KEY || !!STRIPE_PRICES.plusmax, '/subscribe plusmax will fail'],
    ['TELEGRAM_BOT_USERNAME', !!process.env.TELEGRAM_BOT_USERNAME, `referral links default to @${BOT_USERNAME} — may be wrong`],
    ['STRIPE_REFERRAL_COUPON', !STRIPE_SECRET_KEY || !!STRIPE_REFERRAL_COUPON, 'referrals tracked but no reward applied'],
  ];
  const recommended = [
    ['ANTHROPIC_API_KEY', !!ANTHROPIC_API_KEY, 'no multilingual NLP — pattern matching only'],
    ['ODDS_API_KEY', _hasOddsKey, 'running in DEMO mode — no live odds'],
    ['STRIPE_SUCCESS_URL', !!process.env.STRIPE_SUCCESS_URL, `defaults to ${STRIPE_SUCCESS_URL}`],
    ['STRIPE_CANCEL_URL', !!process.env.STRIPE_CANCEL_URL, `defaults to ${STRIPE_CANCEL_URL}`],
    ['TELEGRAM_ADMIN_USERS', !!process.env.TELEGRAM_ADMIN_USERS, '/admin dashboard will be inaccessible'],
  ];
  const criticalMissing = critical.filter(([, ok]) => !ok);
  const recommendedMissing = recommended.filter(([, ok]) => !ok);
  if (criticalMissing.length === 0 && recommendedMissing.length === 0) {
    log.info('[env audit] All environment variables present');
    return;
  }
  if (criticalMissing.length) {
    log.warn('[env audit] ⚠️  CRITICAL env vars missing:');
    for (const [name, , impact] of criticalMissing) log.warn(`  - ${name}: ${impact}`);
  }
  if (recommendedMissing.length) {
    log.info('[env audit] Recommended env vars not set:');
    for (const [name, , impact] of recommendedMissing) log.info(`  - ${name}: ${impact}`);
  }
})();

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
  try { atomicWriteJson(SESSIONS_FILE, obj); } catch {}
}

// Load persisted sessions on startup
for (const [k, v] of Object.entries(loadSessionsFromFile())) {
  claudeSessions.set(k, v);
}
log.info(`Loaded ${claudeSessions.size} persisted session(s)`);

// --- Auth check ---
function isAllowed(userId) {
  return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(userId);
}

// ============================================================
// --- NATURAL LANGUAGE ROUTER ---
// ============================================================
// Maps casual user messages to bot commands so users don't need to memorize slash commands
const NL_PATTERNS = [
  // Arbitrage
  { patterns: [/\barb/i, /\barbitrage/i, /\bsurebet/i, /\bguaranteed\s*profit/i, /\brisk.?free/i], command: '/arb', label: 'arbitrage' },
  // Value bets
  { patterns: [/\bvalue\s*bet/i, /\+ev\b/i, /\bedge/i, /\boverpriced/i, /\bpositive\s*ev/i, /\bexpected\s*value/i], command: '/value', label: 'value bets' },
  // Signals / what's good — broad conversational catch
  { patterns: [/\bsignal/i, /what.*good/i, /what.*hot/i, /any.*pick/i, /best.*bet/i, /what.*recommend/i, /anything\s*worth/i, /what.*play/i, /what.*look/i, /show\s*me/i, /what.*got/i, /anything.*today/i, /what.*think/i, /give\s*me/i, /what.*happening/i, /info.*today/i, /what.*new/i], command: '/signals', label: 'signals' },
  // Sharp / steam (before generic odds — "pinnacle odds" should match sharp, not odds)
  { patterns: [/\bsharp/i, /\bsteam/i, /\bpinnacle/i, /\bline\s*move/i, /\bsmart\s*money/i, /where.*money\s*going/i], command: '/sharp', label: 'sharp money' },
  // Movements (before generic odds — "odds changing" should match moves, not odds)
  { patterns: [/\bmoved?\b/i, /\bmoving/i, /\bshift/i, /odds.*chang/i, /\bchang.*odds/i], command: '/moves', label: 'movements' },
  // Live
  { patterns: [/\blive\b/i, /\bin.?play/i, /\bright\s*now\b/i, /what.*happening/i, /\bscores?\b/i], command: '/live', label: 'live' },
  // Specific sports (before generic odds — "hockey odds" should route to NHL, not generic)
  { patterns: [/\bnba\b/i, /\bbasketball\b/i], command: '/odds nba', label: 'NBA odds' },
  { patterns: [/\bnfl\b/i, /\bamerican\s*football\b/i], command: '/odds nfl', label: 'NFL odds' },
  { patterns: [/\bnhl\b/i, /\bhockey\b/i], command: '/odds nhl', label: 'NHL odds' },
  { patterns: [/\bmlb\b/i, /\bbaseball\b/i], command: '/odds mlb', label: 'MLB odds' },
  { patterns: [/\bufc\b/i, /\bmma\b/i, /\bfight/i], command: '/odds mma', label: 'MMA odds' },
  { patterns: [/\btennis\b/i], command: '/odds tennis', label: 'tennis odds' },
  { patterns: [/\bsoccer\b/i, /\bfootball\b/i, /\bepl\b/i, /\bpremier\s*league/i, /\bla\s*liga/i, /\bbundesliga/i, /\bserie\s*a/i, /\bchampions\s*league/i], command: '/odds soccer', label: 'soccer odds' },
  // Generic odds (after sport-specific and sharp/moves to avoid swallowing them)
  { patterns: [/\bodds\b/i, /what.*odds/i, /show.*odds/i, /\bprices?\b.*\b(match|game|today)/i], command: '/odds soccer', label: 'odds' },
  // Free trial (before /subscribe so "free trial" isn't swallowed by /bpric/)
  { patterns: [/\bfree\s*trial/i, /\btry.*free/i, /\bfree.*week/i, /\b7\s*day.*free/i, /\btrial\b/i], command: '/trial', label: 'free trial' },
  // Referral (before subscribe — "invite friends to upgrade" should match refer, not subscribe)
  { patterns: [/\brefer(ral)?\b/i, /\binvite/i, /\bshare.*(link|bot|ruflo)/i, /\bfree\s*month/i, /\bmy\s*link/i], command: '/refer', label: 'referral' },
  { patterns: [/\bbookmaker/i, /\bbetting\s*site/i, /\bwhere.*bet\b/i, /\bwhich\s*site/i, /\bklad(ionic|e)/i, /\bsáz(kov|en)/i], command: '/bookmakers', label: 'bookmakers' },
  { patterns: [/\bbet\s*slip/i, /\bparlay/i, /\bacca/i, /\bcombine.*bets/i, /\bbuild.*bet/i, /\bmulti\s*bet/i, /\btiket/i], command: '/betslip', label: 'bet slip builder' },
  // Subscribe / pricing (before bankroll — "upgrade my plan" should match subscribe, not bankroll)
  { patterns: [/\bsubscri/i, /\bupgrade/i, /\bpric/i, /\bplan/i, /\bbilling/i, /\bpay/i, /\bcost/i, /how\s*much.*(cost|pay|pric|charg|worth)/i], command: '/subscribe', label: 'subscribe' },
  // Bankroll / performance
  { patterns: [/\bbankroll/i, /\bbalance\b/i, /how.*doing/i, /how.*much.*won/i], command: '/bankroll', label: 'bankroll' },
  { patterns: [/\bmy\s*stats/i, /my\s*(p&?l|profit|loss|roi|performance)/i, /\bwin\s*rate/i, /\bstreak/i, /how.*i.*doing/i, /\bmy\s*record/i], command: '/stats', label: 'stats' },
  // Compare
  { patterns: [/\bcompare\b/i, /\bvs\b.*odds/i, /which\s*book/i], command: null, handler: 'compare', label: 'compare' },
  // Parlays
  { patterns: [/\bparlay/i, /\bacca/i, /\baccumulator/i, /\bcombo\b/i], command: '/odds soccer', label: 'parlays' },
  // Kelly
  { patterns: [/\bkelly/i, /how\s*much.*bet/i, /\boptimal\s*stake/i], command: '/kelly', label: 'Kelly criterion' },
  // Stake units (separate from Kelly — "stake size" moved from Kelly to here)
  { patterns: [/\bunits?\b/i, /\bstake\s*siz/i, /\bunit\s*siz/i, /\bp\/?l.*units?/i], command: '/units', label: 'stake units' },
  // Briefing
  { patterns: [/\bbriefing/i, /\bupdate\s*me/i, /\bwhat.*miss/i, /\bcatch.*up/i, /\bsummary/i, /\boverview/i], command: '/briefing', label: 'briefing' },
  // Scanner
  { patterns: [/\bscanner/i, /\balert/i, /\bnotif/i, /\bpush/i, /turn.*on/i, /start.*alert/i], command: '/scanner', label: 'scanner' },
  // Help
  { patterns: [/\bhelp\b/i, /what\s*can\s*you/i, /\bcommand/i, /how\s*does\s*this/i, /\bfeature/i], command: '/help', label: 'help' },
  // About
  { patterns: [/what\s*is\s*ruflo/i, /\babout\b/i, /who\s*(are|made)\s*(you|this)/i, /tell\s*me\s*about/i], command: '/about', label: 'about' },
  // Team form
  { patterns: [/\bform\b.*\b\w{3,}/i, /how.*playing/i, /\bstreak/i, /\brecent\s*results/i], command: null, handler: 'form', label: 'team form' },
  // Trending
  { patterns: [/\btrending/i, /\bbiggest\s*mover/i, /what.*popular/i], command: '/trending', label: 'trending' },
  // Track record / proof
  { patterns: [/\btrack\s*record/i, /\bperformance\b/i, /\bproof\b/i, /\bresults?\b.*\bsignal/i, /how.*accurate/i, /\bwin\s*rate/i, /\broi\b/i], command: '/track', label: 'track record' },
  // Preferences / settings
  { patterns: [/\bpref/i, /\bsettings?\b/i, /\bconfigure\b/i, /\bnotification.*settings?/i], command: '/prefs', label: 'preferences' },
  // Leaderboard
  { patterns: [/\bleaderboard/i, /\branking/i, /\btop.*bettor/i, /who.*winning/i, /who.*best/i], command: '/leaderboard', label: 'leaderboard' },
  // Compare / table
  { patterns: [/\bcompare\b/i, /\btable\b/i, /\bside.*side/i, /which\s*book/i], command: null, handler: 'compare', label: 'compare' },
  // Menu
  { patterns: [/\bmenu\b/i, /\bbutton/i], command: '/menu', label: 'menu' },
];

// Match user message to an intent
function matchIntent(text) {
  const lower = text.toLowerCase().trim();
  // Skip very short messages
  if (lower.length < 3) return null;
  // Skip pure greetings (but NOT "hello what's good today" — those have useful content after the greeting)
  if (/^(hi|hey|hello|yo|sup|thanks|thx|ok|okay|cool|nice|great|hola|bonjour|ciao|bok|cześć|czesc|ahoj|merhaba|salut|hej|olá|ola|buenas?|morgen|guten\s*tag|dobry\s*den|dobré\s*ráno|dobrý\s*deň)[\s!.?]*$/i.test(lower)) return null;
  // Strip greeting prefix so "hey any arbs?" matches the arb pattern
  const stripped = lower.replace(/^(hi|hey|hello|yo|sup|hola|bonjour|ciao|bok|ahoj|nazdar|merhaba|salut|hej)\s*,?\s*/i, '');

  for (const route of NL_PATTERNS) {
    for (const pattern of route.patterns) {
      if (pattern.test(lower) || pattern.test(stripped)) {
        return route;
      }
    }
  }

  // Check for "today" or "tomorrow" modifier
  const hasToday = /\btoday\b/i.test(lower);
  const hasTomorrow = /\btomorrow\b/i.test(lower);
  const dayMod = hasToday ? ' today' : hasTomorrow ? ' tomorrow' : '';

  // Generic "what's on" / "any games" / "today games" / "info about today" type queries
  if (/what.*on\b|any\s*(game|match|event)|today.*(game|match)|tonight.*(game|match)|\bgames?\s*today\b|\bmatches?\s*today\b|tell.*about.*game|info.*today|today.*info/i.test(lower)) {
    return { command: `/signals`, label: 'today overview' };
  }

  return null;
}

// ============================================================
// --- AI INTENT CLASSIFIER (multilingual understanding) ---
// ============================================================
// Uses Claude Haiku to understand messages in ANY language when pattern matching fails.
// Cost: ~€0.25 per 1,000 messages. Falls back to pattern matching if no API key.

const AI_INTENT_COMMANDS = {
  signals: '/signals',
  arb: '/arb',
  value: '/value',
  sharp: '/sharp',
  moves: '/moves',
  odds_soccer: '/odds soccer today',
  odds_nba: '/odds nba',
  odds_nfl: '/odds nfl',
  odds_nhl: '/odds nhl',
  odds_generic: '/odds soccer today',
  live: '/live',
  bankroll: '/bankroll',
  kelly: '/kelly',
  subscribe: '/subscribe',
  refer: '/refer',
  scanner: '/scanner',
  help: '/help',
  about: '/about',
  briefing: '/briefing',
  compare: '/compare',
  trending: '/trending',
  track: '/track',
  language: '/language',
};

// Cache to avoid repeated API calls for same message
const aiIntentCache = new Map();
const AI_CACHE_MAX = 500;

async function classifyIntentAI(message, userLang) {
  if (!ANTHROPIC_API_KEY) return null;

  // Check cache
  const cacheKey = message.toLowerCase().trim();
  if (aiIntentCache.has(cacheKey)) return aiIntentCache.get(cacheKey);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `You are an intent classifier for a sports betting intelligence bot. The user wrote: "${message}"

Classify this into ONE of these intents (respond with ONLY the intent key, nothing else):
- signals: wants to see today's best bets, picks, recommendations, what's good
- arb: asking about arbitrage, sure bets, guaranteed profit
- value: asking about value bets, +EV, edges, overpriced odds
- sharp: asking about sharp money, professional bettors, Pinnacle, line movements
- moves: asking about odds movements, what changed, steam moves
- odds_soccer: wants soccer/football odds
- odds_nba: wants NBA/basketball odds
- odds_nfl: wants NFL/american football odds
- odds_nhl: wants NHL/hockey odds
- odds_generic: wants odds for any other sport
- live: wants live scores, in-play info
- bankroll: asking about their balance, P/L, ROI, how they're doing
- kelly: asking about bet sizing, how much to bet, stake calculation
- subscribe: asking about pricing, plans, upgrading, payment
- refer: asking about referral link, inviting friends, sharing the bot, earning a free month
- scanner: wants alerts, notifications, push updates
- help: asking for help, what can the bot do
- about: asking what Ruflo is, who made it
- briefing: wants a market summary/briefing
- compare: wants to compare bookmaker odds for a team
- trending: wants to see trending/popular events
- track: wants to see track record, proof, performance
- language: wants to change language
- greeting: saying hello/hi/hey in any language
- thanks: saying thank you in any language
- explain_arb: asking what arbitrage IS (education)
- explain_value: asking what value betting IS (education)
- explain_sharp: asking what sharp money IS (education)
- explain_kelly: asking what Kelly criterion IS (education)
- explain_general: asking how the bot works, how to use it
- team_mention: mentioning a specific team name (respond with "team_mention:TEAM_NAME")
- unknown: doesn't relate to sports betting at all

Respond with ONLY the intent key.`,
        }],
      }),
    });

    if (!res.ok) {
      log.info(`[ai] Intent classification failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const intent = (data.content?.[0]?.text || '').trim().toLowerCase();

    // Cache the result
    if (aiIntentCache.size >= AI_CACHE_MAX) {
      const firstKey = aiIntentCache.keys().next().value;
      aiIntentCache.delete(firstKey);
    }
    aiIntentCache.set(cacheKey, intent);

    return intent;
  } catch (err) {
    log.info(`[ai] Intent classification error: ${err.message}`);
    return null;
  }
}

// ============================================================
// --- INLINE BUTTON KEYBOARDS ---
// ============================================================
// Contextual button sets that attach to bot responses
function mainMenuButtons() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Signals', callback_data: 'cmd:signals' },
        { text: '🔒 Arbs', callback_data: 'cmd:arb' },
        { text: '💎 Value', callback_data: 'cmd:value' },
      ],
      [
        { text: '🚨 Sharp', callback_data: 'cmd:sharp' },
        { text: '⚽ Soccer', callback_data: 'cmd:odds soccer today' },
        { text: '🏀 NBA', callback_data: 'cmd:odds nba' },
      ],
      [
        { text: '📈 Briefing', callback_data: 'cmd:briefing' },
        { text: '💰 Bankroll', callback_data: 'cmd:bankroll' },
        { text: '🔔 Alerts', callback_data: 'cmd:scanner' },
      ],
      [
        { text: '💳 Subscribe', callback_data: 'cmd:subscribe' },
        { text: '❓ Help', callback_data: 'cmd:help' },
      ],
    ],
  };
}

function postSignalButtons() {
  return {
    inline_keyboard: [
      [
        { text: '🔒 Arbs', callback_data: 'cmd:arb' },
        { text: '📉 Moves', callback_data: 'cmd:moves' },
        { text: '🔄 Refresh', callback_data: 'cmd:signals' },
      ],
      [
        { text: '💰 Kelly Calc', callback_data: 'cmd:kelly' },
        { text: '📊 Full Odds', callback_data: 'cmd:odds soccer today' },
      ],
    ],
  };
}

function postOddsButtons(sport) {
  return {
    inline_keyboard: [
      [
        { text: '💎 Value Bets', callback_data: 'cmd:value' },
        { text: '🔒 Arbs', callback_data: 'cmd:arb' },
        { text: '📊 Signals', callback_data: 'cmd:signals' },
      ],
      [
        { text: '🔄 Refresh', callback_data: `cmd:odds ${sport || 'soccer'} today` },
        { text: '📈 Briefing', callback_data: 'cmd:briefing' },
      ],
    ],
  };
}

function scannerButtons(isActive) {
  if (isActive) {
    return {
      inline_keyboard: [
        [
          { text: '⏸️ Pause Scanner', callback_data: 'cmd:scanner off' },
          { text: '📋 Leagues', callback_data: 'cmd:scanner leagues' },
        ],
        [
          { text: '📊 Stats', callback_data: 'cmd:scanner stats' },
          { text: '📈 Briefing', callback_data: 'cmd:briefing' },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: '✅ Turn On', callback_data: 'cmd:scanner on' },
        { text: '📋 Leagues', callback_data: 'cmd:scanner leagues' },
      ],
      [
        { text: '📈 Briefing', callback_data: 'cmd:briefing' },
        { text: '📊 Signals', callback_data: 'cmd:signals' },
      ],
    ],
  };
}

// Persistent reply keyboard — stays below the text input across messages.
// Buttons send plain text that the NLP router matches to commands, so they
// work in every language without needing per-language translations.
function mainKeyboard() {
  return {
    keyboard: [
      [{ text: '📊 Signals' }, { text: '🔒 Arbs' }],
      [{ text: '🎯 Value bets' }, { text: '💰 Bankroll' }],
      [{ text: '⚽ Soccer odds' }, { text: '🏀 NBA odds' }],
      [{ text: '💳 Subscribe' }, { text: '🎁 Refer' }],
      [{ text: '❓ Help' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Tap a button or type a question...',
  };
}

function welcomeButtons() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Signals', callback_data: 'cmd:signals' },
        { text: '🔒 Arbs', callback_data: 'cmd:arb' },
      ],
      [
        { text: '⚽ Soccer', callback_data: 'cmd:odds soccer today' },
        { text: '🏀 NBA', callback_data: 'cmd:odds nba' },
      ],
      [
        { text: '💳 Plans & Pricing', callback_data: 'cmd:subscribe' },
      ],
      [
        { text: '❓ Help', callback_data: 'cmd:help' },
        { text: 'ℹ️ About', callback_data: 'cmd:about' },
      ],
    ],
  };
}

// ============================================================
// --- CONVERSATIONAL MEMORY (per-user context tracking) ---
// ============================================================
// Remembers what each user last asked about so "any more?", "tomorrow?", "what about NBA?" works
const userContext = new Map(); // chatId -> { lastSport, lastCommand, lastEventId, timestamp }
// Evict stale context (>2h) every 30 minutes to bound memory.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of userContext) {
    if (!v?.timestamp || v.timestamp < cutoff) userContext.delete(k);
  }
}, 30 * 60 * 1000).unref();

function setUserContext(chatId, ctx) {
  userContext.set(String(chatId), { ...getUserContext(chatId), ...ctx, timestamp: Date.now() });
}
function getUserContext(chatId) {
  return userContext.get(String(chatId)) || { lastSport: null, lastCommand: null, lastEventId: null, timestamp: 0 };
}
// Context expires after 30 minutes of inactivity
function getActiveContext(chatId) {
  const ctx = getUserContext(chatId);
  if (Date.now() - ctx.timestamp > 30 * 60 * 1000) return { lastSport: null, lastCommand: null, lastEventId: null, timestamp: 0 };
  return ctx;
}

// ============================================================
// --- ONBOARDING TRACKER ---
// ============================================================
const ONBOARDED_FILE = stateFile('onboarded.json');
function loadOnboarded() { try { return JSON.parse(fs.readFileSync(ONBOARDED_FILE, 'utf8')); } catch { return {}; } }
function saveOnboarded(data) {
  const dir = path.dirname(ONBOARDED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(ONBOARDED_FILE, data, false);
}
function isOnboarded(chatId) { return !!loadOnboarded()[String(chatId)]; }
function markOnboarded(chatId) { const d = loadOnboarded(); d[String(chatId)] = Date.now(); saveOnboarded(d); }

// ============================================================
// --- LEGAL / TERMS ACCEPTANCE (GDPR + 18+ gambling compliance) ---
// ============================================================
const LEGAL_VERSION = '1.0';
const LEGAL_FILE = stateFile('legal_accept.json');
function loadLegal() { try { return JSON.parse(fs.readFileSync(LEGAL_FILE, 'utf8')); } catch { return {}; } }
function saveLegal(d) {
  const dir = path.dirname(LEGAL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(LEGAL_FILE, d);
}
function hasAcceptedLegal(chatId) {
  const rec = loadLegal()[String(chatId)];
  return rec && rec.version === LEGAL_VERSION;
}
function recordLegalAcceptance(chatId) {
  const d = loadLegal();
  d[String(chatId)] = { version: LEGAL_VERSION, acceptedAt: new Date().toISOString() };
  saveLegal(d);
}

// ============================================================
// --- RATE LIMITING (per-user sliding window) ---
// ============================================================
// Prevents free-tier users from exhausting Odds API quota via spam
const rateLimits = new Map(); // chatId -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 60_000;   // 1 minute
const RATE_LIMIT_FREE = 15;            // 15 requests/min for free tier
const RATE_LIMIT_PAID = 60;            // 60 requests/min for paid tiers
function checkRateLimit(chatId) {
  const now = Date.now();
  const tier = (typeof getUserTier === 'function') ? getUserTier(chatId) : 'free';
  const limit = tier === 'free' ? RATE_LIMIT_FREE : RATE_LIMIT_PAID;
  const rec = rateLimits.get(String(chatId));
  if (!rec || now - rec.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(String(chatId), { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (rec.count >= limit) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - rec.windowStart)) / 1000);
    return { allowed: false, retryAfter, limit };
  }
  rec.count++;
  return { allowed: true };
}

// Periodically evict stale rate-limit windows so the Map doesn't grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [k, v] of rateLimits) {
    if (v.windowStart < cutoff) rateLimits.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ============================================================
// --- GDPR DATA EXPORT / DELETION ---
// ============================================================
// Collects all user data across JSON files for /export and /delete commands
function collectUserData(chatId) {
  const key = String(chatId);
  const data = {};
  const files = {
    tasks: TASKS_FILE, sessions: SESSIONS_FILE, bankroll: BANKROLL_FILE,
    alerts: ALERTS_FILE, parlayHistory: HISTORY_FILE, clv: CLV_FILE,
    elo: ELO_FILE, tiers: TIERS_FILE, signals: SIGNALS_FILE,
    userSettings: USER_SETTINGS_FILE, subscriptions: SUBSCRIPTIONS_FILE,
    language: LANG_FILE, onboarded: ONBOARDED_FILE, legal: LEGAL_FILE,
  };
  for (const [name, file] of Object.entries(files)) {
    try {
      const all = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (all && all[key] !== undefined) data[name] = all[key];
    } catch {}
  }
  return data;
}
function deleteUserData(chatId) {
  const key = String(chatId);
  const files = [
    TASKS_FILE, SESSIONS_FILE, BANKROLL_FILE, ALERTS_FILE, HISTORY_FILE,
    CLV_FILE, ELO_FILE, TIERS_FILE, SIGNALS_FILE, USER_SETTINGS_FILE,
    SUBSCRIPTIONS_FILE, LANG_FILE, ONBOARDED_FILE, LEGAL_FILE,
  ];
  for (const file of files) {
    try {
      const all = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (all && all[key] !== undefined) {
        delete all[key];
        atomicWriteJson(file, all);
      }
    } catch {}
  }
  // Invalidate in-memory caches so deleted user's data doesn't linger.
  _userLangsCache = null;
  _tiersCache = null;
  _userSettingsCache = null;
  claudeSessions.delete(String(chatId));
  saveSessionsToFile();
  try {
    const scanner = loadScannerState();
    if (scanner && scanner.subscribers) {
      delete scanner.subscribers[key];
      saveScannerState(scanner);
    }
  } catch {}
}

// ============================================================
// --- RATE LIMIT GATE (one-line helper for command handlers) ---
// ============================================================
// Returns true if the request is allowed (command should proceed).
// Returns false if rate-limited — fires off a friendly i18n error message
// and the caller must abort. Safe to call from sync handlers.
function gateRate(msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return true;
  const check = checkRateLimit(chatId);
  if (check.allowed) return true;
  // Fire-and-forget: don't block the caller
  const reply = (T.err_rate_limit[getUserLang(chatId)] || T.err_rate_limit.en)
    .replace('{s}', check.retryAfter);
  bot.sendMessage(chatId, reply).catch(() => {});
  return false;
}

// ============================================================
// --- SAFE REPLY (friendly error handling) ---
// ============================================================
// Wraps bot.sendMessage with graceful error handling and markdown fallback.
// Use for all user-facing error messages to avoid leaking stack traces.
async function safeReply(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
  } catch (err) {
    try {
      const { parse_mode, ...plain } = opts;
      return await bot.sendMessage(chatId, text, plain);
    } catch (err2) {
      console.error(`[safeReply] Failed for ${chatId}:`, err2.message);
      return null;
    }
  }
}

// Escape Telegram legacy-Markdown special chars in user-controlled strings
// (team names, event outcomes, etc.) so they don't break formatting. Without
// this, a team like "Man *Utd*" would truncate the rendered message.
function escapeMd(s) {
  if (s == null) return '';
  return String(s).replace(/([_*`\[])/g, '\\$1');
}

// Friendly error reply: hides stack traces, uses i18n for known error classes.
async function replyError(chatId, err) {
  try {
    log.warn(`[err] chat=${chatId}`, err?.message || err);
    const key = err?.code === 'API_DOWN' ? 'err_api_down' : 'err_generic';
    return await safeReply(chatId, t(key, chatId));
  } catch (e) {
    console.error('[replyError] failed:', e?.message);
    return null;
  }
}

// ============================================================
// --- MULTILINGUAL SUPPORT ---
// ============================================================
const LANG_FILE = stateFile('user_langs.json');
// In-memory cache: t() is called 70+ times per request, and without caching
// every lookup was hitting fs.readFileSync + JSON.parse — a severe hot-path hit.
let _userLangsCache = null;
function loadUserLangs() {
  if (_userLangsCache) return _userLangsCache;
  try { _userLangsCache = JSON.parse(fs.readFileSync(LANG_FILE, 'utf8')); }
  catch { _userLangsCache = {}; }
  return _userLangsCache;
}
function saveUserLangs(d) {
  const dir = path.dirname(LANG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(LANG_FILE, d);
  _userLangsCache = d; // keep cache coherent with disk
}
function getUserLang(chatId) { return loadUserLangs()[String(chatId)] || 'en'; }
function setUserLang(chatId, lang) { const d = { ...loadUserLangs() }; d[String(chatId)] = lang; saveUserLangs(d); }

// Auto-detect language from Telegram profile on first message
function detectLangFromTelegram(msg) {
  const code = (msg.from?.language_code || '').slice(0, 2).toLowerCase();
  const supported = ['en','es','de','fr','it','pt','nl','hr','pl','tr','ro','cs','sk','sv','da','no'];
  return supported.includes(code) ? code : 'en';
}

// Language switch patterns — "speak spanish", "parle français", etc.
const LANG_SWITCH_PATTERNS = [
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(english|eng)\b/i, lang: 'en' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(spanish|español|espanol)\b/i, lang: 'es' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(german|deutsch)\b/i, lang: 'de' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(french|français|francais)\b/i, lang: 'fr' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(italian|italiano)\b/i, lang: 'it' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(portuguese|português|portugues)\b/i, lang: 'pt' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(dutch|nederlands)\b/i, lang: 'nl' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(croatian|hrvatski)\b/i, lang: 'hr' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(polish|polski)\b/i, lang: 'pl' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(turkish|türkçe|turkce)\b/i, lang: 'tr' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(romanian|română|romana)\b/i, lang: 'ro' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(czech|čeština|cestina)\b/i, lang: 'cs' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(slovak|slovenčina|slovencina|slovensky)\b/i, lang: 'sk' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(swedish|svenska)\b/i, lang: 'sv' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(danish|dansk)\b/i, lang: 'da' },
  { pattern: /\b(speak|switch.*to|change.*to|use)\s+(norwegian|norsk)\b/i, lang: 'no' },
  // Native language triggers
  { pattern: /^(en\s*español|habla\s*español|español)\s*$/i, lang: 'es' },
  { pattern: /^(auf\s*deutsch|sprich\s*deutsch|deutsch)\s*$/i, lang: 'de' },
  { pattern: /^(en\s*français|parle\s*français|français)\s*$/i, lang: 'fr' },
  { pattern: /^(in\s*italiano|parla\s*italiano|italiano)\s*$/i, lang: 'it' },
  { pattern: /^(em\s*português|fale\s*português|português)\s*$/i, lang: 'pt' },
  { pattern: /^(in\s*het\s*nederlands|nederlands)\s*$/i, lang: 'nl' },
  { pattern: /^(po\s*slovensky|slovensky|slovenčina)\s*$/i, lang: 'sk' },
  { pattern: /^(na\s*hrvatskom|hrvatski)\s*$/i, lang: 'hr' },
  { pattern: /^(po\s*polsku|polski)\s*$/i, lang: 'pl' },
];

// Translation strings — all UI text the bot outputs
const T = {
  // Greetings
  greeting_morning:    { en: 'Morning', es: 'Buenos días', de: 'Morgen', fr: 'Bonjour', it: 'Buongiorno', pt: 'Bom dia', nl: 'Goedemorgen', hr: 'Dobro jutro', pl: 'Dzień dobry', tr: 'Günaydın', ro: 'Bună dimineața', cs: 'Dobré ráno', sk: 'Dobré ráno', sv: 'God morgon', da: 'God morgen', no: 'God morgen' },
  greeting_afternoon:  { en: 'Hey', es: 'Hola', de: 'Hallo', fr: 'Salut', it: 'Ciao', pt: 'Olá', nl: 'Hoi', hr: 'Bok', pl: 'Cześć', tr: 'Merhaba', ro: 'Salut', cs: 'Ahoj', sk: 'Ahoj', sv: 'Hej', da: 'Hej', no: 'Hei' },
  greeting_evening:    { en: 'Evening', es: 'Buenas noches', de: 'Guten Abend', fr: 'Bonsoir', it: 'Buonasera', pt: 'Boa noite', nl: 'Goedenavond', hr: 'Dobra večer', pl: 'Dobry wieczór', tr: 'İyi akşamlar', ro: 'Bună seara', cs: 'Dobrý večer', sk: 'Dobrý večer', sv: 'God kväll', da: 'God aften', no: 'God kveld' },
  pulling_markets:     { en: "Let me pull up today's markets...", es: 'Déjame revisar los mercados de hoy...', de: 'Ich schaue mir die heutigen Märkte an...', fr: "Je regarde les marchés d'aujourd'hui...", it: 'Vediamo i mercati di oggi...', pt: 'Deixa-me ver os mercados de hoje...', nl: 'Even de markten van vandaag bekijken...', hr: 'Provjeravam današnje tržište...', pl: 'Sprawdzam dzisiejsze rynki...', tr: 'Bugünkü piyasalara bakayım...', ro: 'Să vedem piețele de azi...', cs: 'Podívám se na dnešní trhy...', sk: 'Pozriem sa na dnešné trhy...', sv: 'Låt mig kolla dagens marknader...', da: 'Lad mig tjekke dagens markeder...', no: 'La meg sjekke dagens markeder...' },
  glad_to_help:        { en: 'Glad to help! Just message me anytime.', es: '¡Me alegra ayudar! Escríbeme cuando quieras.', de: 'Gerne! Schreib mir jederzeit.', fr: "Avec plaisir ! Écris-moi quand tu veux.", it: 'Felice di aiutare! Scrivimi quando vuoi.', pt: 'Fico feliz em ajudar! Me manda mensagem quando quiser.', nl: 'Graag gedaan! Stuur me gerust een bericht.', hr: 'Drago mi je pomoći! Piši mi kad god želiš.', pl: 'Cieszę się, że mogę pomóc! Pisz kiedy chcesz.', tr: 'Yardımcı olabildiğime sevindim! İstediğin zaman yaz.', ro: 'Mă bucur că pot ajuta! Scrie-mi oricând.', cs: 'Rád pomůžu! Napiš mi kdykoliv.', sk: 'Rád pomôžem! Napíš mi kedykoľvek.', sv: 'Glad att hjälpa! Skriv när som helst.', da: 'Glad for at hjælpe! Skriv når som helst.', no: 'Glad for å hjelpe! Skriv når som helst.' },
  let_me_check:        { en: 'Let me check what the bookmakers think...', es: 'Déjame ver qué dicen las casas de apuestas...', de: 'Mal sehen, was die Buchmacher sagen...', fr: 'Voyons ce que disent les bookmakers...', it: 'Vediamo cosa dicono i bookmaker...', pt: 'Vamos ver o que as casas de apostas dizem...', nl: 'Even kijken wat de bookmakers zeggen...', hr: 'Da vidimo što kažu kladionice...', pl: 'Zobaczmy, co mówią bukmacherzy...', tr: 'Bakalım bahisçiler ne düşünüyor...', ro: 'Să vedem ce zic casele de pariuri...', cs: 'Podívejme se, co říkají sázkaři...', sk: 'Pozrime sa, čo hovoria stávkové kancelárie...', sv: 'Låt oss se vad spelbolagen säger...', da: 'Lad os se hvad bookmakerne siger...', no: 'La oss se hva bookmakerne sier...' },
  show_data:           { en: 'Let me show you what the data says...', es: 'Déjame mostrarte lo que dicen los datos...', de: 'Lass mich dir zeigen, was die Daten sagen...', fr: 'Laisse-moi te montrer ce que disent les données...', it: 'Ti mostro cosa dicono i dati...', pt: 'Vou te mostrar o que os dados dizem...', nl: 'Laat me je tonen wat de data zegt...', hr: 'Pokazat ću ti što kažu podaci...', pl: 'Pokażę ci, co mówią dane...', tr: 'Verilerin ne söylediğini göstereyim...', ro: 'Să-ți arăt ce spun datele...', cs: 'Ukážu ti, co říkají data...', sk: 'Ukážem ti, čo hovoria dáta...', sv: 'Låt mig visa dig vad datan säger...', da: 'Lad mig vise dig hvad dataen siger...', no: 'La meg vise deg hva dataene sier...' },
  not_sure:            { en: "I specialize in odds, arbs, and sharp money. Ask me about any team or sport and I'll show you the data.", es: 'Me especializo en cuotas, arbitraje y dinero inteligente. Pregúntame sobre cualquier equipo.', de: 'Ich bin spezialisiert auf Quoten, Arbs und Sharp Money. Frag mich nach jedem Team.', fr: "Je suis spécialisé dans les cotes, l'arbitrage et le sharp money. Demande-moi pour n'importe quelle équipe.", it: 'Sono specializzato in quote, arbitraggio e sharp money. Chiedimi di qualsiasi squadra.', pt: 'Sou especializado em odds, arbitragem e dinheiro esperto. Me pergunte sobre qualquer time.', nl: 'Ik ben gespecialiseerd in odds, arbs en sharp money. Vraag me over elk team.', hr: 'Specijaliziram se za kvote, arbitražu i pametni novac. Pitaj me o bilo kojem timu.', pl: 'Specjalizuję się w kursach, arbitrażu i smart money. Zapytaj o dowolny zespół.', tr: 'Oranlar, arbitraj ve akıllı para konusunda uzmanım. Herhangi bir takım hakkında sor.', ro: 'Sunt specializat în cote, arbitraj și bani deștepți. Întreabă-mă despre orice echipă.', cs: 'Specializuji se na kurzy, arbitráž a sharp money. Zeptej se na jakýkoli tým.', sk: 'Špecializujem sa na kurzy, arbitráž a sharp money. Spýtaj sa na akýkoľvek tím.', sv: 'Jag specialiserar mig på odds, arbs och sharp money. Fråga om vilket lag som helst.', da: 'Jeg specialiserer mig i odds, arbs og sharp money. Spørg om et hvilket som helst hold.', no: 'Jeg spesialiserer meg på odds, arbs og sharp money. Spør meg om et hvilket som helst lag.' },
  lang_changed:        { en: 'Switched to English 🇬🇧', es: 'Cambiado a español 🇪🇸', de: 'Auf Deutsch umgestellt 🇩🇪', fr: 'Passé au français 🇫🇷', it: 'Cambiato in italiano 🇮🇹', pt: 'Mudado para português 🇵🇹', nl: 'Overgeschakeld naar Nederlands 🇳🇱', hr: 'Prebačeno na hrvatski 🇭🇷', pl: 'Zmieniono na polski 🇵🇱', tr: 'Türkçeye geçildi 🇹🇷', ro: 'Schimbat în română 🇷🇴', cs: 'Přepnuto do češtiny 🇨🇿', sk: 'Prepnuté na slovenčinu 🇸🇰', sv: 'Bytte till svenska 🇸🇪', da: 'Skiftet til dansk 🇩🇰', no: 'Byttet til norsk 🇳🇴' },
  // Welcome / onboarding
  welcome:             { en: 'welcome to *Ruflo*', es: 'bienvenido a *Ruflo*', de: 'willkommen bei *Ruflo*', fr: 'bienvenue sur *Ruflo*', it: 'benvenuto su *Ruflo*', pt: 'bem-vindo ao *Ruflo*', nl: 'welkom bij *Ruflo*', hr: 'dobrodošao na *Ruflo*', pl: 'witaj w *Ruflo*', tr: "*Ruflo*'ya hoş geldin", ro: 'bine ai venit la *Ruflo*', cs: 'vítej v *Ruflo*', sk: 'vitaj v *Ruflo*', sv: 'välkommen till *Ruflo*', da: 'velkommen til *Ruflo*', no: 'velkommen til *Ruflo*' },
  scan_description:    { en: 'I scan 40+ bookmakers and find you profitable opportunities.', es: 'Escaneo más de 40 casas de apuestas y encuentro oportunidades rentables.', de: 'Ich scanne 40+ Buchmacher und finde profitable Gelegenheiten.', fr: "J'analyse plus de 40 bookmakers et trouve des opportunités rentables.", it: 'Analizzo 40+ bookmaker e trovo opportunità redditizie.', pt: 'Eu analiso 40+ casas de apostas e encontro oportunidades lucrativas.', nl: 'Ik scan 40+ bookmakers en vind winstgevende kansen.', hr: 'Skeniram 40+ kladionica i pronalazim profitabilne prilike.', pl: 'Skanuję 40+ bukmacherów i znajduję zyskowne okazje.', tr: "40'tan fazla bahis sitesini tarıyor ve kârlı fırsatlar buluyorum.", ro: 'Scanez 40+ case de pariuri și găsesc oportunități profitabile.', cs: 'Skenuji 40+ sázkových kanceláří a hledám ziskové příležitosti.', sk: 'Skenujem 40+ stávkových kancelárií a hľadám ziskové príležitosti.', sv: 'Jag skannar 40+ spelbolag och hittar lönsamma möjligheter.', da: 'Jeg scanner 40+ bookmakere og finder profitable muligheder.', no: 'Jeg skanner 40+ bookmakere og finner lønnsomme muligheter.' },
  just_message:        { en: "Just message me like you'd text a friend:", es: 'Escríbeme como le escribirías a un amigo:', de: 'Schreib mir einfach wie einem Freund:', fr: "Écris-moi comme à un ami :", it: 'Scrivimi come scriveresti a un amico:', pt: 'Me manda mensagem como mandaria para um amigo:', nl: 'Stuur me een bericht zoals je aan een vriend zou schrijven:', hr: 'Piši mi kao da pišeš prijatelju:', pl: 'Pisz do mnie jak do znajomego:', tr: 'Bana arkadaşına yazar gibi yaz:', ro: 'Scrie-mi ca și cum ai scrie unui prieten:', cs: 'Napiš mi jako kamarádovi:', sk: 'Napíš mi ako kamarátovi:', sv: 'Skriv till mig som till en vän:', da: 'Skriv til mig som til en ven:', no: 'Skriv til meg som til en venn:' },
  pick_sports:         { en: 'Pick your sports and I\'ll get started:', es: 'Elige tus deportes y empezamos:', de: 'Wähle deine Sportarten und los geht\'s:', fr: 'Choisis tes sports et on commence :', it: 'Scegli i tuoi sport e iniziamo:', pt: 'Escolha seus esportes e vamos começar:', nl: 'Kies je sporten en we beginnen:', hr: 'Odaberi sportove i krećemo:', pl: 'Wybierz sporty i zaczynamy:', tr: 'Sporlarını seç ve başlayalım:', ro: 'Alege sporturile și începem:', cs: 'Vyber si sporty a začneme:', sk: 'Vyber si športy a začneme:', sv: 'Välj dina sporter och vi sätter igång:', da: 'Vælg dine sportsgrene og vi starter:', no: 'Velg dine idretter og vi starter:' },
  // Buttons
  btn_signals:         { en: "Today's signals", es: 'Señales de hoy', de: 'Heutige Signale', fr: "Signaux d'aujourd'hui", it: 'Segnali di oggi', pt: 'Sinais de hoje', nl: 'Signalen van vandaag', hr: 'Današnji signali', pl: 'Dzisiejsze sygnały', tr: 'Bugünün sinyalleri', ro: 'Semnalele de azi', cs: 'Dnešní signály', sk: 'Dnešné signály', sv: 'Dagens signaler', da: 'Dagens signaler', no: 'Dagens signaler' },
  btn_more_signals:    { en: 'More signals', es: 'Más señales', de: 'Mehr Signale', fr: 'Plus de signaux', it: 'Altri segnali', pt: 'Mais sinais', nl: 'Meer signalen', hr: 'Više signala', pl: 'Więcej sygnałów', tr: 'Daha fazla sinyal', ro: 'Mai multe semnale', cs: 'Více signálů', sk: 'Viac signálov', sv: 'Fler signaler', da: 'Flere signaler', no: 'Flere signaler' },
  btn_check_arbs:      { en: 'Check arbs', es: 'Ver arbitrajes', de: 'Arbs prüfen', fr: 'Voir arbitrages', it: 'Vedi arbitraggi', pt: 'Ver arbitragens', nl: 'Arbs bekijken', hr: 'Provjeri arbitraže', pl: 'Sprawdź arbitraże', tr: 'Arbitrajları kontrol et', ro: 'Verifică arbitrajele', cs: 'Zkontrolovat arby', sk: 'Skontrolovať arby', sv: 'Kolla arbs', da: 'Tjek arbs', no: 'Sjekk arbs' },
  btn_show_me:         { en: 'Yes, show me', es: 'Sí, muéstrame', de: 'Ja, zeig mir', fr: 'Oui, montre-moi', it: 'Sì, mostrami', pt: 'Sim, me mostre', nl: 'Ja, laat zien', hr: 'Da, pokaži mi', pl: 'Tak, pokaż mi', tr: 'Evet, göster', ro: 'Da, arată-mi', cs: 'Ano, ukaž mi', sk: 'Áno, ukáž mi', sv: 'Ja, visa mig', da: 'Ja, vis mig', no: 'Ja, vis meg' },
  btn_plans:           { en: 'Plans & pricing', es: 'Planes y precios', de: 'Pläne & Preise', fr: 'Plans & tarifs', it: 'Piani & prezzi', pt: 'Planos & preços', nl: 'Plannen & prijzen', hr: 'Planovi i cijene', pl: 'Plany i ceny', tr: 'Planlar ve fiyatlar', ro: 'Planuri și prețuri', cs: 'Plány a ceny', sk: 'Plány a ceny', sv: 'Planer & priser', da: 'Planer & priser', no: 'Planer & priser' },
  // Demo
  demo_sample:         { en: 'This is sample data — ask "subscribe" for live markets from 40+ bookmakers', es: 'Estos son datos de muestra — di "suscribirse" para mercados en vivo', de: 'Dies sind Beispieldaten — sag "abonnieren" für Live-Märkte', fr: 'Ce sont des données exemples — dis "abonner" pour les marchés en direct', it: 'Questi sono dati di esempio — dì "abbonati" per i mercati dal vivo', pt: 'Estes são dados de exemplo — diga "assinar" para mercados ao vivo', nl: 'Dit zijn voorbeeldgegevens — zeg "abonneren" voor live markten', hr: 'Ovo su primjeri podataka — reci "pretplata" za žive tržišne podatke', pl: 'To przykładowe dane — napisz "subskrypcja" dla rynków na żywo', tr: 'Bu örnek veriler — canlı piyasalar için "abone ol" yazın', ro: 'Acestea sunt date exemplu — spune "abonare" pentru piețe live', cs: 'Toto jsou ukázková data — řekni "předplatné" pro živé trhy', sk: 'Toto sú ukážkové dáta — napíš "predplatné" pre živé trhy', sv: 'Detta är exempeldata — skriv "prenumerera" för live-marknader', da: 'Dette er eksempeldata — skriv "abonner" for live-markeder', no: 'Dette er eksempeldata — skriv "abonner" for live-markeder' },
  // Value/signals
  value_bets:          { en: 'Value Bets', es: 'Apuestas de valor', de: 'Value-Wetten', fr: 'Paris de valeur', it: 'Scommesse di valore', pt: 'Apostas de valor', nl: 'Waardeweddenschappen', hr: 'Value oklade', pl: 'Zakłady wartościowe', tr: 'Değer bahisleri', ro: 'Pariuri de valoare', cs: 'Hodnotové sázky', sk: 'Hodnotové stávky', sv: 'Värdespel', da: 'Værdispil', no: 'Verdispill' },
  sharp_move:          { en: 'Sharp Move', es: 'Movimiento sharp', de: 'Sharp-Bewegung', fr: 'Mouvement sharp', it: 'Movimento sharp', pt: 'Movimento sharp', nl: 'Sharp beweging', hr: 'Sharp pomak', pl: 'Ruch sharp', tr: 'Sharp hareket', ro: 'Mișcare sharp', cs: 'Sharp pohyb', sk: 'Sharp pohyb', sv: 'Sharp rörelse', da: 'Sharp bevægelse', no: 'Sharp bevegelse' },
  no_arbs:             { en: 'No arbitrage opportunities right now.', es: 'No hay oportunidades de arbitraje ahora.', de: 'Keine Arbitrage-Möglichkeiten im Moment.', fr: "Pas d'opportunités d'arbitrage pour le moment.", it: 'Nessuna opportunità di arbitraggio al momento.', pt: 'Nenhuma oportunidade de arbitragem no momento.', nl: 'Geen arbitrage-mogelijkheden op dit moment.', hr: 'Trenutno nema arbitražnih prilika.', pl: 'Brak okazji arbitrażowych w tej chwili.', tr: 'Şu anda arbitraj fırsatı yok.', ro: 'Nicio oportunitate de arbitraj momentan.', cs: 'Žádné arbitrážní příležitosti momentálně.', sk: 'Žiadne arbitrážne príležitosti momentálne.', sv: 'Inga arbitragemöjligheter just nu.', da: 'Ingen arbitragemuligheder lige nu.', no: 'Ingen arbitrasjemuligheter akkurat nå.' },
  events_scanned:      { en: 'events across', es: 'eventos en', de: 'Events in', fr: 'événements dans', it: 'eventi in', pt: 'eventos em', nl: 'evenementen in', hr: 'događaja u', pl: 'wydarzeń w', tr: 'etkinlik', ro: 'evenimente în', cs: 'událostí v', sk: 'udalostí v', sv: 'event i', da: 'begivenheder i', no: 'hendelser i' },
  leagues:             { en: 'leagues', es: 'ligas', de: 'Ligen', fr: 'ligues', it: 'campionati', pt: 'ligas', nl: 'competities', hr: 'liga', pl: 'ligach', tr: 'lig', ro: 'ligi', cs: 'ligách', sk: 'ligách', sv: 'ligor', da: 'ligaer', no: 'ligaer' },
  here_found:          { en: "Here's what I found", es: 'Esto es lo que encontré', de: 'Das habe ich gefunden', fr: "Voici ce que j'ai trouvé", it: 'Ecco cosa ho trovato', pt: 'Aqui está o que encontrei', nl: 'Dit heb ik gevonden', hr: 'Evo što sam pronašao', pl: 'Oto co znalazłem', tr: 'İşte bulduklarım', ro: 'Iată ce am găsit', cs: 'Tady je co jsem našel', sk: 'Tu je čo som našiel', sv: 'Här är vad jag hittade', da: 'Her er hvad jeg fandt', no: 'Her er hva jeg fant' },
  smart_money_backing: { en: 'Smart money backing', es: 'Dinero inteligente en', de: 'Smart Money auf', fr: "L'argent intelligent mise sur", it: 'Smart money su', pt: 'Dinheiro inteligente em', nl: 'Smart money op', hr: 'Pametni novac na', pl: 'Smart money na', tr: 'Akıllı para', ro: 'Banii deștepți pe', cs: 'Smart money na', sk: 'Smart money na', sv: 'Smart money på', da: 'Smart money på', no: 'Smart money på' },
  // Welcome greeting (before legal gate)
  welcome_greeting:    { en: 'Welcome to Ruflo', es: 'Bienvenido a Ruflo', de: 'Willkommen bei Ruflo', fr: 'Bienvenue sur Ruflo', it: 'Benvenuto su Ruflo', pt: 'Bem-vindo ao Ruflo', nl: 'Welkom bij Ruflo', hr: 'Dobrodošao na Ruflo', pl: 'Witaj w Ruflo', tr: "Ruflo'ya hoş geldin", ro: 'Bine ai venit la Ruflo', cs: 'Vítej v Ruflo', sk: 'Vitaj v Ruflo', sv: 'Välkommen till Ruflo', da: 'Velkommen til Ruflo', no: 'Velkommen til Ruflo' },
  welcome_quick_things:{ en: 'Before we get started, a few quick things:', es: 'Antes de empezar, unas cosas rápidas:', de: 'Bevor wir loslegen, ein paar Dinge:', fr: 'Avant de commencer, quelques petites choses :', it: 'Prima di iniziare, alcune cose veloci:', pt: 'Antes de começar, algumas coisas rápidas:', nl: 'Voordat we beginnen, een paar dingetjes:', hr: 'Prije nego krenemo, par brzih stvari:', pl: 'Zanim zaczniemy, kilka szybkich rzeczy:', tr: 'Başlamadan önce birkaç hızlı bilgi:', ro: 'Înainte să începem, câteva lucruri rapide:', cs: 'Než začneme, pár věcí:', sk: 'Skôr ako začneme, pár vecí:', sv: 'Innan vi börjar, några snabba saker:', da: 'Før vi starter, et par hurtige ting:', no: 'Før vi starter, noen raske ting:' },
  // Legal & compliance
  legal_title:         { en: '*Before we start*', es: '*Antes de empezar*', de: '*Bevor wir starten*', fr: '*Avant de commencer*', it: '*Prima di iniziare*', pt: '*Antes de começar*', nl: '*Voordat we beginnen*', hr: '*Prije nego započnemo*', pl: '*Zanim zaczniemy*', tr: '*Başlamadan önce*', ro: '*Înainte să începem*', cs: '*Než začneme*', sk: '*Skôr ako začneme*', sv: '*Innan vi börjar*', da: '*Før vi starter*', no: '*Før vi starter*' },
  legal_18_plus:       { en: '🔞 You must be 18+ (or legal age in your jurisdiction) to use Ruflo.', es: '🔞 Debes tener 18+ (o la edad legal en tu jurisdicción) para usar Ruflo.', de: '🔞 Du musst 18+ sein (oder das gesetzliche Alter in deiner Region).', fr: '🔞 Tu dois avoir 18+ (ou l\'âge légal dans ta juridiction).', it: '🔞 Devi avere 18+ (o l\'età legale nella tua giurisdizione).', pt: '🔞 Deves ter 18+ (ou a idade legal na tua jurisdição).', nl: '🔞 Je moet 18+ zijn (of de wettelijke leeftijd in je regio).', hr: '🔞 Moraš imati 18+ godina (ili zakonsku dob u tvojoj zemlji).', pl: '🔞 Musisz mieć 18+ lat (lub legalny wiek w twoim kraju).', tr: '🔞 18 yaşında veya ülkende yasal yaşta olmalısın.', ro: '🔞 Trebuie să ai 18+ (sau vârsta legală în jurisdicția ta).', cs: '🔞 Musíš být 18+ (nebo legální věk ve tvé zemi).', sk: '🔞 Musíš mať 18+ (alebo zákonný vek vo svojej krajine).', sv: '🔞 Du måste vara 18+ (eller laglig ålder i din region).', da: '🔞 Du skal være 18+ (eller lovlig alder i dit område).', no: '🔞 Du må være 18+ (eller lovlig alder i ditt område).' },
  legal_risk:          { en: '⚠️ Sports betting involves risk. Ruflo provides data and analysis — never bet more than you can afford to lose.', es: '⚠️ Las apuestas deportivas implican riesgo. Ruflo ofrece datos y análisis — nunca apuestes más de lo que puedas permitirte perder.', de: '⚠️ Sportwetten beinhalten Risiko. Ruflo liefert Daten und Analysen — setze nie mehr, als du dir leisten kannst zu verlieren.', fr: '⚠️ Les paris sportifs comportent des risques. Ruflo fournit des données et analyses — ne pariez jamais plus que vous ne pouvez vous permettre de perdre.', it: '⚠️ Le scommesse sportive comportano rischi. Ruflo fornisce dati e analisi — non scommettere mai più di quanto ti puoi permettere di perdere.', pt: '⚠️ Apostas desportivas envolvem risco. Ruflo fornece dados e análise — nunca apostes mais do que podes perder.', nl: '⚠️ Sportwedden brengt risico met zich mee. Ruflo biedt data en analyse — zet nooit meer in dan je kunt missen.', hr: '⚠️ Sportsko klađenje uključuje rizik. Ruflo pruža podatke i analizu — nikad ne kladi više nego što možeš izgubiti.', pl: '⚠️ Zakłady sportowe wiążą się z ryzykiem. Ruflo dostarcza dane i analizę — nigdy nie stawiaj więcej niż możesz stracić.', tr: '⚠️ Spor bahisleri risk içerir. Ruflo veri ve analiz sağlar — kaybetmeyi göze alamayacağın kadar bahis oynama.', ro: '⚠️ Pariurile sportive implică risc. Ruflo oferă date și analiză — nu paria niciodată mai mult decât îți permiți să pierzi.', cs: '⚠️ Sportovní sázení zahrnuje riziko. Ruflo poskytuje data a analýzu — nesázej víc, než si můžeš dovolit ztratit.', sk: '⚠️ Športové stávkovanie zahŕňa riziko. Ruflo poskytuje dáta a analýzu — nestav viac, než si môžeš dovoliť stratiť.', sv: '⚠️ Sportspel innebär risk. Ruflo ger data och analys — spela aldrig mer än du har råd att förlora.', da: '⚠️ Sportsspil indebærer risiko. Ruflo leverer data og analyse — spil aldrig mere end du har råd til at tabe.', no: '⚠️ Sportsspill innebærer risiko. Ruflo gir data og analyse — spill aldri mer enn du har råd til å tape.' },
  legal_nodata:        { en: '📊 Ruflo is an information service — not a bookmaker. We don\'t take bets.', es: '📊 Ruflo es un servicio de información — no una casa de apuestas. No aceptamos apuestas.', de: '📊 Ruflo ist ein Informationsdienst — kein Buchmacher. Wir nehmen keine Wetten an.', fr: '📊 Ruflo est un service d\'information — pas un bookmaker. Nous ne prenons pas de paris.', it: '📊 Ruflo è un servizio di informazione — non un bookmaker. Non accettiamo scommesse.', pt: '📊 Ruflo é um serviço de informação — não uma casa de apostas. Não aceitamos apostas.', nl: '📊 Ruflo is een informatiedienst — geen bookmaker. We nemen geen weddenschappen aan.', hr: '📊 Ruflo je informacijska usluga — ne kladionica. Ne primamo oklade.', pl: '📊 Ruflo to serwis informacyjny — nie bukmacher. Nie przyjmujemy zakładów.', tr: '📊 Ruflo bir bilgi hizmetidir — bahis sitesi değil. Bahis kabul etmeyiz.', ro: '📊 Ruflo este un serviciu de informare — nu casă de pariuri. Nu acceptăm pariuri.', cs: '📊 Ruflo je informační služba — ne sázková kancelář. Sázky nepřijímáme.', sk: '📊 Ruflo je informačná služba — nie stávková kancelária. Stávky neprijímame.', sv: '📊 Ruflo är en informationstjänst — inte en bookmaker. Vi tar inte emot spel.', da: '📊 Ruflo er en informationstjeneste — ikke en bookmaker. Vi tager ikke imod spil.', no: '📊 Ruflo er en informasjonstjeneste — ikke en bookmaker. Vi tar ikke imot spill.' },
  legal_gdpr:          { en: '🔒 By continuing you accept our Terms and Privacy Policy. Use /export to download your data or /delete to remove it.', es: '🔒 Al continuar aceptas nuestros Términos y Política de Privacidad. Usa /export para descargar tus datos o /delete para eliminarlos.', de: '🔒 Mit Fortfahren akzeptierst du unsere AGB und Datenschutzerklärung. Nutze /export oder /delete.', fr: '🔒 En continuant, tu acceptes nos Conditions et Politique de confidentialité. Utilise /export ou /delete.', it: '🔒 Continuando accetti i nostri Termini e la Privacy Policy. Usa /export o /delete.', pt: '🔒 Ao continuar aceitas os nossos Termos e Política de Privacidade. Usa /export ou /delete.', nl: '🔒 Door verder te gaan accepteer je onze Voorwaarden en Privacybeleid. Gebruik /export of /delete.', hr: '🔒 Nastavkom prihvaćaš naše Uvjete i Pravila privatnosti. Koristi /export ili /delete.', pl: '🔒 Kontynuując akceptujesz nasz Regulamin i Politykę Prywatności. Użyj /export lub /delete.', tr: '🔒 Devam ederek Şartlar ve Gizlilik Politikamızı kabul ediyorsun. /export veya /delete kullan.', ro: '🔒 Continuând accepți Termenii și Politica de Confidențialitate. Folosește /export sau /delete.', cs: '🔒 Pokračováním přijímáš naše Podmínky a Zásady ochrany soukromí. Použij /export nebo /delete.', sk: '🔒 Pokračovaním prijímaš naše Podmienky a Zásady ochrany súkromia. Použi /export alebo /delete.', sv: '🔒 Genom att fortsätta accepterar du våra Villkor och Integritetspolicy. Använd /export eller /delete.', da: '🔒 Ved at fortsætte accepterer du vores Vilkår og Privatlivspolitik. Brug /export eller /delete.', no: '🔒 Ved å fortsette godtar du våre Vilkår og Personvern. Bruk /export eller /delete.' },
  legal_accept:        { en: '✅ I am 18+ and accept', es: '✅ Tengo 18+ y acepto', de: '✅ Ich bin 18+ und akzeptiere', fr: '✅ J\'ai 18+ et j\'accepte', it: '✅ Ho 18+ e accetto', pt: '✅ Tenho 18+ e aceito', nl: '✅ Ik ben 18+ en accepteer', hr: '✅ Imam 18+ i prihvaćam', pl: '✅ Mam 18+ i akceptuję', tr: '✅ 18+ yaşımdayım ve kabul ediyorum', ro: '✅ Am 18+ și accept', cs: '✅ Jsem 18+ a přijímám', sk: '✅ Mám 18+ a súhlasím', sv: '✅ Jag är 18+ och accepterar', da: '✅ Jeg er 18+ og accepterer', no: '✅ Jeg er 18+ og godtar' },
  legal_decline:       { en: '❌ Decline', es: '❌ Rechazar', de: '❌ Ablehnen', fr: '❌ Refuser', it: '❌ Rifiuta', pt: '❌ Recusar', nl: '❌ Weigeren', hr: '❌ Odbij', pl: '❌ Odrzuć', tr: '❌ Reddet', ro: '❌ Refuz', cs: '❌ Odmítnout', sk: '❌ Odmietnuť', sv: '❌ Avböj', da: '❌ Afvis', no: '❌ Avslå' },
  legal_declined:      { en: 'You must accept the Terms to use Ruflo. Type /start when ready.', es: 'Debes aceptar los Términos para usar Ruflo. Escribe /start cuando estés listo.', de: 'Du musst die AGB akzeptieren, um Ruflo zu nutzen. /start wenn bereit.', fr: 'Tu dois accepter les Conditions pour utiliser Ruflo. /start quand prêt.', it: 'Devi accettare i Termini per usare Ruflo. /start quando pronto.', pt: 'Deves aceitar os Termos para usar Ruflo. /start quando estiveres pronto.', nl: 'Je moet de Voorwaarden accepteren om Ruflo te gebruiken. /start wanneer klaar.', hr: 'Moraš prihvatiti Uvjete za korištenje Ruflo. /start kad budeš spreman.', pl: 'Musisz zaakceptować Regulamin aby używać Ruflo. /start gdy gotów.', tr: 'Ruflo\'yu kullanmak için Şartları kabul etmelisin. Hazır olduğunda /start.', ro: 'Trebuie să accepți Termenii pentru a folosi Ruflo. /start când ești gata.', cs: 'Musíš přijmout Podmínky pro používání Ruflo. /start až budeš připraven.', sk: 'Musíš prijať Podmienky pre používanie Ruflo. /start keď budeš pripravený.', sv: 'Du måste acceptera Villkoren för att använda Ruflo. /start när du är redo.', da: 'Du skal acceptere Vilkårene for at bruge Ruflo. /start når du er klar.', no: 'Du må godta Vilkårene for å bruke Ruflo. /start når du er klar.' },
  // Errors
  err_rate_limit:      { en: '⏳ Slow down — you\'re sending too many requests. Try again in {s}s.', es: '⏳ Más despacio — demasiadas solicitudes. Intenta en {s}s.', de: '⏳ Zu viele Anfragen. Versuche es in {s}s erneut.', fr: '⏳ Ralentis — trop de requêtes. Réessaie dans {s}s.', it: '⏳ Rallenta — troppe richieste. Riprova tra {s}s.', pt: '⏳ Mais devagar — demasiados pedidos. Tenta em {s}s.', nl: '⏳ Rustig aan — te veel verzoeken. Probeer over {s}s.', hr: '⏳ Uspori — previše zahtjeva. Pokušaj za {s}s.', pl: '⏳ Zwolnij — za dużo żądań. Spróbuj za {s}s.', tr: '⏳ Yavaşla — çok fazla istek. {s}s sonra dene.', ro: '⏳ Mai încet — prea multe cereri. Încearcă în {s}s.', cs: '⏳ Zpomal — příliš požadavků. Zkus za {s}s.', sk: '⏳ Spomal — príliš veľa požiadaviek. Skús za {s}s.', sv: '⏳ Sakta ner — för många förfrågningar. Försök om {s}s.', da: '⏳ Sænk farten — for mange forespørgsler. Prøv om {s}s.', no: '⏳ Sakte ned — for mange forespørsler. Prøv om {s}s.' },
  err_generic:         { en: 'Something went wrong. Please try again in a moment.', es: 'Algo salió mal. Inténtalo de nuevo.', de: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.', fr: 'Quelque chose s\'est mal passé. Réessaie.', it: 'Qualcosa è andato storto. Riprova.', pt: 'Algo correu mal. Tenta novamente.', nl: 'Er ging iets mis. Probeer opnieuw.', hr: 'Nešto je pošlo po zlu. Pokušaj ponovno.', pl: 'Coś poszło nie tak. Spróbuj ponownie.', tr: 'Bir şeyler ters gitti. Tekrar dene.', ro: 'Ceva n-a mers. Încearcă din nou.', cs: 'Něco se pokazilo. Zkus to znovu.', sk: 'Niečo sa pokazilo. Skús znova.', sv: 'Något gick fel. Försök igen.', da: 'Noget gik galt. Prøv igen.', no: 'Noe gikk galt. Prøv igjen.' },
  err_api_down:        { en: '📡 The odds feed is temporarily unavailable. Try again in a minute.', es: '📡 El feed de cuotas no está disponible. Intenta en un minuto.', de: '📡 Der Quoten-Feed ist vorübergehend nicht verfügbar.', fr: '📡 Le flux de cotes est temporairement indisponible.', it: '📡 Il feed delle quote è temporaneamente non disponibile.', pt: '📡 O feed de odds está temporariamente indisponível.', nl: '📡 De odds-feed is tijdelijk niet beschikbaar.', hr: '📡 Feed kvota trenutno nije dostupan.', pl: '📡 Kanał kursów tymczasowo niedostępny.', tr: '📡 Oran akışı geçici olarak kullanılamıyor.', ro: '📡 Feed-ul de cote este temporar indisponibil.', cs: '📡 Zdroj kurzů je dočasně nedostupný.', sk: '📡 Zdroj kurzov je dočasne nedostupný.', sv: '📡 Odds-flödet är tillfälligt otillgängligt.', da: '📡 Odds-feedet er midlertidigt utilgængeligt.', no: '📡 Odds-feeden er midlertidig utilgjengelig.' },
  // Trial
  trial_cta:           { en: '🎁 *7-day free trial of Plus*\n\nFull access to value signals, arbitrage scanner, sharp money tracking and steam alerts — free for 7 days.\n\nNo charge today. Your card is only billed when the trial ends.\nCancel anytime with /billing.', es: '🎁 *Prueba gratis de 7 días de Plus*\n\nAcceso completo a señales de valor, escáner de arbitraje, seguimiento de dinero sharp y alertas steam — gratis 7 días.\n\nSin cargo hoy. Solo se cobra al terminar la prueba.\nCancela cuando quieras con /billing.', de: '🎁 *7 Tage Plus kostenlos testen*\n\nVoller Zugriff auf Value-Signale, Arbitrage-Scanner, Sharp-Money und Steam-Alerts — 7 Tage gratis.\n\nHeute keine Abbuchung. Erst nach Ende der Testphase.\nJederzeit mit /billing kündbar.', fr: '🎁 *Essai gratuit de 7 jours de Plus*\n\nAccès complet aux signaux de valeur, scanner d\'arbitrage, sharp money et alertes steam — 7 jours offerts.\n\nAucun débit aujourd\'hui. Prélèvement à la fin de l\'essai.\nRésilie à tout moment avec /billing.', it: '🎁 *Prova gratuita di 7 giorni di Plus*\n\nAccesso completo a segnali di valore, scanner di arbitraggio, sharp money e steam alert — 7 giorni gratis.\n\nNessun addebito oggi. Verrai addebitato solo a fine prova.\nDisdici quando vuoi con /billing.', pt: '🎁 *Teste grátis de 7 dias do Plus*\n\nAcesso total a sinais de valor, scanner de arbitragem, sharp money e alertas steam — 7 dias grátis.\n\nSem cobrança hoje. Só te cobramos no fim do teste.\nCancela quando quiseres com /billing.', nl: '🎁 *7 dagen gratis Plus*\n\nVolledige toegang tot value-signalen, arbitrage-scanner, sharp money en steam-alerts — 7 dagen gratis.\n\nVandaag geen kosten. Pas na de trial word je afgeschreven.\nAltijd te stoppen met /billing.', hr: '🎁 *Besplatna 7-dnevna proba Plusa*\n\nPuni pristup value signalima, arbitražnom skeneru, sharp novcu i steam upozorenjima — 7 dana besplatno.\n\nDanas nema naplate. Naplaćujemo tek na kraju probe.\nOtkaži bilo kad preko /billing.', pl: '🎁 *7 dni Plus za darmo*\n\nPełny dostęp do sygnałów wartości, skanera arbitrażu, sharp money i alertów steam — 7 dni gratis.\n\nDziś bez opłat. Pobieramy dopiero po zakończeniu próby.\nAnuluj kiedy chcesz przez /billing.', tr: '🎁 *7 günlük ücretsiz Plus denemesi*\n\nDeğer sinyalleri, arbitraj tarayıcı, sharp para ve steam uyarılarına tam erişim — 7 gün ücretsiz.\n\nBugün ücret yok. Ücret yalnızca deneme bitince alınır.\n/billing ile istediğin zaman iptal edebilirsin.', ro: '🎁 *Test gratuit Plus 7 zile*\n\nAcces complet la semnale de valoare, scaner de arbitraj, sharp money și alerte steam — 7 zile gratis.\n\nFără taxe azi. Cardul e taxat doar la finalul perioadei de test.\nAnulează oricând cu /billing.', cs: '🎁 *7denní zkušební verze Plus zdarma*\n\nPlný přístup k value signálům, arbitrážnímu skeneru, sharp money a steam upozorněním — 7 dní zdarma.\n\nDnes bez platby. Karta bude stržena až po skončení zkoušky.\nZruš kdykoli přes /billing.', sk: '🎁 *7-dňová skúšobná verzia Plus zdarma*\n\nPlný prístup k value signálom, arbitrážnemu skeneru, sharp money a steam upozorneniam — 7 dní zdarma.\n\nDnes bez platby. Karta sa strhne až po skončení skúšky.\nZruš kedykoľvek cez /billing.', sv: '🎁 *7 dagars gratis Plus*\n\nFull åtkomst till värdesignaler, arbitrage-scanner, sharp money och steam-varningar — 7 dagar gratis.\n\nIngen debitering idag. Kortet dras först när provperioden slutar.\nAvsluta när som helst via /billing.', da: '🎁 *7 dages gratis Plus*\n\nFuld adgang til værdisignaler, arbitrage-scanner, sharp money og steam-alarmer — 7 dage gratis.\n\nIngen betaling i dag. Kortet trækkes først ved prøveperiodens slutning.\nAnnuller når som helst via /billing.', no: '🎁 *7 dagers gratis Plus*\n\nFull tilgang til verdisignaler, arbitrage-skanner, sharp money og steam-varsler — 7 dager gratis.\n\nIngen belastning i dag. Kortet trekkes først når prøveperioden er over.\nAvbryt når som helst via /billing.' },
  trial_button:        { en: '🎁 Start free trial', es: '🎁 Iniciar prueba gratis', de: '🎁 Test starten', fr: '🎁 Démarrer l\'essai', it: '🎁 Inizia prova gratis', pt: '🎁 Iniciar teste grátis', nl: '🎁 Start gratis trial', hr: '🎁 Pokreni besplatnu probu', pl: '🎁 Rozpocznij darmowy okres', tr: '🎁 Ücretsiz denemeyi başlat', ro: '🎁 Începe testul gratuit', cs: '🎁 Spustit zkušební verzi', sk: '🎁 Spustiť skúšobnú verziu', sv: '🎁 Starta gratis provperiod', da: '🎁 Start gratis prøveperiode', no: '🎁 Start gratis prøveperiode' },
  trial_unavailable:   { en: '_Free trial is not available right now. Try /subscribe to upgrade directly._', es: '_La prueba gratuita no está disponible. Usa /subscribe para actualizar._', de: '_Testphase derzeit nicht verfügbar. Nutze /subscribe._', fr: '_L\'essai gratuit n\'est pas disponible. Utilise /subscribe._', it: '_Prova gratuita non disponibile. Usa /subscribe._', pt: '_Teste grátis indisponível. Usa /subscribe._', nl: '_Gratis trial is niet beschikbaar. Gebruik /subscribe._', hr: '_Besplatna proba trenutno nije dostupna. Koristi /subscribe._', pl: '_Darmowy okres próbny niedostępny. Użyj /subscribe._', tr: '_Ücretsiz deneme şu an mevcut değil. /subscribe kullan._', ro: '_Testul gratuit nu e disponibil. Folosește /subscribe._', cs: '_Zkušební verze není dostupná. Použij /subscribe._', sk: '_Skúšobná verzia nie je dostupná. Použi /subscribe._', sv: '_Gratis provperiod är inte tillgänglig. Använd /subscribe._', da: '_Gratis prøveperiode er ikke tilgængelig. Brug /subscribe._', no: '_Gratis prøveperiode er ikke tilgjengelig. Bruk /subscribe._' },
  trial_already_used:  { en: '_You\'ve already used your free trial. Use /subscribe to start a paid plan._', es: '_Ya usaste tu prueba gratis. Usa /subscribe para empezar un plan de pago._', de: '_Du hast deine Testphase bereits genutzt. Nutze /subscribe._', fr: '_Tu as déjà utilisé ton essai gratuit. Utilise /subscribe._', it: '_Hai già usato la prova gratuita. Usa /subscribe._', pt: '_Já usaste o teu teste grátis. Usa /subscribe._', nl: '_Je hebt je gratis trial al gebruikt. Gebruik /subscribe._', hr: '_Već si iskoristio besplatnu probu. Koristi /subscribe._', pl: '_Wykorzystałeś już darmowy okres. Użyj /subscribe._', tr: '_Ücretsiz denemeni zaten kullandın. /subscribe kullan._', ro: '_Ți-ai folosit deja testul gratuit. Folosește /subscribe._', cs: '_Zkušební verzi jsi už využil. Použij /subscribe._', sk: '_Skúšobnú verziu si už využil. Použi /subscribe._', sv: '_Du har redan använt din gratis provperiod. Använd /subscribe._', da: '_Du har allerede brugt din gratis prøveperiode. Brug /subscribe._', no: '_Du har allerede brukt gratis prøveperioden. Bruk /subscribe._' },
  trial_active_sub:    { en: '_You already have an active subscription. Use /billing to manage it._', es: '_Ya tienes una suscripción activa. Usa /billing para gestionarla._', de: '_Du hast bereits ein aktives Abo. Nutze /billing._', fr: '_Tu as déjà un abonnement actif. Utilise /billing._', it: '_Hai già un abbonamento attivo. Usa /billing._', pt: '_Já tens uma subscrição ativa. Usa /billing._', nl: '_Je hebt al een actief abonnement. Gebruik /billing._', hr: '_Već imaš aktivnu pretplatu. Koristi /billing._', pl: '_Masz już aktywną subskrypcję. Użyj /billing._', tr: '_Zaten aktif aboneliğin var. /billing kullan._', ro: '_Ai deja un abonament activ. Folosește /billing._', cs: '_Už máš aktivní předplatné. Použij /billing._', sk: '_Už máš aktívne predplatné. Použi /billing._', sv: '_Du har redan en aktiv prenumeration. Använd /billing._', da: '_Du har allerede et aktivt abonnement. Brug /billing._', no: '_Du har allerede et aktivt abonnement. Bruk /billing._' },
  // Settings hub
  settings_title:      { en: '*⚙️ Settings*', es: '*⚙️ Configuración*', de: '*⚙️ Einstellungen*', fr: '*⚙️ Paramètres*', it: '*⚙️ Impostazioni*', pt: '*⚙️ Definições*', nl: '*⚙️ Instellingen*', hr: '*⚙️ Postavke*', pl: '*⚙️ Ustawienia*', tr: '*⚙️ Ayarlar*', ro: '*⚙️ Setări*', cs: '*⚙️ Nastavení*', sk: '*⚙️ Nastavenia*', sv: '*⚙️ Inställningar*', da: '*⚙️ Indstillinger*', no: '*⚙️ Innstillinger*' },
  settings_language:   { en: '🌍 Language', es: '🌍 Idioma', de: '🌍 Sprache', fr: '🌍 Langue', it: '🌍 Lingua', pt: '🌍 Idioma', nl: '🌍 Taal', hr: '🌍 Jezik', pl: '🌍 Język', tr: '🌍 Dil', ro: '🌍 Limbă', cs: '🌍 Jazyk', sk: '🌍 Jazyk', sv: '🌍 Språk', da: '🌍 Sprog', no: '🌍 Språk' },
  settings_sports:     { en: '⚽ Favorite sports', es: '⚽ Deportes favoritos', de: '⚽ Lieblingssportarten', fr: '⚽ Sports préférés', it: '⚽ Sport preferiti', pt: '⚽ Desportos favoritos', nl: '⚽ Favoriete sporten', hr: '⚽ Omiljeni sportovi', pl: '⚽ Ulubione sporty', tr: '⚽ Favori sporlar', ro: '⚽ Sporturi favorite', cs: '⚽ Oblíbené sporty', sk: '⚽ Obľúbené športy', sv: '⚽ Favoritsporter', da: '⚽ Favoritsportsgrene', no: '⚽ Favorittidretter' },
  settings_edge:       { en: '📈 Edge threshold', es: '📈 Umbral de valor', de: '📈 Edge-Schwelle', fr: '📈 Seuil d\'edge', it: '📈 Soglia edge', pt: '📈 Limiar de edge', nl: '📈 Edge-drempel', hr: '📈 Prag prednosti', pl: '📈 Próg przewagi', tr: '📈 Kenar eşiği', ro: '📈 Prag edge', cs: '📈 Práh edge', sk: '📈 Prah edge', sv: '📈 Edge-tröskel', da: '📈 Edge-tærskel', no: '📈 Edge-terskel' },
  settings_quiet:      { en: '🔕 Quiet hours', es: '🔕 Horas silenciosas', de: '🔕 Ruhezeiten', fr: '🔕 Heures silencieuses', it: '🔕 Ore silenziose', pt: '🔕 Horas silenciosas', nl: '🔕 Stille uren', hr: '🔕 Tihi sati', pl: '🔕 Godziny ciszy', tr: '🔕 Sessiz saatler', ro: '🔕 Ore de liniște', cs: '🔕 Tiché hodiny', sk: '🔕 Tiché hodiny', sv: '🔕 Tysta timmar', da: '🔕 Stille timer', no: '🔕 Stille timer' },
  settings_privacy:    { en: '🔒 Privacy & data', es: '🔒 Privacidad y datos', de: '🔒 Datenschutz & Daten', fr: '🔒 Confidentialité & données', it: '🔒 Privacy & dati', pt: '🔒 Privacidade & dados', nl: '🔒 Privacy & gegevens', hr: '🔒 Privatnost i podaci', pl: '🔒 Prywatność i dane', tr: '🔒 Gizlilik ve veri', ro: '🔒 Confidențialitate & date', cs: '🔒 Soukromí a data', sk: '🔒 Súkromie a dáta', sv: '🔒 Integritet & data', da: '🔒 Privatliv & data', no: '🔒 Personvern & data' },
  settings_tier:       { en: '💎 Subscription', es: '💎 Suscripción', de: '💎 Abonnement', fr: '💎 Abonnement', it: '💎 Abbonamento', pt: '💎 Subscrição', nl: '💎 Abonnement', hr: '💎 Pretplata', pl: '💎 Subskrypcja', tr: '💎 Abonelik', ro: '💎 Abonament', cs: '💎 Předplatné', sk: '💎 Predplatné', sv: '💎 Prenumeration', da: '💎 Abonnement', no: '💎 Abonnement' },
  // GDPR
  export_ready:        { en: '📦 Your data is below. Save this message if you need a copy.', es: '📦 Tus datos están abajo. Guarda este mensaje si necesitas una copia.', de: '📦 Deine Daten sind unten.', fr: '📦 Tes données sont ci-dessous.', it: '📦 I tuoi dati sono qui sotto.', pt: '📦 Os teus dados estão abaixo.', nl: '📦 Je gegevens staan hieronder.', hr: '📦 Tvoji podaci su ispod.', pl: '📦 Twoje dane poniżej.', tr: '📦 Verilerin aşağıda.', ro: '📦 Datele tale sunt mai jos.', cs: '📦 Tvoje data jsou níže.', sk: '📦 Tvoje dáta sú nižšie.', sv: '📦 Dina data finns nedan.', da: '📦 Dine data er nedenfor.', no: '📦 Dine data er under.' },
  delete_confirm:      { en: '⚠️ *Delete all your data?*\nThis removes your bets, settings, bankroll, subscription records, and language preference. This cannot be undone.', es: '⚠️ *¿Eliminar todos tus datos?*\nEsto elimina tus apuestas, configuración, banco, suscripción e idioma. No se puede deshacer.', de: '⚠️ *Alle Daten löschen?*\nDies entfernt Wetten, Einstellungen, Bankroll, Abo und Sprache. Nicht umkehrbar.', fr: '⚠️ *Supprimer toutes tes données ?*\nCela supprime paris, paramètres, bankroll, abonnement et langue. Irréversible.', it: '⚠️ *Eliminare tutti i tuoi dati?*\nRimuove scommesse, impostazioni, bankroll, abbonamento e lingua. Irreversibile.', pt: '⚠️ *Eliminar todos os teus dados?*\nRemove apostas, definições, banca, subscrição e idioma. Irreversível.', nl: '⚠️ *Alle gegevens verwijderen?*\nDit verwijdert weddenschappen, instellingen, bankroll, abonnement en taal.', hr: '⚠️ *Obrisati sve podatke?*\nOvo briše oklade, postavke, bankroll, pretplatu i jezik.', pl: '⚠️ *Usunąć wszystkie dane?*\nTo usunie zakłady, ustawienia, bankroll, subskrypcję i język.', tr: '⚠️ *Tüm verilerin silinsin mi?*\nBahisler, ayarlar, bakiye, abonelik ve dil silinir.', ro: '⚠️ *Ștergi toate datele?*\nȘterge pariurile, setările, bankroll, abonamentul și limba.', cs: '⚠️ *Smazat všechna data?*\nOdstraní sázky, nastavení, bankroll, předplatné a jazyk.', sk: '⚠️ *Zmazať všetky dáta?*\nOdstráni stávky, nastavenia, bankroll, predplatné a jazyk.', sv: '⚠️ *Radera all data?*\nTar bort spel, inställningar, bankroll, prenumeration och språk.', da: '⚠️ *Slet alle data?*\nFjerner spil, indstillinger, bankroll, abonnement og sprog.', no: '⚠️ *Slette alle data?*\nFjerner spill, innstillinger, bankroll, abonnement og språk.' },
  delete_done:         { en: '✅ Your data has been deleted. Thanks for trying Ruflo.', es: '✅ Tus datos han sido eliminados. Gracias por probar Ruflo.', de: '✅ Deine Daten wurden gelöscht. Danke für Ruflo.', fr: '✅ Tes données ont été supprimées. Merci.', it: '✅ I tuoi dati sono stati eliminati. Grazie.', pt: '✅ Os teus dados foram eliminados. Obrigado.', nl: '✅ Je gegevens zijn verwijderd. Bedankt.', hr: '✅ Tvoji podaci su obrisani. Hvala.', pl: '✅ Twoje dane zostały usunięte. Dzięki.', tr: '✅ Verilerin silindi. Teşekkürler.', ro: '✅ Datele tale au fost șterse. Mulțumim.', cs: '✅ Tvoje data byla smazána. Díky.', sk: '✅ Tvoje dáta boli zmazané. Vďaka.', sv: '✅ Din data har raderats. Tack.', da: '✅ Dine data er slettet. Tak.', no: '✅ Dataene dine er slettet. Takk.' },
  btn_confirm_delete:  { en: '🗑 Yes, delete everything', es: '🗑 Sí, eliminar todo', de: '🗑 Ja, alles löschen', fr: '🗑 Oui, tout supprimer', it: '🗑 Sì, elimina tutto', pt: '🗑 Sim, eliminar tudo', nl: '🗑 Ja, alles verwijderen', hr: '🗑 Da, obriši sve', pl: '🗑 Tak, usuń wszystko', tr: '🗑 Evet, hepsini sil', ro: '🗑 Da, șterge tot', cs: '🗑 Ano, smazat vše', sk: '🗑 Áno, zmazať všetko', sv: '🗑 Ja, radera allt', da: '🗑 Ja, slet alt', no: '🗑 Ja, slett alt' },
  btn_cancel:          { en: 'Cancel', es: 'Cancelar', de: 'Abbrechen', fr: 'Annuler', it: 'Annulla', pt: 'Cancelar', nl: 'Annuleren', hr: 'Odustani', pl: 'Anuluj', tr: 'İptal', ro: 'Anulează', cs: 'Zrušit', sk: 'Zrušiť', sv: 'Avbryt', da: 'Annuller', no: 'Avbryt' },
  // /help body
  help_title:          { en: '*Ruflo — Betting Intelligence*', es: '*Ruflo — Inteligencia de Apuestas*', de: '*Ruflo — Wett-Intelligenz*', fr: '*Ruflo — Intelligence Paris*', it: '*Ruflo — Intelligence Scommesse*', pt: '*Ruflo — Inteligência de Apostas*', nl: '*Ruflo — Wedintelligentie*', hr: '*Ruflo — Kladiona inteligencija*', pl: '*Ruflo — Inteligencja Zakładów*', tr: '*Ruflo — Bahis Zekası*', ro: '*Ruflo — Inteligență Pariuri*', cs: '*Ruflo — Sázková inteligence*', sk: '*Ruflo — Stávková inteligencia*', sv: '*Ruflo — Spelintelligens*', da: '*Ruflo — Spilleintelligens*', no: '*Ruflo — Spillintelligens*' },
  help_intro:          { en: 'Just message me naturally. Here are some things you can ask:', es: 'Solo escríbeme con naturalidad. Algunas cosas que puedes pedir:', de: 'Schreib mir einfach ganz normal. Hier sind Dinge, die du fragen kannst:', fr: 'Écris-moi naturellement. Voici ce que tu peux demander :', it: 'Scrivimi in modo naturale. Ecco cosa puoi chiedere:', pt: 'Fala comigo naturalmente. Aqui estão algumas coisas que podes pedir:', nl: 'Stuur me gewoon een bericht. Dit kun je vragen:', hr: 'Samo mi piši normalno. Evo što možeš pitati:', pl: 'Po prostu napisz do mnie. Oto co możesz zapytać:', tr: 'Doğal bir şekilde yaz. İşte sorabileceklerin:', ro: 'Scrie-mi normal. Iată ce poți întreba:', cs: 'Prostě mi napiš. Tady je, na co se můžeš zeptat:', sk: 'Proste mi napíš. Tu je, na čo sa môžeš opýtať:', sv: 'Skriv bara till mig. Här är saker du kan fråga:', da: 'Bare skriv til mig. Her er hvad du kan spørge om:', no: 'Bare skriv til meg. Her er hva du kan spørre om:' },
  help_opportunities:  { en: '*Finding opportunities:*', es: '*Encontrar oportunidades:*', de: '*Gelegenheiten finden:*', fr: '*Trouver des opportunités :*', it: '*Trovare opportunità:*', pt: '*Encontrar oportunidades:*', nl: '*Kansen vinden:*', hr: '*Pronalaženje prilika:*', pl: '*Znajdowanie okazji:*', tr: '*Fırsat bulma:*', ro: '*Găsire oportunități:*', cs: '*Hledání příležitostí:*', sk: '*Hľadanie príležitostí:*', sv: '*Hitta möjligheter:*', da: '*Find muligheder:*', no: '*Finne muligheter:*' },
  help_sports:         { en: '*Specific sports:*', es: '*Deportes específicos:*', de: '*Bestimmte Sportarten:*', fr: '*Sports spécifiques :*', it: '*Sport specifici:*', pt: '*Desportos específicos:*', nl: '*Specifieke sporten:*', hr: '*Određeni sportovi:*', pl: '*Konkretne sporty:*', tr: '*Belirli sporlar:*', ro: '*Sporturi specifice:*', cs: '*Konkrétní sporty:*', sk: '*Konkrétne športy:*', sv: '*Specifika sporter:*', da: '*Specifikke sportsgrene:*', no: '*Spesifikke idretter:*' },
  help_tracking:       { en: '*Tracking & bankroll:*', es: '*Seguimiento y banca:*', de: '*Tracking & Bankroll:*', fr: '*Suivi & bankroll :*', it: '*Tracking & bankroll:*', pt: '*Rastreamento & banca:*', nl: '*Tracking & bankroll:*', hr: '*Praćenje i bankroll:*', pl: '*Śledzenie i bankroll:*', tr: '*Takip & bakiye:*', ro: '*Urmărire & bankroll:*', cs: '*Sledování a bankroll:*', sk: '*Sledovanie a bankroll:*', sv: '*Spårning & bankroll:*', da: '*Sporing & bankroll:*', no: '*Sporing & bankroll:*' },
  help_alerts:         { en: '*Alerts:*', es: '*Alertas:*', de: '*Benachrichtigungen:*', fr: '*Alertes :*', it: '*Avvisi:*', pt: '*Alertas:*', nl: '*Meldingen:*', hr: '*Upozorenja:*', pl: '*Alerty:*', tr: '*Uyarılar:*', ro: '*Alerte:*', cs: '*Upozornění:*', sk: '*Upozornenia:*', sv: '*Varningar:*', da: '*Advarsler:*', no: '*Varsler:*' },
  help_more:           { en: '*More:*', es: '*Más:*', de: '*Mehr:*', fr: '*Plus :*', it: '*Altro:*', pt: '*Mais:*', nl: '*Meer:*', hr: '*Više:*', pl: '*Więcej:*', tr: '*Daha fazla:*', ro: '*Mai multe:*', cs: '*Více:*', sk: '*Viac:*', sv: '*Mer:*', da: '*Mere:*', no: '*Mer:*' },
  help_footer:         { en: '_Tap buttons below or type / for commands. Use /settings to configure, /language to switch language._', es: '_Toca los botones o escribe / para comandos. Usa /settings y /language._', de: '_Tippe die Buttons unten oder / für Befehle. /settings und /language._', fr: '_Tape les boutons ou / pour les commandes. /settings et /language._', it: '_Usa i pulsanti o digita / per i comandi. /settings e /language._', pt: '_Usa os botões ou escreve / para comandos. /settings e /language._', nl: '_Gebruik de knoppen of typ / voor commando\'s. /settings en /language._', hr: '_Koristi gumbe ili upiši / za naredbe. /settings i /language._', pl: '_Użyj przycisków lub wpisz / dla komend. /settings i /language._', tr: '_Butonları kullan veya / yazın. /settings ve /language._', ro: '_Folosește butoanele sau scrie / pentru comenzi. /settings și /language._', cs: '_Použij tlačítka nebo napiš / pro příkazy. /settings a /language._', sk: '_Použi tlačidlá alebo napíš / pre príkazy. /settings a /language._', sv: '_Tryck på knapparna eller skriv / för kommandon. /settings och /language._', da: '_Brug knapperne eller skriv / for kommandoer. /settings og /language._', no: '_Bruk knappene eller skriv / for kommandoer. /settings og /language._' },
  // /about body
  about_title:         { en: '*About Ruflo*', es: '*Sobre Ruflo*', de: '*Über Ruflo*', fr: '*À propos de Ruflo*', it: '*Su Ruflo*', pt: '*Sobre Ruflo*', nl: '*Over Ruflo*', hr: '*O Ruflu*', pl: '*O Ruflo*', tr: '*Ruflo hakkında*', ro: '*Despre Ruflo*', cs: '*O Ruflu*', sk: '*O Ruflu*', sv: '*Om Ruflo*', da: '*Om Ruflo*', no: '*Om Ruflo*' },
  about_desc:          { en: 'Ruflo is a real-time sports betting intelligence platform. We scan 40+ bookmakers continuously to find:', es: 'Ruflo es una plataforma de inteligencia de apuestas deportivas en tiempo real. Escaneamos más de 40 casas de apuestas continuamente para encontrar:', de: 'Ruflo ist eine Echtzeit-Sportwetten-Intelligenzplattform. Wir scannen 40+ Buchmacher kontinuierlich, um zu finden:', fr: 'Ruflo est une plateforme d\'intelligence paris sportifs en temps réel. Nous scannons 40+ bookmakers en continu pour trouver :', it: 'Ruflo è una piattaforma di intelligence scommesse sportive in tempo reale. Analizziamo 40+ bookmaker continuamente per trovare:', pt: 'Ruflo é uma plataforma de inteligência de apostas em tempo real. Analisamos 40+ casas continuamente para encontrar:', nl: 'Ruflo is een real-time sportwedden-intelligentieplatform. We scannen 40+ bookmakers continu om te vinden:', hr: 'Ruflo je platforma za kladionu inteligenciju u stvarnom vremenu. Skeniramo 40+ kladionica kontinuirano za pronalaženje:', pl: 'Ruflo to platforma inteligencji zakładów sportowych w czasie rzeczywistym. Skanujemy 40+ bukmacherów nieprzerwanie, aby znaleźć:', tr: 'Ruflo gerçek zamanlı spor bahisleri zeka platformudur. Bulmak için 40+ bahis sitesini sürekli tarıyoruz:', ro: 'Ruflo este o platformă de inteligență pariuri sportive în timp real. Scanăm 40+ case continuu pentru a găsi:', cs: 'Ruflo je platforma pro sázkovou inteligenci v reálném čase. Skenujeme 40+ sázkových kanceláří nepřetržitě, abychom našli:', sk: 'Ruflo je platforma pre stávkovú inteligenciu v reálnom čase. Skenujeme 40+ stávkových kancelárií nepretržite, aby sme našli:', sv: 'Ruflo är en realtidsplattform för spelintelligens. Vi skannar 40+ bookmakers kontinuerligt för att hitta:', da: 'Ruflo er en realtidsspilleintelligensplatform. Vi scanner 40+ bookmakere kontinuerligt for at finde:', no: 'Ruflo er en sanntids spillintelligensplattform. Vi skanner 40+ bookmakere kontinuerlig for å finne:' },
  about_value:         { en: '*Value bets* — where bookmaker odds are mispriced', es: '*Apuestas de valor* — donde las cuotas están mal valoradas', de: '*Value-Wetten* — wo Buchmacher-Quoten falsch bepreist sind', fr: '*Paris de valeur* — où les cotes sont mal évaluées', it: '*Scommesse di valore* — dove le quote sono mal prezzate', pt: '*Apostas de valor* — onde as odds estão mal cotadas', nl: '*Waardeweddenschappen* — waar odds verkeerd geprijsd zijn', hr: '*Value oklade* — gdje su kvote pogrešno procijenjene', pl: '*Zakłady wartościowe* — gdzie kursy są źle wycenione', tr: '*Değer bahisleri* — oranların yanlış fiyatlandığı yerler', ro: '*Pariuri de valoare* — unde cotele sunt greșit evaluate', cs: '*Hodnotové sázky* — kde jsou kurzy špatně nacenény', sk: '*Hodnotové stávky* — kde sú kurzy zle nacenené', sv: '*Värdespel* — där odds är felprissatta', da: '*Værdispil* — hvor odds er forkert prissat', no: '*Verdispill* — hvor odds er feilprisede' },
  about_arb:           { en: '*Arbitrage* — guaranteed profit across different books', es: '*Arbitraje* — beneficio garantizado entre diferentes casas', de: '*Arbitrage* — garantierter Gewinn über verschiedene Anbieter', fr: '*Arbitrage* — profit garanti entre différents bookmakers', it: '*Arbitraggio* — profitto garantito tra diversi bookmaker', pt: '*Arbitragem* — lucro garantido entre casas diferentes', nl: '*Arbitrage* — gegarandeerde winst over verschillende bookmakers', hr: '*Arbitraža* — zajamčena dobit između različitih kladionica', pl: '*Arbitraż* — gwarantowany zysk między różnymi bukmacherami', tr: '*Arbitraj* — farklı sitelerde garantili kâr', ro: '*Arbitraj* — profit garantat între case diferite', cs: '*Arbitráž* — zaručený zisk mezi různými sázkovkami', sk: '*Arbitráž* — zaručený zisk medzi rôznymi stávkovkami', sv: '*Arbitrage* — garanterad vinst över olika spelbolag', da: '*Arbitrage* — garanteret fortjeneste på tværs af bookmakere', no: '*Arbitrasje* — garantert fortjeneste på tvers av bookmakere' },
  about_sharp:         { en: '*Sharp money* — track where professionals are betting', es: '*Dinero inteligente* — rastrea dónde apuestan los profesionales', de: '*Sharp Money* — verfolge, wo Profis wetten', fr: '*Sharp money* — suis où les pros parient', it: '*Sharp money* — traccia dove scommettono i professionisti', pt: '*Dinheiro inteligente* — rastreia onde os profissionais apostam', nl: '*Sharp money* — volg waar profs wedden', hr: '*Pametni novac* — prati gdje klade profesionalci', pl: '*Smart money* — śledź gdzie stawiają profesjonaliści', tr: '*Akıllı para* — profesyonellerin nereye bahis yaptığını takip et', ro: '*Bani deștepți* — urmărește unde pariază profesioniștii', cs: '*Sharp money* — sleduj, kde sázejí profesionálové', sk: '*Sharp money* — sleduj, kde stávkujú profesionáli', sv: '*Sharp money* — följ var proffsen spelar', da: '*Sharp money* — følg hvor proffene spiller', no: '*Sharp money* — følg hvor proffene spiller' },
  about_steam:         { en: '*Steam moves* — sudden line shifts from sharp books', es: '*Movimientos de steam* — cambios repentinos de líneas sharp', de: '*Steam Moves* — plötzliche Linienbewegungen von Sharp Books', fr: '*Steam moves* — changements soudains des lignes des bookmakers sharp', it: '*Steam moves* — cambi di linea improvvisi da bookmaker sharp', pt: '*Movimentos steam* — mudanças repentinas de linhas sharp', nl: '*Steam moves* — plotselinge lijnverschuivingen van sharp boeken', hr: '*Steam potezi* — nagli pomaci linija od sharp kladionica', pl: '*Steam moves* — nagłe przesunięcia linii z ksiąg sharp', tr: '*Steam hareketleri* — sharp sitelerden ani çizgi kaymaları', ro: '*Mișcări steam* — schimbări bruște de linii de la case sharp', cs: '*Steam pohyby* — náhlé posuny linií od sharp sázkovek', sk: '*Steam pohyby* — náhle posuny čiar od sharp stávkoviek', sv: '*Steam moves* — plötsliga linjeförändringar från sharp-spelbolag', da: '*Steam moves* — pludselige linjeskift fra sharp-bookmakere', no: '*Steam-bevegelser* — plutselige linjeendringer fra sharp-bookmakere' },
  about_builtfor:      { en: 'Built for serious bettors who want a data-driven edge.', es: 'Hecho para apostadores serios que quieren una ventaja basada en datos.', de: 'Gebaut für ernsthafte Wettende, die einen datengetriebenen Vorteil wollen.', fr: 'Construit pour les parieurs sérieux qui veulent un avantage basé sur les données.', it: 'Costruito per scommettitori seri che vogliono un vantaggio basato sui dati.', pt: 'Construído para apostadores sérios que querem uma vantagem baseada em dados.', nl: 'Gebouwd voor serieuze wedders die een data-gedreven voordeel willen.', hr: 'Izgrađeno za ozbiljne kladioničare koji žele prednost temeljenu na podacima.', pl: 'Zbudowane dla poważnych graczy, którzy chcą przewagi opartej na danych.', tr: 'Veri odaklı bir avantaj isteyen ciddi bahisçiler için yapıldı.', ro: 'Construit pentru pariori serioși care vor un avantaj bazat pe date.', cs: 'Vytvořeno pro seriózní sázkaře, kteří chtějí datovou výhodu.', sk: 'Vytvorené pre serióznych stávkujúcich, ktorí chcú dátovú výhodu.', sv: 'Byggt för seriösa spelare som vill ha en datadriven fördel.', da: 'Bygget til seriøse spillere der vil have en data-drevet fordel.', no: 'Bygget for seriøse spillere som vil ha en datadrevet fordel.' },
  about_how:           { en: '*How it works:*', es: '*Cómo funciona:*', de: '*Wie es funktioniert:*', fr: '*Comment ça marche :*', it: '*Come funziona:*', pt: '*Como funciona:*', nl: '*Hoe het werkt:*', hr: '*Kako radi:*', pl: '*Jak to działa:*', tr: '*Nasıl çalışır:*', ro: '*Cum funcționează:*', cs: '*Jak to funguje:*', sk: '*Ako to funguje:*', sv: '*Så funkar det:*', da: '*Sådan virker det:*', no: '*Slik fungerer det:*' },
  about_step1:         { en: '1. We compare odds from Pinnacle, Bet365, Betfair + 40 more', es: '1. Comparamos cuotas de Pinnacle, Bet365, Betfair + 40 más', de: '1. Wir vergleichen Quoten von Pinnacle, Bet365, Betfair + 40 weiteren', fr: '1. Nous comparons les cotes de Pinnacle, Bet365, Betfair + 40 autres', it: '1. Confrontiamo quote da Pinnacle, Bet365, Betfair + 40 altri', pt: '1. Comparamos odds do Pinnacle, Bet365, Betfair + 40 mais', nl: '1. We vergelijken odds van Pinnacle, Bet365, Betfair + 40 meer', hr: '1. Uspoređujemo kvote Pinnacle, Bet365, Betfair + 40 drugih', pl: '1. Porównujemy kursy z Pinnacle, Bet365, Betfair + 40 innych', tr: '1. Pinnacle, Bet365, Betfair + 40 siteden oranları karşılaştırıyoruz', ro: '1. Comparăm cotele de la Pinnacle, Bet365, Betfair + 40 altele', cs: '1. Porovnáváme kurzy Pinnacle, Bet365, Betfair + 40 dalších', sk: '1. Porovnávame kurzy Pinnacle, Bet365, Betfair + 40 ďalších', sv: '1. Vi jämför odds från Pinnacle, Bet365, Betfair + 40 till', da: '1. Vi sammenligner odds fra Pinnacle, Bet365, Betfair + 40 flere', no: '1. Vi sammenligner odds fra Pinnacle, Bet365, Betfair + 40 flere' },
  about_step2:         { en: '2. Our models identify mispriced lines and value', es: '2. Nuestros modelos identifican líneas mal valoradas', de: '2. Unsere Modelle erkennen falsch bepreiste Linien und Value', fr: '2. Nos modèles identifient les lignes mal évaluées', it: '2. I nostri modelli identificano linee mal prezzate e valore', pt: '2. Os nossos modelos identificam linhas mal cotadas e valor', nl: '2. Onze modellen identificeren verkeerd geprijsde lijnen en waarde', hr: '2. Naši modeli identificiraju pogrešno procijenjene linije', pl: '2. Nasze modele identyfikują źle wycenione linie', tr: '2. Modellerimiz yanlış fiyatlanmış çizgileri tanımlar', ro: '2. Modelele noastre identifică linii greșit evaluate', cs: '2. Naše modely identifikují špatně nacenené linie', sk: '2. Naše modely identifikujú zle nacenené čiary', sv: '2. Våra modeller identifierar felprissatta linjer', da: '2. Vores modeller identificerer forkert prissatte linjer', no: '2. Våre modeller identifiserer feilprisede linjer' },
  about_step3:         { en: '3. You get alerts pushed directly to Telegram', es: '3. Recibes alertas directamente en Telegram', de: '3. Du erhältst Alerts direkt in Telegram', fr: '3. Tu reçois des alertes directement dans Telegram', it: '3. Ricevi avvisi direttamente su Telegram', pt: '3. Recebes alertas diretamente no Telegram', nl: '3. Je krijgt meldingen direct in Telegram', hr: '3. Dobivaš upozorenja direktno u Telegram', pl: '3. Otrzymujesz alerty bezpośrednio na Telegramie', tr: '3. Uyarılar doğrudan Telegram\'a gelir', ro: '3. Primești alerte direct pe Telegram', cs: '3. Dostáváš upozornění přímo do Telegramu', sk: '3. Dostávaš upozornenia priamo do Telegramu', sv: '3. Du får varningar direkt i Telegram', da: '3. Du får advarsler direkte i Telegram', no: '3. Du får varsler direkte i Telegram' },
  about_step4:         { en: '4. Track your P/L and ROI automatically', es: '4. Rastrea tu P/L y ROI automáticamente', de: '4. Verfolge P/L und ROI automatisch', fr: '4. Suis ton P/L et ROI automatiquement', it: '4. Traccia P/L e ROI automaticamente', pt: '4. Acompanha P/L e ROI automaticamente', nl: '4. Volg je P/L en ROI automatisch', hr: '4. Prati P/L i ROI automatski', pl: '4. Śledź P/L i ROI automatycznie', tr: '4. P/L ve ROI\'ni otomatik takip et', ro: '4. Urmărește P/L și ROI automat', cs: '4. Sleduj P/L a ROI automaticky', sk: '4. Sleduj P/L a ROI automaticky', sv: '4. Spåra P/L och ROI automatiskt', da: '4. Spor P/L og ROI automatisk', no: '4. Spor P/L og ROI automatisk' },
};

// Get translated string
function t(key, chatId) {
  const lang = getUserLang(chatId);
  const entry = T[key];
  if (!entry) return key;
  return entry[lang] || entry.en || key;
}

// ============================================================
// --- SIGNAL STRENGTH FORMATTING ---
// ============================================================
function signalStrength(edge) {
  if (edge >= 0.08) return '🟢 STRONG';
  if (edge >= 0.04) return '🟡 MODERATE';
  return '🔴 WEAK';
}
function confidenceBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct.toFixed(0)}%`;
}
function arbStrength(profit) {
  if (profit >= 3.0) return '🟢 HIGH';
  if (profit >= 1.5) return '🟡 MEDIUM';
  return '🔴 SLIM';
}

// ============================================================
// --- QUIET HOURS ---
// ============================================================
function getUserQuietHours(chatId) {
  const settings = getUserSettings(String(chatId));
  return settings.quietHours || null; // { start: 23, end: 8 }
}

function isQuietTime(chatId) {
  const qh = getUserQuietHours(chatId);
  if (!qh) return false;
  const hour = new Date().getHours();
  if (qh.start > qh.end) {
    // Wraps midnight: e.g., 23-8 means 23,0,1,2,3,4,5,6,7
    return hour >= qh.start || hour < qh.end;
  }
  return hour >= qh.start && hour < qh.end;
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
      // spawnSync with arg array bypasses the shell → no injection via file path.
      const diff = spawnSync('git', ['diff', 'HEAD', '--', file], { cwd: WORKING_DIR, encoding: 'utf8', timeout: 5000 }).stdout || '';
      if (diff.trim()) diffParts.push(diff.trim());
      else {
        const staged = spawnSync('git', ['diff', '--cached', '--', file], { cwd: WORKING_DIR, encoding: 'utf8', timeout: 5000 }).stdout || '';
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
        spawnSync('git', ['checkout', 'HEAD', '--', file], { cwd: WORKING_DIR, timeout: 5000 });
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
// ============================================================
// --- PER-USER DATA DIRECTORY ---
// ============================================================
// Each user gets their own data folder: data/<chatId>/
// Global shared data stays in the bot root, user-specific data goes here
function ensureUserDir(chatId) {
  const userDir = path.join(DATA_DIR, String(chatId));
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

function userFilePath(chatId, filename) {
  return path.join(ensureUserDir(chatId), filename);
}

function loadUserFile(chatId, filename, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(userFilePath(chatId, filename), 'utf8')); }
  catch { return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback)); }
}

function saveUserFile(chatId, filename, data) {
  atomicWriteJson(userFilePath(chatId, filename), data);
}

// ============================================================
// --- SIGNAL TRACKER (Historical Performance Proof) ---
// ============================================================
// Records every signal the bot generates, then settles against actual results.
// This is the P&L proof that makes the product credible.

// Rotate signal_track.json when it exceeds SIGNAL_TRACK_MAX_BYTES.
// Moves settled signals older than 30 days to an archive in data/signal_archive/,
// keeps unsettled + recent signals in the live file, and retains the last 5 archives.
const SIGNAL_TRACK_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const SIGNAL_ARCHIVE_DIR = stateFile('signal_archive');
function rotateSignalTrackIfNeeded(track) {
  try {
    const stat = fs.statSync(SIGNAL_TRACK_FILE);
    if (stat.size < SIGNAL_TRACK_MAX_BYTES) return track;
  } catch { return track; }
  try {
    if (!fs.existsSync(SIGNAL_ARCHIVE_DIR)) fs.mkdirSync(SIGNAL_ARCHIVE_DIR, { recursive: true });
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
    const keep = [];
    const archive = [];
    for (const s of track.signals) {
      const recorded = new Date(s.recordedAt).getTime();
      if (s.result && recorded < cutoff) archive.push(s);
      else keep.push(s);
    }
    if (archive.length) {
      const archiveFile = path.join(SIGNAL_ARCHIVE_DIR, `signals-${new Date().toISOString().slice(0, 10)}.json`);
      fs.writeFileSync(archiveFile, JSON.stringify({ signals: archive }, null, 0));
      // Prune — keep only 5 newest archives
      const files = fs.readdirSync(SIGNAL_ARCHIVE_DIR)
        .filter(f => f.startsWith('signals-') && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const old of files.slice(5)) {
        try { fs.unlinkSync(path.join(SIGNAL_ARCHIVE_DIR, old)); } catch {}
      }
    }
    track.signals = keep;
    log.info(`[signal-track] Rotated: archived ${archive.length}, kept ${keep.length}`);
  } catch (err) {
    log.error(`[signal-track] Rotation failed: ${err.message}`);
  }
  return track;
}

function loadSignalTrack() {
  try { return JSON.parse(fs.readFileSync(SIGNAL_TRACK_FILE, 'utf8')); }
  catch { return { signals: [], stats: { total: 0, settled: 0, won: 0, lost: 0, push: 0, totalStaked: 0, totalReturn: 0 } }; }
}
function saveSignalTrack(data) {
  // Rotate before write if the on-disk file is too big
  data = rotateSignalTrackIfNeeded(data);
  atomicWriteJson(SIGNAL_TRACK_FILE, data);
}

// Record a signal when the bot generates it
function trackSignal(signal) {
  const track = loadSignalTrack();
  const id = `${signal.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  track.signals.push({
    id,
    type: signal.type,           // VALUE, ARB, STEAM
    match: signal.match,
    league: signal.league || 'unknown',
    outcome: signal.outcome || null,
    bookmaker: signal.bookmaker || null,
    odds: signal.odds || null,
    edge: signal.edge || null,
    arbProfit: signal.arbProfit || null,
    arbOutcomes: signal.arbOutcomes || null,
    commenceTime: signal.time,
    recordedAt: new Date().toISOString(),
    result: null,                // 'win', 'loss', 'push', null
    settledAt: null,
    actualScore: null,
    hypotheticalStake: 10,       // track as if €10 flat stake
    hypotheticalReturn: null,
  });
  track.stats.total++;
  saveSignalTrack(track);
  return id;
}

// Settle tracked signals against actual scores
//
// Race-safety: this function awaits 5+ external fetches (several seconds).
// During that window `trackSignal` may write new signals to disk. We therefore
// must NOT save the in-memory `track` we loaded at the top — that would
// clobber concurrently-added rows. Instead, we collect patches keyed by
// signal id + a stats delta, then at save-time re-load the fresh track and
// apply the patches in-place.
async function settleTrackedSignals() {
  /* demo-mode: proceed — fetch functions handle fallback */
  const track = loadSignalTrack();
  const unsettled = track.signals.filter(s => !s.result && s.commenceTime);
  if (!unsettled.length) return;
  // Accumulators applied to the FRESH track at save time (avoids clobbering
  // writes from concurrent trackSignal calls during the await window).
  const patches = new Map();           // id -> partial signal fields
  const statsDelta = { settled: 0, won: 0, lost: 0, totalStaked: 0, totalReturn: 0 };

  // Fetch completed scores (last 3 days)
  const sportKeys = ['soccer', 'basketball_nba', 'icehockey_nhl', 'baseball_mlb', 'americanfootball_nfl'];
  let allCompleted = [];
  for (const sport of sportKeys) {
    try {
      const url = `${ODDS_BASE}/sports/${sport}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3&dateFormat=iso`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        allCompleted = allCompleted.concat(data.filter(m => m.completed));
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  if (!allCompleted.length) return;

  let settled = 0;
  for (const signal of unsettled) {
    // Skip signals for events that haven't started yet
    if (new Date(signal.commenceTime).getTime() > Date.now()) continue;
    // Skip signals older than 4 days (stale)
    if (Date.now() - new Date(signal.commenceTime).getTime() > 4 * 24 * 60 * 60 * 1000) {
      patches.set(signal.id, { result: 'expired', settledAt: new Date().toISOString() });
      continue;
    }

    // Find matching completed game
    const matchLower = signal.match.toLowerCase();
    const game = allCompleted.find(m => {
      const home = m.home_team.toLowerCase();
      const away = m.away_team.toLowerCase();
      return matchLower.includes(home) && matchLower.includes(away);
    });
    if (!game) continue;

    const homeScore = parseInt(game.scores?.find(s => s.name === game.home_team)?.score || '0', 10);
    const awayScore = parseInt(game.scores?.find(s => s.name === game.away_team)?.score || '0', 10);
    const patch = {
      actualScore: `${game.home_team} ${homeScore}-${awayScore} ${game.away_team}`,
      settledAt: new Date().toISOString(),
    };

    if (signal.type === 'VALUE' && signal.outcome) {
      const outLower = signal.outcome.toLowerCase();
      const homeTeam = game.home_team.toLowerCase();
      const awayTeam = game.away_team.toLowerCase();
      let won = null;

      if (outLower.includes(homeTeam) || homeTeam.includes(outLower.split(' ')[0])) {
        won = homeScore > awayScore;
      } else if (outLower.includes(awayTeam) || awayTeam.includes(outLower.split(' ')[0])) {
        won = awayScore > homeScore;
      } else if (outLower === 'draw' || outLower === 'x') {
        won = homeScore === awayScore;
      }

      if (won === null) continue;
      patch.result = won ? 'win' : (homeScore === awayScore && outLower !== 'draw' ? 'push' : 'loss');
      patch.hypotheticalReturn = won ? signal.hypotheticalStake * signal.odds : 0;
      statsDelta.settled++;
      if (won) statsDelta.won++; else statsDelta.lost++;
      statsDelta.totalStaked += signal.hypotheticalStake;
      statsDelta.totalReturn += patch.hypotheticalReturn;
      settled++;
    } else if (signal.type === 'ARB') {
      patch.result = 'win';
      patch.hypotheticalReturn = signal.hypotheticalStake * (1 + (signal.arbProfit || 0) / 100);
      statsDelta.settled++;
      statsDelta.won++;
      statsDelta.totalStaked += signal.hypotheticalStake;
      statsDelta.totalReturn += patch.hypotheticalReturn;
      settled++;
    } else if (signal.type === 'STEAM') {
      // Steam moves: hard to settle; mark informational
      patch.result = 'info';
      statsDelta.settled++;
      settled++;
    } else {
      continue;
    }
    patches.set(signal.id, patch);
  }

  if (settled > 0 || patches.size > 0) {
    // Re-load fresh track and merge patches + stats delta in-place.
    const fresh = loadSignalTrack();
    for (const sig of fresh.signals) {
      const p = patches.get(sig.id);
      if (p) Object.assign(sig, p);
    }
    fresh.stats = fresh.stats || { total: 0, settled: 0, won: 0, lost: 0, push: 0, totalStaked: 0, totalReturn: 0 };
    fresh.stats.settled     += statsDelta.settled;
    fresh.stats.won         += statsDelta.won;
    fresh.stats.lost        += statsDelta.lost;
    fresh.stats.totalStaked += statsDelta.totalStaked;
    fresh.stats.totalReturn += statsDelta.totalReturn;
    saveSignalTrack(fresh);
    log.info(`[tracker] Settled ${settled} signals. Total: ${fresh.stats.settled}/${fresh.stats.total} (W:${fresh.stats.won} L:${fresh.stats.lost})`);
  }
}

// Run settlement every 15 minutes
setInterval(settleTrackedSignals, 15 * 60 * 1000);
setTimeout(settleTrackedSignals, 60_000); // first run 1 min after startup

// ============================================================
// --- DAILY STATE BACKUP ---
// ============================================================
// Snapshots all user-data JSON files to data/backups/YYYY-MM-DD/
// Retains 14 daily snapshots. Runs 5 min after startup then every 24h.
const BACKUP_DIR = stateFile('backups');
const BACKUP_RETENTION_DAYS = 14;
function runDailyBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const destDir = path.join(BACKUP_DIR, today);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const files = [
      TASKS_FILE, BANKROLL_FILE, ALERTS_FILE, HISTORY_FILE, CLV_FILE,
      ELO_FILE, TIERS_FILE, BIAS_FILE, SIGNALS_FILE, USER_SETTINGS_FILE,
      ARB_PERSIST_FILE, SUBSCRIPTIONS_FILE,
      path.join(DATA_DIR, 'user_langs.json'),
      path.join(DATA_DIR, 'onboarded.json'),
      path.join(DATA_DIR, 'legal_accept.json'),
    ];
    let copied = 0;
    for (const src of files) {
      try {
        if (!fs.existsSync(src)) continue;
        const base = path.basename(src);
        fs.copyFileSync(src, path.join(destDir, base));
        copied++;
      } catch (err) {
        log.warn(`[backup] Failed to copy ${src}: ${err.message}`);
      }
    }
    log.info(`[backup] Daily snapshot: ${copied} files → ${destDir}`);
    // Retention: delete backup dirs older than BACKUP_RETENTION_DAYS
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const dir of fs.readdirSync(BACKUP_DIR)) {
      const fullPath = path.join(BACKUP_DIR, dir);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          log.info(`[backup] Pruned old snapshot: ${dir}`);
        }
      } catch {}
    }
  } catch (err) {
    log.error(`[backup] Failed: ${err.message}`);
  }
}
setTimeout(runDailyBackup, 5 * 60 * 1000);        // 5 minutes after startup
setInterval(runDailyBackup, 24 * 60 * 60 * 1000); // every 24 hours

// ============================================================
// --- PROACTIVE BRIEFING ENGINE ---
// ============================================================
function loadBriefingState() {
  try { return JSON.parse(fs.readFileSync(BRIEFING_STATE_FILE, 'utf8')); } catch { return { users: {}, lastScheduled: null }; }
}
function saveBriefingState(state) { atomicWriteJson(BRIEFING_STATE_FILE, state); }

// Generate a live intelligence briefing for a user
async function generateBriefing(chatId, context = 'scheduled') {
  /* demo-mode: proceed — fetch functions handle fallback */

  const tier = getUserTier(String(chatId));
  const settings = getUserSettings(String(chatId));
  const minEdge = settings.minEdge || 0.02;
  const scannerState = loadScannerState();
  const subLeagues = scannerState.subscribers?.[String(chatId)]?.leagues || DEFAULT_SCANNER_LEAGUES;

  // Fetch a subset of leagues (max 5 to keep it fast and save API calls)
  const leaguesToFetch = subLeagues.slice(0, 5);
  let allEvents = [];
  for (const league of leaguesToFetch) {
    try {
      const events = await fetchOdds(league, 'h2h');
      allEvents = allEvents.concat(events);
    } catch { /* skip failed leagues */ }
    await new Promise(r => setTimeout(r, 300));
  }

  if (!allEvents.length) return null;

  // Filter to events starting in next 24h
  const now = Date.now();
  const next24h = allEvents.filter(ev => {
    const start = new Date(ev.commence_time).getTime();
    return start > now && start < now + 24 * 60 * 60 * 1000;
  });
  const eventsToAnalyze = next24h.length > 0 ? next24h : allEvents.slice(0, 20);

  // Run intelligence
  const movements = updateOddsCache(eventsToAnalyze);
  const steamMoves = movements.filter(m => m.isSteam);
  const arbs = [];
  const valueBets = [];

  for (const ev of eventsToAnalyze) {
    const arb = findArbitrage(ev);
    if (arb) arbs.push({ ...arb, match: `${ev.home_team} vs ${ev.away_team}`, time: ev.commence_time });
    const vbs = findValueBets(ev);
    for (const vb of vbs) {
      if (vb.edge >= minEdge) valueBets.push({ ...vb, match: `${ev.home_team} vs ${ev.away_team}`, time: ev.commence_time });
    }
  }
  valueBets.sort((a, b) => b.edge - a.edge);

  // Build briefing message
  const timeLabel = context === 'welcome' ? 'Welcome' : new Date().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const lines = [];

  if (context === 'welcome') {
    lines.push('*Ruflo Intelligence Platform*\n');
    lines.push('Your market intelligence is live. Here\'s what\'s happening right now:\n');
  } else {
    lines.push(`*Market Briefing — ${timeLabel}*\n`);
  }

  // Summary line
  lines.push(`📊 *${eventsToAnalyze.length}* events scanned across ${leaguesToFetch.length} leagues\n`);

  // Arbs section
  if (arbs.length > 0) {
    lines.push(`🔒 *Arbitrage (${arbs.length} found):*`);
    for (const arb of arbs.slice(0, 3)) {
      const time = new Date(arb.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const bets = Object.entries(arb.outcomes).map(([n, { price, bookmaker }]) => `${n} @ ${price.toFixed(2)} (${bookmaker})`).join(' / ');
      lines.push(`  *${arb.profit.toFixed(2)}%* — ${arb.match}`);
      lines.push(`  ${time} | ${bets}`);
    }
    if (arbs.length > 3) lines.push(`  _...and ${arbs.length - 3} more_`);
    lines.push('');
  } else {
    lines.push('🔒 No arbitrage opportunities right now.\n');
  }

  // Value bets
  if (valueBets.length > 0) {
    lines.push(`💎 *Value Bets (${valueBets.length} found):*`);
    const maxShow = hasFeature(String(chatId), 'signals') ? 5 : 2;
    for (const vb of valueBets.slice(0, maxShow)) {
      const time = new Date(vb.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      lines.push(`  *${(vb.edge * 100).toFixed(1)}% edge* — ${vb.match}`);
      lines.push(`  ${vb.outcome} @ ${vb.odds.toFixed(2)} (${vb.bookmaker}) | ${time}`);
    }
    if (valueBets.length > maxShow) lines.push(`  _...and ${valueBets.length - maxShow} more (use /value for all)_`);
    lines.push('');
  } else {
    lines.push('💎 No value bets above your threshold right now.\n');
  }

  // Steam moves
  if (steamMoves.length > 0) {
    lines.push(`🚨 *Sharp Line Moves (${steamMoves.length}):*`);
    for (const sm of steamMoves.slice(0, 3)) {
      const arrow = sm.direction === 'UP' ? '📈' : '📉';
      lines.push(`  ${arrow} ${sm.event} — ${sm.outcome}: ${sm.oldPrice.toFixed(2)} → ${sm.newPrice.toFixed(2)} (${sm.bookmaker})`);
    }
    lines.push('');
  }

  // Market mood
  const totalBookmakers = new Set();
  for (const ev of eventsToAnalyze) {
    for (const bm of (ev.bookmakers || [])) totalBookmakers.add(bm.title);
  }
  lines.push(`_${totalBookmakers.size} bookmakers tracked | Next briefing in ${BRIEFING_INTERVAL_HOURS}h_`);

  if (context === 'welcome') {
    lines.push('\n*Quick actions:*');
    lines.push('/scanner on — get real-time push alerts');
    lines.push('/signals — full signal dashboard');
    lines.push('/odds soccer today — detailed odds');
    lines.push('/help — all commands');
  }

  return lines.join('\n');
}

// Track last briefing time per user
const lastBriefingTime = new Map();

bot.onText(/\/start(?:\s+(\S+))?/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = msg.chat.id;

  // Deep-link payload: /start ref_<chatId> → record the referrer
  const payload = (match?.[1] || '').trim();
  if (payload.startsWith('ref_')) {
    const referrerId = payload.slice(4).replace(/\D/g, '');
    if (referrerId) {
      const result = recordReferral(chatId, referrerId);
      if (result.ok) {
        log.info(`[referral] ${chatId} referred by ${referrerId}`);
      }
    }
  }

  // Auto-subscribe to scanner on first start
  const scannerState = loadScannerState();
  if (!scannerState.subscribers[String(chatId)]) {
    scannerState.subscribers[String(chatId)] = { active: true };
    saveScannerState(scannerState);
  }

  // Auto-detect language from Telegram profile for new users
  if (!isOnboarded(chatId) && msg.from?.language_code) {
    const detected = detectLangFromTelegram(msg);
    setUserLang(chatId, detected);
  }

  // Legal acceptance gate — must accept ToS/18+/privacy before first use
  if (!hasAcceptedLegal(chatId)) {
    const name = escapeMd(msg.from?.first_name || 'there');
    const legalMsg = [
      `Hey ${name}! ${t('welcome_greeting', chatId)} 👋`,
      '',
      t('welcome_quick_things', chatId),
      '',
      t('legal_18_plus', chatId),
      '',
      t('legal_risk', chatId),
      '',
      t('legal_nodata', chatId),
      '',
      t('legal_gdpr', chatId),
    ].join('\n');
    await bot.sendMessage(chatId, legalMsg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: t('legal_accept', chatId), callback_data: 'tos:accept' }],
          [{ text: t('legal_decline', chatId), callback_data: 'tos:decline' }],
          [
            { text: '📄 /terms', callback_data: 'tos:view_terms' },
            { text: '🔒 /privacy', callback_data: 'tos:view_privacy' },
          ],
        ],
      },
    });
    return;
  }

  // New user onboarding flow
  if (!isOnboarded(chatId)) {
    markOnboarded(chatId);
    const name = escapeMd(msg.from.first_name || 'there');
    const onboardMsg = [
      `Hey ${name}, ${t('welcome', chatId)} 👋\n`,
      `${t('scan_description', chatId)}\n`,
      `${t('just_message', chatId)}\n`,
      '  _"What\'s good today?"_',
      '  _"Any arbs?"_',
      '  _"Sharp money on soccer"_\n',
      `${t('pick_sports', chatId)}`,
    ].join('\n');

    await bot.sendMessage(chatId, onboardMsg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚽ Soccer', callback_data: 'onboard:soccer' },
            { text: '🏀 Basketball', callback_data: 'onboard:basketball' },
            { text: '🏒 Hockey', callback_data: 'onboard:hockey' },
          ],
          [
            { text: '🏈 NFL', callback_data: 'onboard:nfl' },
            { text: '🎾 Tennis', callback_data: 'onboard:tennis' },
            { text: '🥊 MMA', callback_data: 'onboard:mma' },
          ],
          [
            { text: '🌐 All Sports', callback_data: 'onboard:all' },
          ],
          [
            { text: '⏭️ Skip setup — show me signals now', callback_data: 'onboard:skip' },
          ],
        ],
      },
    });
    lastBriefingTime.set(chatId, Date.now());
    return;
  }

  // Returning user — send live briefing (or demo)
  // Prime the persistent reply keyboard so it's available alongside the briefing's inline buttons
  await bot.sendMessage(chatId, '_Welcome back._', { parse_mode: 'Markdown', reply_markup: mainKeyboard() }).catch(() => {});
  if (ODDS_API_KEY && !isDemoMode()) {
    const thinking = await bot.sendMessage(chatId, '🔍 Scanning markets for you...');
    try {
      const briefing = await generateBriefing(chatId, 'welcome');
      await bot.deleteMessage(chatId, thinking.message_id).catch(() => {});
      if (briefing) {
        await bot.sendMessage(chatId, briefing, { parse_mode: 'Markdown', reply_markup: welcomeButtons() });
      } else {
        await bot.sendMessage(chatId, '*Ruflo Intelligence*\n\nNo events found right now. Markets may be between sessions.', { parse_mode: 'Markdown', reply_markup: welcomeButtons() });
      }
    } catch (err) {
      await bot.deleteMessage(chatId, thinking.message_id).catch(() => {});
      // If quota just got exhausted, show demo instead of error
      if (isDemoMode()) {
        await bot.sendMessage(chatId, generateDemoBriefing(chatId, 'welcome'), { parse_mode: 'Markdown', reply_markup: welcomeButtons() });
      } else {
        await bot.sendMessage(chatId, `*Ruflo Intelligence*\n\nCouldn't fetch live data: ${err.message}`, { parse_mode: 'Markdown', reply_markup: welcomeButtons() });
      }
    }
  } else {
    // No API key or quota exhausted — show demo briefing
    await bot.sendMessage(chatId, generateDemoBriefing(chatId, 'welcome'), { parse_mode: 'Markdown', reply_markup: welcomeButtons() });
  }

  lastBriefingTime.set(chatId, Date.now());
});

// --- /refer — referral program: share link, show stats, earn rewards ---
bot.onText(/\/refer/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = msg.chat.id;
  const link = buildReferralLink(chatId);
  const stats = getReferralStats(chatId);
  const shareText = encodeURIComponent(`Check out Ruflo — sports betting intelligence bot. Signup via my link and we both get a free month of Plus:\n${link}`);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${shareText}`;
  const lines = [
    '*🎁 Refer a friend, get a free month*',
    '',
    'Share your personal link. When a friend joins and subscribes to Plus, *both of you* get a free month.',
    '',
    '*Your link:*',
    '`' + link + '`',
    '',
    `*Your stats:* ${stats.invited} invited · ${stats.converted} converted`,
  ];
  if (!STRIPE_REFERRAL_COUPON) {
    lines.push('', '_Note: rewards are pending admin setup — your invites are being tracked and credited when live._');
  }
  bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: '📤 Share link', url: shareUrl }],
      ],
    },
  });
});

// --- /keyboard — show the persistent reply keyboard ---
bot.onText(/\/keyboard/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  bot.sendMessage(msg.chat.id, 'Keyboard enabled. Tap a button or type a question.', { reply_markup: mainKeyboard() });
});

// --- /hidekeyboard — hide the persistent reply keyboard ---
bot.onText(/\/hidekeyboard/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  bot.sendMessage(msg.chat.id, 'Keyboard hidden. Use /keyboard to bring it back.', { reply_markup: { remove_keyboard: true } });
});

// --- /stop command ---
bot.onText(/\/stop/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
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
  if (!gateRate(msg)) return;
  claudeSessions.delete(String(msg.chat.id));
  saveSessionsToFile();
  bot.sendMessage(msg.chat.id, 'Session cleared. Next message starts a fresh conversation.');
});

// --- /dir command ---
bot.onText(/\/dir/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  bot.sendMessage(msg.chat.id, `Working directory: \`${WORKING_DIR}\``, { parse_mode: 'Markdown' });
});

// --- /id command ---
bot.onText(/\/id/, (msg) => {
  if (!gateRate(msg)) return;
  bot.sendMessage(msg.chat.id, `Your user ID: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
});

// --- /status command ---
// Reports live bot health: uptime, session counts, working directory,
// allowed-user config, and current git working-tree state.
bot.onText(/\/status/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;

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
  if (!gateRate(msg)) return;
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
  let reply = `Task *#${id}* added: ${escapeMd(text)}`;
  if (deadline) reply += `\nDeadline: ${formatDate(deadline)}`;
  bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
});

bot.onText(/\/tasks/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
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
      lines.push(`  #${t.id} — ${escapeMd(t.text)}${dl}${overdue}`);
    }
  }
  if (completed.length > 0) {
    lines.push('\n*Completed:*');
    for (const t of completed.slice(-5)) {
      lines.push(`  ~#${t.id} — ${escapeMd(t.text)}~`);
    }
    if (completed.length > 5) lines.push(`  ...and ${completed.length - 5} more`);
  }
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/done\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = String(msg.chat.id);
  const taskId = parseInt(match[1], 10);
  const list = getUserTasks(chatId);
  const task = list.find(t => t.id === taskId);
  if (!task) { bot.sendMessage(msg.chat.id, `Task #${taskId} not found.`); return; }
  if (task.done) { bot.sendMessage(msg.chat.id, `Task #${taskId} is already done.`); return; }
  task.done = true;
  task.completedAt = new Date().toISOString();
  setUserTasks(chatId, list);
  bot.sendMessage(msg.chat.id, `Task *#${taskId}* marked as done: ~${escapeMd(task.text)}~`, { parse_mode: 'Markdown' });
});

bot.onText(/\/deltask\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = String(msg.chat.id);
  const taskId = parseInt(match[1], 10);
  const list = getUserTasks(chatId);
  const idx = list.findIndex(t => t.id === taskId);
  if (idx === -1) { bot.sendMessage(msg.chat.id, `Task #${taskId} not found.`); return; }
  const removed = list.splice(idx, 1)[0];
  setUserTasks(chatId, list);
  bot.sendMessage(msg.chat.id, `Deleted task *#${taskId}*: ${escapeMd(removed.text)}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/overdue/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
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
const ODDS_API_KEY = (process.env.ODDS_API_KEY || '').trim();
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

// --- DEMO MODE: realistic sample data when API unavailable ---
const DEMO_MODE = !ODDS_API_KEY;
let apiQuotaExhausted = false; // Set true on 401 errors
let apiQuotaExhaustedAt = 0;
// How long to stay in demo before retrying live API after a quota-exhausted 401.
// Odds API credits reset monthly, but we probe every 6h so recovery is automatic.
const API_QUOTA_RETRY_MS = 6 * 60 * 60 * 1000;

function isDemoMode() {
  // Auto-recover from transient quota exhaustion after the retry window.
  if (apiQuotaExhausted && (Date.now() - apiQuotaExhaustedAt) > API_QUOTA_RETRY_MS) {
    apiQuotaExhausted = false;
    log.info('[api] Retry window elapsed — attempting live API again');
  }
  return DEMO_MODE || apiQuotaExhausted;
}

function generateDemoEvents() {
  const now = new Date();
  const later = (h) => new Date(now.getTime() + h * 3600000).toISOString();
  return [
    {
      id: 'demo-1', sport_key: 'soccer_epl', sport_title: 'EPL',
      home_team: 'Arsenal', away_team: 'Chelsea', commence_time: later(3),
      bookmakers: [
        { title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.85 }, { name: 'Draw', price: 3.60 }, { name: 'Chelsea', price: 4.50 }] }] },
        { title: 'Bet365', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.90 }, { name: 'Draw', price: 3.50 }, { name: 'Chelsea', price: 4.33 }] }] },
        { title: 'Unibet', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.87 }, { name: 'Draw', price: 3.55 }, { name: 'Chelsea', price: 4.40 }] }] },
        { title: '888sport', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.91 }, { name: 'Draw', price: 3.40 }, { name: 'Chelsea', price: 4.50 }] }] },
      ],
    },
    {
      id: 'demo-2', sport_key: 'soccer_epl', sport_title: 'EPL',
      home_team: 'Liverpool', away_team: 'Man City', commence_time: later(5),
      bookmakers: [
        { title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Liverpool', price: 2.45 }, { name: 'Draw', price: 3.30 }, { name: 'Man City', price: 2.90 }] }] },
        { title: 'Bet365', markets: [{ key: 'h2h', outcomes: [{ name: 'Liverpool', price: 2.50 }, { name: 'Draw', price: 3.25 }, { name: 'Man City', price: 2.80 }] }] },
        { title: 'Betfair', markets: [{ key: 'h2h', outcomes: [{ name: 'Liverpool', price: 2.52 }, { name: 'Draw', price: 3.20 }, { name: 'Man City', price: 2.85 }] }] },
        { title: 'William Hill', markets: [{ key: 'h2h', outcomes: [{ name: 'Liverpool', price: 2.40 }, { name: 'Draw', price: 3.30 }, { name: 'Man City', price: 2.95 }] }] },
      ],
    },
    {
      id: 'demo-3', sport_key: 'soccer_spain_la_liga', sport_title: 'La Liga',
      home_team: 'Real Madrid', away_team: 'Barcelona', commence_time: later(8),
      bookmakers: [
        { title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Real Madrid', price: 2.10 }, { name: 'Draw', price: 3.40 }, { name: 'Barcelona', price: 3.50 }] }] },
        { title: 'Bet365', markets: [{ key: 'h2h', outcomes: [{ name: 'Real Madrid', price: 2.15 }, { name: 'Draw', price: 3.30 }, { name: 'Barcelona', price: 3.40 }] }] },
        { title: 'Unibet', markets: [{ key: 'h2h', outcomes: [{ name: 'Real Madrid', price: 2.12 }, { name: 'Draw', price: 3.35 }, { name: 'Barcelona', price: 3.45 }] }] },
      ],
    },
    {
      id: 'demo-4', sport_key: 'basketball_nba', sport_title: 'NBA',
      home_team: 'LA Lakers', away_team: 'Boston Celtics', commence_time: later(6),
      bookmakers: [
        { title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'LA Lakers', price: 2.20 }, { name: 'Boston Celtics', price: 1.72 }] }] },
        { title: 'Bet365', markets: [{ key: 'h2h', outcomes: [{ name: 'LA Lakers', price: 2.25 }, { name: 'Boston Celtics', price: 1.68 }] }] },
        { title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'LA Lakers', price: 2.18 }, { name: 'Boston Celtics', price: 1.74 }] }] },
      ],
    },
    {
      id: 'demo-5', sport_key: 'soccer_uefa_champs_league', sport_title: 'Champions League',
      home_team: 'Bayern Munich', away_team: 'PSG', commence_time: later(4),
      bookmakers: [
        { title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Bayern Munich', price: 1.75 }, { name: 'Draw', price: 3.80 }, { name: 'PSG', price: 4.80 }] }] },
        { title: 'Bet365', markets: [{ key: 'h2h', outcomes: [{ name: 'Bayern Munich', price: 1.80 }, { name: 'Draw', price: 3.70 }, { name: 'PSG', price: 4.60 }] }] },
        { title: 'Betfair', markets: [{ key: 'h2h', outcomes: [{ name: 'Bayern Munich', price: 1.78 }, { name: 'Draw', price: 3.75 }, { name: 'PSG', price: 4.70 }] }] },
      ],
    },
  ];
}

function generateDemoBriefing(chatId, context) {
  const demoTag = '`DEMO`';
  const lines = [];
  if (context === 'welcome') {
    lines.push(`*${t('here_found', chatId)}* ${demoTag}\n`);
  } else {
    lines.push(`*Market Briefing* ${demoTag}\n`);
  }
  lines.push(`📊 *5 ${t('events_scanned', chatId)}* 3 ${t('leagues', chatId)}\n`);
  lines.push(`💎 *${t('value_bets', chatId)} (2):*`);
  lines.push('  🟢 *4.2% edge* — Arsenal vs Chelsea');
  lines.push('  Arsenal @ 1.91 (888sport)');
  lines.push('');
  lines.push('  🟡 *3.1% edge* — Liverpool vs Man City');
  lines.push('  Liverpool @ 2.52 (Betfair)');
  lines.push('');
  lines.push(`🚨 *${t('sharp_move', chatId)}:*`);
  lines.push('  📈 Bayern Munich 1.80 → 1.75 (Pinnacle)');
  lines.push(`  _${t('smart_money_backing', chatId)} Bayern vs PSG_`);
  lines.push('');
  lines.push(`🔒 ${t('no_arbs', chatId)}`);
  lines.push('');
  lines.push(`_${t('demo_sample', chatId)}_`);
  return lines.join('\n');
}

const DEMO_LABEL = ' `DEMO`';
function demoNotice() { return isDemoMode() ? `\n\n_${isDemoMode() ? '📋 Demo data — ' : ''}connect Odds API for live markets_` : ''; }

// Full league catalog — grouped by sport
const LEAGUE_CATALOG = {
  // Soccer - Europe Top 5 + Cups
  soccer_epl:                  { name: 'Premier League',       sport: 'soccer', region: 'europe', tier: 1 },
  soccer_spain_la_liga:        { name: 'La Liga',              sport: 'soccer', region: 'europe', tier: 1 },
  soccer_germany_bundesliga:   { name: 'Bundesliga',           sport: 'soccer', region: 'europe', tier: 1 },
  soccer_italy_serie_a:        { name: 'Serie A',              sport: 'soccer', region: 'europe', tier: 1 },
  soccer_france_ligue_one:     { name: 'Ligue 1',              sport: 'soccer', region: 'europe', tier: 1 },
  soccer_uefa_champs_league:   { name: 'Champions League',     sport: 'soccer', region: 'europe', tier: 1 },
  soccer_uefa_europa_league:   { name: 'Europa League',        sport: 'soccer', region: 'europe', tier: 1 },
  soccer_uefa_europa_conf_league: { name: 'Conference League', sport: 'soccer', region: 'europe', tier: 2 },
  // Soccer - Other Europe
  soccer_netherlands_eredivisie: { name: 'Eredivisie',         sport: 'soccer', region: 'europe', tier: 2 },
  soccer_portugal_primeira_liga: { name: 'Primeira Liga',      sport: 'soccer', region: 'europe', tier: 2 },
  soccer_belgium_first_div:    { name: 'Belgian Pro League',   sport: 'soccer', region: 'europe', tier: 2 },
  soccer_turkey_super_league:  { name: 'Turkish Süper Lig',    sport: 'soccer', region: 'europe', tier: 2 },
  soccer_scotland_premiership: { name: 'Scottish Premiership', sport: 'soccer', region: 'europe', tier: 3 },
  soccer_switzerland_superleague: { name: 'Swiss Super League', sport: 'soccer', region: 'europe', tier: 3 },
  soccer_austria_bundesliga:   { name: 'Austrian Bundesliga',  sport: 'soccer', region: 'europe', tier: 3 },
  soccer_denmark_superliga:    { name: 'Danish Superliga',     sport: 'soccer', region: 'europe', tier: 3 },
  soccer_norway_eliteserien:   { name: 'Eliteserien',          sport: 'soccer', region: 'europe', tier: 3 },
  soccer_sweden_allsvenskan:   { name: 'Allsvenskan',          sport: 'soccer', region: 'europe', tier: 3 },
  soccer_poland_ekstraklasa:   { name: 'Ekstraklasa',          sport: 'soccer', region: 'europe', tier: 3 },
  soccer_greece_super_league:  { name: 'Greek Super League',   sport: 'soccer', region: 'europe', tier: 3 },
  // Soccer - South America
  soccer_brazil_campeonato:    { name: 'Brasileirão',          sport: 'soccer', region: 'south_america', tier: 2 },
  soccer_argentina_primera_division: { name: 'Argentina Primera', sport: 'soccer', region: 'south_america', tier: 2 },
  soccer_conmebol_copa_libertadores: { name: 'Copa Libertadores', sport: 'soccer', region: 'south_america', tier: 2 },
  // Soccer - Other
  soccer_usa_mls:              { name: 'MLS',                  sport: 'soccer', region: 'north_america', tier: 2 },
  soccer_australia_aleague:    { name: 'A-League',             sport: 'soccer', region: 'oceania', tier: 3 },
  soccer_japan_j_league:       { name: 'J-League',             sport: 'soccer', region: 'asia', tier: 3 },
  soccer_korea_kleague1:       { name: 'K-League',             sport: 'soccer', region: 'asia', tier: 3 },
  // Soccer - International
  soccer_fifa_world_cup:       { name: 'FIFA World Cup',       sport: 'soccer', region: 'international', tier: 1 },
  soccer_uefa_european_championship: { name: 'Euro Championship', sport: 'soccer', region: 'international', tier: 1 },
  soccer_fifa_world_cup_qualifier: { name: 'WC Qualifiers',    sport: 'soccer', region: 'international', tier: 2 },
  // Basketball
  basketball_nba:              { name: 'NBA',                  sport: 'basketball', region: 'north_america', tier: 1 },
  basketball_euroleague:       { name: 'EuroLeague',           sport: 'basketball', region: 'europe', tier: 2 },
  basketball_nba_championship_winner: { name: 'NBA Championship', sport: 'basketball', region: 'north_america', tier: 2 },
  // American Football
  americanfootball_nfl:        { name: 'NFL',                  sport: 'american_football', region: 'north_america', tier: 1 },
  americanfootball_ncaaf:      { name: 'NCAA Football',        sport: 'american_football', region: 'north_america', tier: 2 },
  // Ice Hockey
  icehockey_nhl:               { name: 'NHL',                  sport: 'ice_hockey', region: 'north_america', tier: 1 },
  icehockey_sweden_shl:        { name: 'SHL',                  sport: 'ice_hockey', region: 'europe', tier: 3 },
  icehockey_finland_liiga:     { name: 'Liiga',                sport: 'ice_hockey', region: 'europe', tier: 3 },
  // Baseball
  baseball_mlb:                { name: 'MLB',                  sport: 'baseball', region: 'north_america', tier: 1 },
  // Tennis
  tennis_atp_french_open:      { name: 'ATP French Open',      sport: 'tennis', region: 'international', tier: 2 },
  tennis_atp_wimbledon:        { name: 'ATP Wimbledon',        sport: 'tennis', region: 'international', tier: 2 },
  tennis_atp_us_open:          { name: 'ATP US Open',          sport: 'tennis', region: 'international', tier: 2 },
  tennis_atp_aus_open:         { name: 'ATP Australian Open',  sport: 'tennis', region: 'international', tier: 2 },
  // MMA
  mma_mixed_martial_arts:      { name: 'MMA/UFC',              sport: 'mma', region: 'international', tier: 1 },
  // Rugby
  rugbyunion_six_nations:      { name: 'Six Nations',          sport: 'rugby', region: 'europe', tier: 2 },
  // Cricket
  cricket_ipl:                 { name: 'IPL',                  sport: 'cricket', region: 'asia', tier: 2 },
  cricket_test_match:          { name: 'Test Matches',         sport: 'cricket', region: 'international', tier: 2 },
};

// Aliases for user-friendly commands (maps to league keys above)
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
  europa: 'soccer_uefa_europa_league',
  conference: 'soccer_uefa_europa_conf_league',
  eredivisie: 'soccer_netherlands_eredivisie',
  primeira: 'soccer_portugal_primeira_liga',
  mls: 'soccer_usa_mls',
  brasileirao: 'soccer_brazil_campeonato',
  libertadores: 'soccer_conmebol_copa_libertadores',
  nba: 'basketball_nba',
  euroleague: 'basketball_euroleague',
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
  nhl: 'icehockey_nhl',
  mlb: 'baseball_mlb',
  tennis: 'tennis_atp_french_open',
  mma: 'mma_mixed_martial_arts',
  ufc: 'mma_mixed_martial_arts',
  rugby: 'rugbyunion_six_nations',
  ipl: 'cricket_ipl',
  cricket: 'cricket_test_match',
};

// Default scanner leagues — top 5 only to conserve API credits
// Users can add more via /scanner leagues
// Top 5 soccer leagues — tuned for free-tier Odds API (500 credits/month).
// Scanner: 5 leagues × 3 scans/day (every 8h) = 450 calls/month, leaves headroom for user commands.
const DEFAULT_SCANNER_LEAGUES = [
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_italy_serie_a',
  'soccer_germany_bundesliga',
  'soccer_uefa_champs_league',
];

async function fetchOdds(sport, market = 'h2h') {
  if (isDemoMode()) return generateDemoEvents().filter(e => !sport || e.sport_key.includes(sport.toLowerCase()));
  const sportKey = SPORT_ALIASES[sport.toLowerCase()] || sport;
  const url = `${ODDS_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=${market}&oddsFormat=decimal`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    const err = new Error(`Odds API network error: ${e.message}`);
    err.code = 'API_DOWN';
    log.warn('[api] network error:', e.message);
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 && body.includes('OUT_OF_USAGE_CREDITS')) {
      apiQuotaExhausted = true; apiQuotaExhaustedAt = Date.now();
      log.warn('[api] Quota exhausted — switching to demo mode');
      return generateDemoEvents().filter(e => !sport || e.sport_key.includes(sport.toLowerCase()));
    }
    const err = new Error(`Odds API error ${res.status}: ${body.slice(0, 200)}`);
    err.code = 'API_DOWN';
    log.warn('[api] upstream error', res.status);
    throw err;
  }
  apiQuotaExhausted = false;
  return res.json();
}

async function fetchSports() {
  if (isDemoMode()) return [
    { key: 'soccer_epl', group: 'Soccer', title: 'EPL', active: true },
    { key: 'soccer_spain_la_liga', group: 'Soccer', title: 'La Liga', active: true },
    { key: 'soccer_uefa_champs_league', group: 'Soccer', title: 'Champions League', active: true },
    { key: 'basketball_nba', group: 'Basketball', title: 'NBA', active: true },
    { key: 'americanfootball_nfl', group: 'American Football', title: 'NFL', active: true },
  ];
  let res;
  try {
    res = await fetch(`${ODDS_BASE}/sports/?apiKey=${ODDS_API_KEY}`);
  } catch (e) {
    const err = new Error(`Odds API network error: ${e.message}`);
    err.code = 'API_DOWN';
    log.warn('[api] network error (sports):', e.message);
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 && body.includes('OUT_OF_USAGE_CREDITS')) {
      apiQuotaExhausted = true; apiQuotaExhaustedAt = Date.now();
      return fetchSports(); // retry — will hit demo mode now
    }
    const err = new Error(`Odds API error ${res.status}`);
    err.code = 'API_DOWN';
    throw err;
  }
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
const ODDS_CACHE_FILE = stateFile('odds_cache.json');
function loadOddsCache() { try { return JSON.parse(fs.readFileSync(ODDS_CACHE_FILE, 'utf8')); } catch { return {}; } }
function saveOddsCache(cache) { atomicWriteJson(ODDS_CACHE_FILE, cache, false); }
const oddsCache = loadOddsCache(); // { eventId: { timestamp, odds: { outcomeName: { bookmaker: price } } } }

// Odds history — keeps multiple snapshots per event for line movement tracking
// { eventId: { name, snapshots: [{ ts, odds: { outcomeName: { bookmaker: price } } }] } }
const ODDS_HISTORY_FILE = stateFile('odds_history.json');
const MAX_SNAPSHOTS_PER_EVENT = 48; // ~2.4 hours at 3-min intervals, enough to spot trends
const MAX_HISTORY_EVENTS = 500; // cap total events to keep file manageable

function loadOddsHistory() {
  try { return JSON.parse(fs.readFileSync(ODDS_HISTORY_FILE, 'utf8')); } catch { return {}; }
}
function saveOddsHistory(history) {
  atomicWriteJson(ODDS_HISTORY_FILE, history, false);
}
const oddsHistory = loadOddsHistory();

// Record a snapshot into odds history and return sharp signals
function recordOddsSnapshot(events) {
  const now = Date.now();
  const signals = []; // { type, event, outcome, bookmaker, oldPrice, newPrice, change, direction, age }

  for (const ev of events) {
    const key = ev.id;
    const name = `${ev.home_team} vs ${ev.away_team}`;
    const current = {};
    for (const bm of (ev.bookmakers || [])) {
      for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
        for (const out of mkt.outcomes) {
          if (!current[out.name]) current[out.name] = {};
          current[out.name][bm.title] = out.price;
        }
      }
    }

    if (!oddsHistory[key]) {
      oddsHistory[key] = { name, commence: ev.commence_time, snapshots: [] };
    }
    oddsHistory[key].name = name;

    const snaps = oddsHistory[key].snapshots;
    const prevSnap = snaps.length > 0 ? snaps[snaps.length - 1] : null;

    // Detect sharp signals by comparing to previous snapshot
    if (prevSnap) {
      const ageMins = Math.round((now - prevSnap.ts) / 60000);
      for (const [outcome, books] of Object.entries(current)) {
        for (const [bookmaker, price] of Object.entries(books)) {
          const oldPrice = prevSnap.odds?.[outcome]?.[bookmaker];
          if (!oldPrice) continue;
          const change = price - oldPrice;
          if (Math.abs(change) < 0.03) continue; // ignore tiny noise

          const isSharpBook = SHARP_BOOKS.some(s => bookmaker.toLowerCase().includes(s.toLowerCase()));
          const isBigMove = Math.abs(change) >= 0.10;
          const isSteam = isSharpBook && Math.abs(change) >= 0.05;

          if (isSteam || isBigMove) {
            signals.push({
              type: isSteam ? 'STEAM' : 'MOVE',
              event: name,
              eventId: key,
              commence: ev.commence_time,
              outcome, bookmaker,
              oldPrice, newPrice: price,
              change,
              direction: price > oldPrice ? 'UP' : 'DOWN',
              isSharpBook,
              ageMins,
            });
          }
        }
      }
    }

    // Also detect reverse line movement (RLM)
    // RLM = line moves OPPOSITE to where public money should push it
    // Heuristic: if most books move one way but sharp books move the other way
    if (prevSnap) {
      for (const outcome of Object.keys(current)) {
        let sharpDir = 0, softDir = 0;
        for (const [bookmaker, price] of Object.entries(current[outcome] || {})) {
          const oldPrice = prevSnap.odds?.[outcome]?.[bookmaker];
          if (!oldPrice || Math.abs(price - oldPrice) < 0.03) continue;
          const dir = price > oldPrice ? 1 : -1;
          const isSharp = SHARP_BOOKS.some(s => bookmaker.toLowerCase().includes(s.toLowerCase()));
          if (isSharp) sharpDir += dir; else softDir += dir;
        }
        // RLM: sharp and soft moving opposite directions
        if (sharpDir !== 0 && softDir !== 0 && Math.sign(sharpDir) !== Math.sign(softDir)) {
          signals.push({
            type: 'RLM',
            event: name,
            eventId: key,
            commence: ev.commence_time,
            outcome,
            bookmaker: 'market-wide',
            sharpDirection: sharpDir > 0 ? 'UP' : 'DOWN',
            softDirection: softDir > 0 ? 'UP' : 'DOWN',
            oldPrice: 0, newPrice: 0, change: 0,
            direction: sharpDir > 0 ? 'UP' : 'DOWN',
            isSharpBook: true,
            ageMins: Math.round((now - prevSnap.ts) / 60000),
          });
        }
      }
    }

    // Store snapshot
    snaps.push({ ts: now, odds: current });
    if (snaps.length > MAX_SNAPSHOTS_PER_EVENT) snaps.splice(0, snaps.length - MAX_SNAPSHOTS_PER_EVENT);
  }

  // Prune old events (past commence time + 4 hours)
  const cutoff = now - 4 * 60 * 60 * 1000;
  for (const [key, entry] of Object.entries(oddsHistory)) {
    if (entry.commence && new Date(entry.commence).getTime() < cutoff) {
      delete oddsHistory[key];
    }
  }
  // Cap total events
  const keys = Object.keys(oddsHistory);
  if (keys.length > MAX_HISTORY_EVENTS) {
    const sorted = keys.sort((a, b) => {
      const aLast = oddsHistory[a].snapshots?.at(-1)?.ts || 0;
      const bLast = oddsHistory[b].snapshots?.at(-1)?.ts || 0;
      return aLast - bLast;
    });
    for (let i = 0; i < sorted.length - MAX_HISTORY_EVENTS; i++) delete oddsHistory[sorted[i]];
  }

  saveOddsHistory(oddsHistory);
  return signals;
}

// Get line movement summary for an event (from history)
function getLineMovement(eventId) {
  const entry = oddsHistory[eventId];
  if (!entry || entry.snapshots.length < 2) return null;
  const first = entry.snapshots[0];
  const last = entry.snapshots[entry.snapshots.length - 1];
  const movements = {};
  for (const [outcome, books] of Object.entries(last.odds)) {
    for (const [bookmaker, price] of Object.entries(books)) {
      const opening = first.odds?.[outcome]?.[bookmaker];
      if (!opening || Math.abs(price - opening) < 0.02) continue;
      if (!movements[outcome]) movements[outcome] = [];
      movements[outcome].push({
        bookmaker, opening, current: price,
        change: price - opening,
        direction: price > opening ? 'UP' : 'DOWN',
        isSharp: SHARP_BOOKS.some(s => bookmaker.toLowerCase().includes(s.toLowerCase())),
      });
    }
  }
  return {
    name: entry.name,
    snapshots: entry.snapshots.length,
    timespan: Math.round((last.ts - first.ts) / 60000),
    movements,
  };
}

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
  plus:      { name: 'Plus',               price: '€50/mo',  maxSignals: 20, maxArbs: 10, features: ['basic_odds', 'basic_value', 'arb', 'sharp', 'moves', 'consensus', 'bias', 'kelly', 'signals', 'xarb', 'predict'] },
  plusmax:   { name: 'Plus Max',           price: '€300/mo', maxSignals: -1, maxArbs: -1, features: ['*'] },
  // Legacy aliases (backwards compat for existing user data)
  pro:       { name: 'Plus',               price: '€50/mo',  maxSignals: 20, maxArbs: 10, features: ['basic_odds', 'basic_value', 'arb', 'sharp', 'moves', 'consensus', 'bias', 'kelly', 'signals', 'xarb', 'predict'] },
  syndicate: { name: 'Plus Max',           price: '€300/mo', maxSignals: -1, maxArbs: -1, features: ['*'] },
};

let _tiersCache = null;
function loadTiers() {
  if (_tiersCache) return _tiersCache;
  try { _tiersCache = JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8')); }
  catch { _tiersCache = {}; }
  return _tiersCache;
}
function saveTiers(data) { atomicWriteJson(TIERS_FILE, data); _tiersCache = data; }
function getUserTier(chatId) { return loadTiers()[String(chatId)] || 'plusmax'; }
function setUserTier(chatId, tier) { const d = { ...loadTiers() }; d[String(chatId)] = tier; saveTiers(d); }
function hasFeature(chatId, feature) {
  const tier = getUserTier(chatId);
  const t = TIERS[tier];
  return t.features.includes('*') || t.features.includes(feature);
}
function tierGate(chatId, feature) {
  if (hasFeature(chatId, feature)) return null;
  const tier = getUserTier(chatId);
  return `This feature requires a higher tier. You're on *${TIERS[tier].name}* (${TIERS[tier].price}).\n\nUpgrade with /subscribe to unlock.`;
}

// --- User Settings (configurable EV threshold, etc.) ---
let _userSettingsCache = null;
function loadUserSettings() {
  if (_userSettingsCache) return _userSettingsCache;
  try { _userSettingsCache = JSON.parse(fs.readFileSync(USER_SETTINGS_FILE, 'utf8')); }
  catch { _userSettingsCache = {}; }
  return _userSettingsCache;
}
function saveUserSettings(data) { atomicWriteJson(USER_SETTINGS_FILE, data); _userSettingsCache = data; }
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

// --- Daily activity tracker ---
// Writes lastSeenDay (YYYY-MM-DD) to user_settings at most once per user per day.
// Used by /admin stats to compute DAU/WAU without heavy telemetry.
function todayUtc() { return new Date().toISOString().slice(0, 10); }
function markSeen(chatId) {
  const today = todayUtc();
  const all = loadUserSettings();
  const key = String(chatId);
  if (!all[key]) all[key] = {};
  if (all[key].lastSeenDay === today) return; // already recorded
  all[key].lastSeenDay = today;
  saveUserSettings(all);
}

// --- Admin auth ---
// TELEGRAM_ADMIN_USERS — comma-separated Telegram user IDs with /admin access.
// Empty = no admins (command returns "not authorized" for everyone, including allowed users).
const ADMIN_USERS = process.env.TELEGRAM_ADMIN_USERS
  ? process.env.TELEGRAM_ADMIN_USERS.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))
  : [];
function isAdmin(userId) { return ADMIN_USERS.includes(userId); }

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
function saveArbPersistence(data) { atomicWriteJson(ARB_PERSIST_FILE, data); }

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
function saveBias(data) { atomicWriteJson(BIAS_FILE, data); }

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
  if (isDemoMode()) return generateDemoEvents().filter(e => e.sport_key.startsWith('soccer'));
  const url = `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 && body.includes('OUT_OF_USAGE_CREDITS')) {
      apiQuotaExhausted = true; apiQuotaExhaustedAt = Date.now();
      log.info('[api] Quota exhausted — switching to demo mode');
      return generateDemoEvents().filter(e => e.sport_key.startsWith('soccer'));
    }
    throw new Error(`API error ${res.status}: ${body.slice(0, 200)}`);
  }
  apiQuotaExhausted = false;
  return res.json();
}

// /value [today] — find +EV bets vs sharp lines
bot.onText(/\/value\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */

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
      replyError(msg.chat.id, err);
    }
  });
});

// /arb [today] — scan for arbitrage opportunities
bot.onText(/\/arb\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */

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
      replyError(msg.chat.id, err);
    }
  });
});

// /moves [today] — show odds movements since last check
bot.onText(/\/moves\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */

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
      replyError(msg.chat.id, err);
    }
  });
});

// /sharp [today] — sharp money intelligence: true probs, line movement, steam, RLM
bot.onText(/\/sharp\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */

  const arg = (match[1] || '').trim().toLowerCase();
  const dayFilter = arg === 'today' ? 'today' : arg === 'tomorrow' ? 'tomorrow' : null;

  bot.sendMessage(msg.chat.id, 'Analyzing sharp money signals...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const filtered = filterByDay(events, dayFilter);

      // Record snapshot and get real-time sharp signals
      const sharpSignals = recordOddsSnapshot(filtered);
      const steamSignals = sharpSignals.filter(s => s.type === 'STEAM');
      const rlmSignals = sharpSignals.filter(s => s.type === 'RLM');
      const bigMoves = sharpSignals.filter(s => s.type === 'MOVE');

      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      const lines = [];

      // Section 1: Steam moves (highest priority sharp signal)
      if (steamSignals.length) {
        lines.push('*STEAM MOVES*');
        lines.push('_Sharp books moved fast — likely informed money_\n');
        for (const s of steamSignals.slice(0, 8)) {
          const arrow = s.direction === 'UP' ? '📈' : '📉';
          const time = new Date(s.commence).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          lines.push(`${arrow} *${s.event}* — ${time}`);
          lines.push(`  ${s.outcome}: ${s.oldPrice.toFixed(2)} → *${s.newPrice.toFixed(2)}* (${s.bookmaker})`);
          lines.push(`  Move: ${s.change > 0 ? '+' : ''}${s.change.toFixed(2)} in ~${s.ageMins}min`);
          lines.push('');
        }
      }

      // Section 2: Reverse line movement (smart money vs public)
      if (rlmSignals.length) {
        lines.push('*REVERSE LINE MOVEMENT*');
        lines.push('_Sharp books moving OPPOSITE to public — contrarian signal_\n');
        for (const s of rlmSignals.slice(0, 5)) {
          const time = new Date(s.commence).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          lines.push(`*${s.event}* — ${time}`);
          lines.push(`  ${s.outcome}: Sharps ${s.sharpDirection} / Public ${s.softDirection}`);
          lines.push(`  Follow the sharp side (${s.sharpDirection})`);
          lines.push('');
        }
      }

      // Section 3: Big moves across any book
      if (bigMoves.length) {
        lines.push('*SIGNIFICANT MOVES*');
        lines.push('_Lines moving 10+ cents — market recalibrating_\n');
        for (const s of bigMoves.slice(0, 8)) {
          const arrow = s.direction === 'UP' ? '↑' : '↓';
          lines.push(`${arrow} ${s.event} | ${s.outcome}: ${s.oldPrice.toFixed(2)} → ${s.newPrice.toFixed(2)} (${s.bookmaker})`);
        }
        lines.push('');
      }

      // Section 4: Historical line movement from odds history
      const lineMovements = [];
      for (const ev of filtered.slice(0, 20)) {
        const lm = getLineMovement(ev.id);
        if (!lm || Object.keys(lm.movements).length === 0) continue;
        lineMovements.push({ ...lm, commence: ev.commence_time, id: ev.id });
      }
      if (lineMovements.length) {
        lines.push('*LINE MOVEMENT TRACKER*');
        lines.push(`_Opening vs current odds (${lineMovements[0]?.snapshots || 0} snapshots tracked)_\n`);
        for (const lm of lineMovements.slice(0, 8)) {
          const time = new Date(lm.commence).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          lines.push(`*${lm.name}* — ${time} (${lm.timespan}min tracked)`);
          for (const [outcome, moves] of Object.entries(lm.movements)) {
            const sharpMove = moves.find(m => m.isSharp);
            const biggestMove = moves.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
            const m = sharpMove || biggestMove;
            const arrow = m.direction === 'UP' ? '↑' : '↓';
            const tag = m.isSharp ? ' (SHARP)' : '';
            lines.push(`  ${arrow} ${outcome}: ${m.opening.toFixed(2)} → ${m.current.toFixed(2)} (${m.change > 0 ? '+' : ''}${m.change.toFixed(2)})${tag}`);
          }
          lines.push('');
        }
      }

      // Section 5: Sharp true probabilities (always show as baseline)
      let pinCount = 0;
      const pinLines = [];
      for (const ev of filtered.slice(0, 10)) {
        const pinOdds = getPinnacleOdds(ev.bookmakers || []);
        if (!pinOdds) continue;
        pinCount++;
        const pinOutcomes = Object.entries(pinOdds).map(([name, price]) => ({ name, price }));
        const trueProbs = removeVig(pinOutcomes);
        const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        pinLines.push(`*${ev.home_team} vs ${ev.away_team}* — ${time}`);
        for (const tp of trueProbs) {
          pinLines.push(`  ${tp.name}: ${tp.price.toFixed(2)} → true *${(tp.impliedProb * 100).toFixed(1)}%*`);
        }
        pinLines.push('');
      }
      if (pinCount) {
        lines.push('*TRUE PROBABILITIES (vig-free)*');
        lines.push('_Pinnacle/Betfair — sharpest lines in market_\n');
        lines.push(...pinLines);
      }

      if (!lines.length) {
        bot.sendMessage(msg.chat.id, 'No sharp signals detected yet. The scanner needs at least 2 data points to detect movement — run again in a few minutes or enable /scanner for continuous tracking.');
        return;
      }

      // Summary
      const summary = [];
      if (steamSignals.length) summary.push(`${steamSignals.length} steam`);
      if (rlmSignals.length) summary.push(`${rlmSignals.length} RLM`);
      if (bigMoves.length) summary.push(`${bigMoves.length} big moves`);
      if (lineMovements.length) summary.push(`${lineMovements.length} tracked`);
      if (pinCount) summary.push(`${pinCount} sharp lines`);
      lines.unshift(`*Sharp Money Intelligence*`);
      lines.splice(1, 0, `_${summary.join(' | ')}_\n`);

      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      replyError(msg.chat.id, err);
    }
  });
});

// /odds <sport> [today|tomorrow] — get odds filtered by day
bot.onText(/\/odds\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed — fetchOdds handles fallback */
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
      replyError(msg.chat.id, err);
    }
  });
});

// /sports — list available sports
bot.onText(/\/sports/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed — fetchSports handles fallback */

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
    replyError(msg.chat.id, err);
  });
});

// /soccer [today] — today's soccer matches with 1X2, handicap, and over/under odds.
// Fetches h2h + spreads + totals markets in one call and filters to games
// kicking off within the current calendar day (UTC).
bot.onText(/\/soccer/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed — fetchAllSoccer handles fallback */

  bot.sendMessage(msg.chat.id, 'Fetching today\'s soccer matches...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();

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
      replyError(msg.chat.id, err);
    }
  });
});

// /hot — most popular upcoming events (most bookmakers covering them)
bot.onText(/\/hot/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed — fetchOdds handles fallback */

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
      replyError(msg.chat.id, err);
    }
  });
});

// /analyze [sport] — betting analysis summary
bot.onText(/\/analyze\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed — fetchOdds handles fallback */

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
      replyError(msg.chat.id, err);
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

    log.info(`[workflow] ${workflowName} step ${i + 1}/${workflow.steps.length}: ${step.label}`);

    try {
      const response = await runClaude(step.prompt(description), chatId);
      log.info(`[workflow] ${step.label} done, response length: ${response.length}`);
      await sendResponse(chatId, `*${step.label}:*\n\n${response}`, originalMsgId);
    } catch (err) {
      log.info(`[workflow] ${step.label} error: ${err.message}`);
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
  if (!gateRate(msg)) return;
  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, 'Already processing. Use /stop to cancel.');
    return;
  }
  runWorkflow(msg.chat.id, 'ship', match[1].trim(), msg.message_id);
});

// /fix <description>
bot.onText(/\/fix\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, 'Already processing. Use /stop to cancel.');
    return;
  }
  runWorkflow(msg.chat.id, 'fix', match[1].trim(), msg.message_id);
});

// /refactor <description>
bot.onText(/\/refactor\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, 'Already processing. Use /stop to cancel.');
    return;
  }
  runWorkflow(msg.chat.id, 'refactor', match[1].trim(), msg.message_id);
});

// /review <description>
bot.onText(/\/review\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, 'Already processing. Use /stop to cancel.');
    return;
  }
  runWorkflow(msg.chat.id, 'review', match[1].trim(), msg.message_id);
});

// /workflows — list available workflows
bot.onText(/\/workflows/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
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
    bot.sendMessage(parseInt(chatId, 10), lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
  }
}

let lastReminderDate = '';
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  // Widened minute window (<2) to tolerate setInterval drift — if the bot
  // booted at HH:MM:30, strict minute===0 would never match.
  if (now.getHours() === DAILY_REMINDER_HOUR && now.getMinutes() < 2 && lastReminderDate !== today) {
    lastReminderDate = today;
    sendDailyReminders();
  }
}, 60_000);

// --- Inline keyboard callback handler (apply / revert / cmd buttons) ---
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const chatId = query.message?.chat?.id;
  if (!chatId || !query.from) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }
  if (!isAllowed(query.from.id)) {
    await bot.answerCallbackQuery(query.id, { text: 'Not authorized.' }).catch(() => {});
    return;
  }
  if (!gateRate({ chat: { id: chatId }, from: query.from })) {
    await bot.answerCallbackQuery(query.id, { text: 'Slow down.' }).catch(() => {});
    return;
  }

  // Handle stripe: button presses — subscription actions
  if (data.startsWith('stripe:')) {
    const action = data.slice(7);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    ).catch(() => {});

    if (action === 'plus' || action === 'plusmax') {
      // Create checkout session
      if (!stripe || !STRIPE_PRICES[action]) {
        bot.sendMessage(chatId, 'Payments not configured for this tier.');
        return;
      }
      try {
        const session = await createCheckoutSession(chatId, action);
        bot.sendMessage(chatId, [
          `*Upgrade to ${TIERS[action].name}* (${TIERS[action].price})\n`,
          'Click below to complete payment:',
        ].join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: `💳 Pay ${TIERS[action].price}`, url: session.url }]] },
        });
      } catch (err) {
        replyError(chatId, err);
      }
    } else if (action === 'trial') {
      if (!stripe || !STRIPE_PRICES.plus) {
        bot.sendMessage(chatId, t('trial_unavailable', chatId), { parse_mode: 'Markdown' });
        return;
      }
      if (!isTrialEligible(chatId)) {
        const sub = getUserSubscription(chatId);
        const key = sub?.stripeSubscriptionId && (sub.status === 'active' || sub.status === 'trialing')
          ? 'trial_active_sub'
          : 'trial_already_used';
        bot.sendMessage(chatId, t(key, chatId), { parse_mode: 'Markdown' });
        return;
      }
      try {
        const session = await createCheckoutSession(chatId, 'plus', { trialDays: 7 });
        bot.sendMessage(chatId, t('trial_cta', chatId), {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: t('trial_button', chatId), url: session.url }]] },
        });
      } catch (err) {
        replyError(chatId, err);
      }
    } else if (action === 'cancel') {
      try {
        const sub = await cancelSubscription(chatId);
        const endDate = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'end of period';
        bot.sendMessage(chatId, `*Subscription cancellation scheduled.*\n\nYou'll keep access until *${endDate}*.\n\n_Changed your mind? Use /billing to reactivate._`, { parse_mode: 'Markdown' });
      } catch (err) {
        replyError(chatId, err);
      }
    } else if (action === 'reactivate') {
      try {
        await reactivateSubscription(chatId);
        bot.sendMessage(chatId, '✅ *Subscription reactivated!*\n\nYour plan will continue as normal.', { parse_mode: 'Markdown' });
      } catch (err) {
        replyError(chatId, err);
      }
    }
    return;
  }

  // Handle onboarding sport selection
  if (data.startsWith('onboard:')) {
    const choice = data.slice(8);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});

    const sportMap = {
      soccer: ['soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_uefa_champs_league'],
      basketball: ['basketball_nba', 'basketball_euroleague'],
      hockey: ['icehockey_nhl'],
      nfl: ['americanfootball_nfl'],
      tennis: ['tennis_atp_french_open', 'tennis_atp_wimbledon'],
      mma: ['mma_mixed_martial_arts'],
    };

    let leagues;
    if (choice === 'all' || choice === 'skip') {
      leagues = DEFAULT_SCANNER_LEAGUES;
    } else {
      leagues = sportMap[choice] || DEFAULT_SCANNER_LEAGUES;
    }

    // Save preferences
    setUserSetting(chatId, 'favSports', choice === 'all' ? ['all'] : [choice]);
    const scannerState = loadScannerState();
    if (scannerState.subscribers[String(chatId)]) {
      scannerState.subscribers[String(chatId)].leagues = leagues;
      saveScannerState(scannerState);
    }

    if (choice === 'skip') {
      // Prime the persistent keyboard, then jump to signals
      await bot.sendMessage(chatId, '_Setup skipped — jumping in._', { parse_mode: 'Markdown', reply_markup: mainKeyboard() }).catch(() => {});
      bot.emit('message', { chat: { id: chatId }, from: query.from, text: '/signals', message_id: query.message.message_id });
    } else {
      const sportLabel = choice === 'all' ? 'all sports' : choice;
      // Prime the persistent reply keyboard alongside the inline menu
      await bot.sendMessage(chatId, '_Setup complete._', { parse_mode: 'Markdown', reply_markup: mainKeyboard() }).catch(() => {});
      await bot.sendMessage(chatId, [
        `*Setup complete!* Tracking ${sportLabel}.\n`,
        'I\'ll push alerts when I find opportunities. Here\'s what you can do:\n',
        '  📊 *Signals* — best opportunities right now',
        '  🔒 *Arbs* — guaranteed profit across bookmakers',
        '  🚨 *Sharp* — Pinnacle line movements',
        '  💰 *Bankroll* — track your bets and P&L\n',
        '_Alerts are ON — I\'ll message you automatically when I find something._\n',
        '_Tap any button on the keyboard below to get started, or use /hidekeyboard to hide it._',
      ].join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: mainMenuButtons(),
      });
    }
    return;
  }

  // Handle notification preference buttons
  if (data.startsWith('pref:')) {
    const pref = data.slice(5);
    await bot.answerCallbackQuery(query.id).catch(() => {});

    if (pref === 'arbs_only') {
      setUserSetting(chatId, 'notifyArbs', true);
      setUserSetting(chatId, 'notifyValue', false);
      setUserSetting(chatId, 'notifySteam', false);
      await bot.sendMessage(chatId, '✅ You\'ll only receive *arbitrage* alerts.', { parse_mode: 'Markdown' });
    } else if (pref === 'value_only') {
      setUserSetting(chatId, 'notifyArbs', false);
      setUserSetting(chatId, 'notifyValue', true);
      setUserSetting(chatId, 'notifySteam', false);
      await bot.sendMessage(chatId, '✅ You\'ll only receive *value bet* alerts.', { parse_mode: 'Markdown' });
    } else if (pref === 'all_alerts') {
      setUserSetting(chatId, 'notifyArbs', true);
      setUserSetting(chatId, 'notifyValue', true);
      setUserSetting(chatId, 'notifySteam', true);
      await bot.sendMessage(chatId, '✅ All alerts enabled (arbs + value + steam moves).', { parse_mode: 'Markdown' });
    } else if (pref === 'quiet_night') {
      setUserSetting(chatId, 'quietHours', { start: 23, end: 8 });
      await bot.sendMessage(chatId, '🌙 Quiet hours set: *23:00 — 08:00*. No alerts during this window.', { parse_mode: 'Markdown' });
    } else if (pref === 'quiet_off') {
      setUserSetting(chatId, 'quietHours', null);
      await bot.sendMessage(chatId, '🔔 Quiet hours disabled. Alerts will come through 24/7.', { parse_mode: 'Markdown' });
    } else if (pref.startsWith('minedge_')) {
      const edge = parseFloat(pref.split('_')[1]) / 100;
      setUserSetting(chatId, 'minEdge', edge);
      await bot.sendMessage(chatId, `✅ Minimum edge set to *${(edge * 100).toFixed(0)}%*. Only signals above this threshold.`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // Handle lang: button presses — switch language
  if (data.startsWith('lang:')) {
    const lang = data.slice(5);
    setUserLang(chatId, lang);
    await bot.answerCallbackQuery(query.id, { text: t('lang_changed', chatId) }).catch(() => {});
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    await bot.sendMessage(chatId, t('lang_changed', chatId));
    return;
  }

  // Handle cmd: button presses — simulate a slash command
  if (data.startsWith('cmd:')) {
    const command = '/' + data.slice(4);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    // Remove buttons from the message that was clicked
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    ).catch(() => {});
    // Simulate the command by sending it as a message from the user
    // This triggers the existing onText handlers
    bot.emit('message', {
      chat: { id: chatId },
      from: query.from,
      text: command,
      message_id: query.message.message_id,
    });
    return;
  }

  const [action, chatIdStr] = data.split(':');
  const cid = parseInt(chatIdStr, 10);

  if (action === 'apply') {
    pendingChanges.delete(cid);
    await bot.answerCallbackQuery(query.id, { text: 'Changes applied!' });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
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
      { chat_id: chatId, message_id: query.message.message_id }
    ).catch(() => {});
    await bot.sendMessage(cid, '❌ Changes reverted.', {
      reply_to_message_id: query.message.message_id,
    }).catch(() => {});
  }
});

// --- Handle messages ---
bot.on('message', async (msg) => {
  // Track daily activity for /admin stats (cheap — disk write at most once per user per day).
  // Fires for ALL messages including slash commands, before any early returns.
  // Also triggers a "welcome back" nudge if user has been away 3+ days.
  if (msg.from && msg.chat && isAllowed(msg.from.id)) {
    try {
      const allSettings = loadUserSettings();
      const key = String(msg.chat.id);
      const prev = allSettings[key]?.lastSeenDay;
      markSeen(msg.chat.id);
      if (prev && hasAcceptedLegal(msg.chat.id)) {
        const daysAway = Math.floor((new Date(todayUtc()) - new Date(prev)) / (24 * 60 * 60 * 1000));
        if (daysAway >= 3) {
          const name = escapeMd(msg.from.first_name || 'there');
          bot.sendMessage(msg.chat.id, `Hey ${name}, welcome back! You've been away ${daysAway} days. Let me catch you up 👇`, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '📊 What did I miss?', callback_data: 'cmd:signals' },
                  { text: '💰 My bankroll', callback_data: 'cmd:bankroll' },
                ],
              ],
            },
          }).catch(() => {});
        }
      }
    } catch {}
  }
  if (msg.text?.startsWith('/')) return;
  if (!msg.text) return;
  if (!msg.from || !msg.chat) return; // channel posts have no `from`
  if (!isAllowed(msg.from.id)) {
    bot.sendMessage(msg.chat.id, 'Unauthorized. Use /id to get your user ID and add it to TELEGRAM_ALLOWED_USERS.');
    return;
  }
  // Legal gate — block all non-slash messages until user has accepted ToS
  if (!hasAcceptedLegal(msg.chat.id)) {
    bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: '/start', message_id: msg.message_id });
    return;
  }
  // Rate limit natural-language path too
  if (!gateRate(msg)) return;

  // --- Auto-detect language on first interaction ---
  const storedLang = loadUserLangs()[String(msg.chat.id)];
  if (!storedLang && msg.from?.language_code) {
    const detected = detectLangFromTelegram(msg);
    if (detected !== 'en') setUserLang(msg.chat.id, detected);
  }

  // --- Language switch request ---
  const langLower = msg.text.toLowerCase().trim();
  for (const ls of LANG_SWITCH_PATTERNS) {
    if (ls.pattern.test(langLower)) {
      setUserLang(msg.chat.id, ls.lang);
      await bot.sendMessage(msg.chat.id, t('lang_changed', msg.chat.id));
      return;
    }
  }

  // --- Natural Language Router: match betting-related intents ---
  const intent = matchIntent(msg.text);
  if (intent && intent.command) {
    // Track context for conversational memory
    const sportMatch = intent.command.match(/\/odds\s+(\w+)/);
    if (sportMatch) setUserContext(msg.chat.id, { lastSport: sportMatch[1], lastCommand: intent.command });
    else setUserContext(msg.chat.id, { lastCommand: intent.command });

    // Simulate the slash command
    bot.emit('message', {
      chat: { id: msg.chat.id },
      from: msg.from,
      text: intent.command,
      message_id: msg.message_id,
    });
    return;
  }

  // --- Conversational follow-ups ("more", "tomorrow", "what about NBA?") ---
  const lower = msg.text.toLowerCase().trim();
  const ctx = getActiveContext(msg.chat.id);

  // "more" / "again" / "refresh" → repeat last command
  if (/^(more|again|refresh|show more|next|another)$/i.test(lower) && ctx.lastCommand) {
    bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: ctx.lastCommand, message_id: msg.message_id });
    return;
  }
  // "tomorrow" / "today" → repeat last command with day modifier
  if (/^(tomorrow|today)$/i.test(lower) && ctx.lastCommand) {
    const cmd = ctx.lastCommand.replace(/\s+(today|tomorrow)$/, '') + ' ' + lower;
    bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: cmd, message_id: msg.message_id });
    return;
  }
  // "yes" / "yeah" / "sure" → repeat last or show briefing
  if (/^(yes|yeah|yep|sure|ok|yea|go|do it)$/i.test(lower)) {
    if (ctx.lastCommand) {
      bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: ctx.lastCommand, message_id: msg.message_id });
    } else {
      bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: '/signals', message_id: msg.message_id });
    }
    return;
  }
  // Greeting → auto-show briefing with today's signals (multilingual)
  if (/^(hi|hey|hello|yo|sup|good\s*(morning|afternoon|evening)|gm|hola|howdy|what'?s?\s*up|bonjour|ciao|bok|cześć|czesc|ahoj|nazdar|merhaba|salut|hej|morgen|guten\s*tag|buenas?|olá|ola|dobrý\s*deň|dobré\s*ráno|dobry\s*den|servus|grüß\s*gott|bom\s*dia|buongiorno|buna|dzień\s*dobry|dzien\s*dobry|god\s*dag|god\s*morgen)\b/i.test(lower)) {
    const name = escapeMd(msg.from.first_name || 'there');
    const hour = new Date().getHours();
    const greetKey = hour < 12 ? 'greeting_morning' : hour < 18 ? 'greeting_afternoon' : 'greeting_evening';
    const greeting = t(greetKey, msg.chat.id);
    await bot.sendMessage(msg.chat.id, `${greeting}, ${name} 👋 ${t('pulling_markets', msg.chat.id)}`);
    bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: '/signals', message_id: msg.message_id });
    return;
  }
  // "thanks" / "thx" → warm acknowledge (multilingual)
  if (/^(thanks|thx|thank you|cheers|ty|appreciate|gracias|danke|merci|grazie|obrigad|bedankt|hvala|dziękuję|dziekuje|teşekkür|mulțumesc|děkuji|tack|tak)\b/i.test(lower)) {
    await bot.sendMessage(msg.chat.id, t('glad_to_help', msg.chat.id), {
      reply_markup: { inline_keyboard: [
        [{ text: `📊 ${t('btn_more_signals', msg.chat.id)}`, callback_data: 'cmd:signals' }, { text: `🔒 ${t('btn_check_arbs', msg.chat.id)}`, callback_data: 'cmd:arb' }],
      ]},
    });
    return;
  }

  // --- AI INTENT CLASSIFICATION (multilingual fallback) ---
  // If hardcoded patterns didn't match, ask AI to understand the message in any language
  if (ANTHROPIC_API_KEY) {
    const aiIntent = await classifyIntentAI(msg.text, getUserLang(msg.chat.id));
    if (aiIntent) {
      // Handle greeting/thanks from AI
      if (aiIntent === 'greeting') {
        const name = escapeMd(msg.from.first_name || 'there');
        const hour = new Date().getHours();
        const greetKey = hour < 12 ? 'greeting_morning' : hour < 18 ? 'greeting_afternoon' : 'greeting_evening';
        await bot.sendMessage(msg.chat.id, `${t(greetKey, msg.chat.id)}, ${name} 👋 ${t('pulling_markets', msg.chat.id)}`);
        bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: '/signals', message_id: msg.message_id });
        return;
      }
      if (aiIntent === 'thanks') {
        await bot.sendMessage(msg.chat.id, t('glad_to_help', msg.chat.id), {
          reply_markup: { inline_keyboard: [
            [{ text: `📊 ${t('btn_more_signals', msg.chat.id)}`, callback_data: 'cmd:signals' }, { text: `🔒 ${t('btn_check_arbs', msg.chat.id)}`, callback_data: 'cmd:arb' }],
          ]},
        });
        return;
      }
      if (aiIntent === 'language') {
        bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: '/language', message_id: msg.message_id });
        return;
      }
      // Handle education intents
      if (aiIntent.startsWith('explain_')) {
        const topic = aiIntent.replace('explain_', '');
        const explainerKeys = {
          arb: 'what.*arbitrage',
          value: 'what.*value.*bet',
          sharp: 'what.*sharp',
          kelly: 'what.*kelly',
          general: 'how.*work',
        };
        // Find the matching explainer and respond
        const pattern = explainerKeys[topic];
        if (pattern) {
          for (const [p, lines] of Object.entries(BETTING_EXPLAINERS)) {
            if (p.includes(topic) || p.includes('how.*work') && topic === 'general') {
              await bot.sendMessage(msg.chat.id, lines.join('\n'), {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [
                  [{ text: `📊 ${t('btn_signals', msg.chat.id)}`, callback_data: 'cmd:signals' }, { text: `🔒 ${t('btn_check_arbs', msg.chat.id)}`, callback_data: 'cmd:arb' }],
                ]},
              });
              return;
            }
          }
        }
      }
      // Handle team mentions from AI
      if (aiIntent.startsWith('team_mention:')) {
        const teamName = aiIntent.split(':')[1]?.trim();
        if (teamName) {
          await bot.sendMessage(msg.chat.id, `${t('let_me_check', msg.chat.id).replace('...', '')} ${teamName}...`);
          bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: '/odds soccer today', message_id: msg.message_id });
          return;
        }
      }
      // Direct command mapping
      if (AI_INTENT_COMMANDS[aiIntent]) {
        const cmd = AI_INTENT_COMMANDS[aiIntent];
        setUserContext(msg.chat.id, { lastCommand: cmd });
        bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: cmd, message_id: msg.message_id });
        return;
      }
      // "unknown" intent — fall through to hardcoded layer below
    }
  }

  // --- CONVERSATIONAL INTELLIGENCE LAYER ---
  // Hardcoded fallback for when AI is not available

  // 1. Team name detection — if they mention a team, show odds for it
  const KNOWN_TEAMS = [
    // EPL
    'arsenal', 'chelsea', 'liverpool', 'man city', 'manchester city', 'man united', 'manchester united',
    'tottenham', 'spurs', 'newcastle', 'aston villa', 'west ham', 'brighton', 'wolves', 'everton',
    'crystal palace', 'fulham', 'bournemouth', 'brentford', 'nottingham', 'nottingham forest',
    // La Liga
    'barcelona', 'barca', 'real madrid', 'atletico', 'atletico madrid', 'sevilla', 'villarreal', 'real sociedad', 'betis',
    // Bundesliga
    'bayern', 'bayern munich', 'dortmund', 'borussia dortmund', 'leverkusen', 'bayer leverkusen', 'leipzig', 'rb leipzig',
    // Serie A
    'juventus', 'juve', 'inter', 'inter milan', 'ac milan', 'milan', 'napoli', 'roma', 'lazio', 'atalanta',
    // Ligue 1
    'psg', 'paris', 'marseille', 'lyon', 'monaco', 'lille',
    // NBA
    'lakers', 'celtics', 'warriors', 'nets', 'knicks', 'bucks', 'sixers', '76ers', 'heat', 'nuggets',
    'suns', 'mavericks', 'mavs', 'clippers', 'thunder', 'grizzlies', 'timberwolves', 'cavaliers', 'cavs',
    // NFL
    'chiefs', 'eagles', 'cowboys', 'bills', 'niners', '49ers', 'ravens', 'bengals', 'dolphins', 'lions', 'packers',
    // NHL
    'rangers', 'bruins', 'oilers', 'panthers', 'avalanche', 'maple leafs', 'leafs', 'canadiens', 'penguins',
  ];
  const mentionedTeam = KNOWN_TEAMS.find(t => lower.includes(t));
  if (mentionedTeam) {
    // Determine sport from team
    const soccerTeams = ['arsenal','chelsea','liverpool','man city','manchester city','man united','manchester united','tottenham','spurs','newcastle','aston villa','west ham','brighton','wolves','everton','crystal palace','fulham','bournemouth','brentford','nottingham','nottingham forest','barcelona','barca','real madrid','atletico','atletico madrid','sevilla','villarreal','real sociedad','betis','bayern','bayern munich','dortmund','borussia dortmund','leverkusen','bayer leverkusen','leipzig','rb leipzig','juventus','juve','inter','inter milan','ac milan','milan','napoli','roma','lazio','atalanta','psg','paris','marseille','lyon','monaco','lille'];
    const nbaTeams = ['lakers','celtics','warriors','nets','knicks','bucks','sixers','76ers','heat','nuggets','suns','mavericks','mavs','clippers','thunder','grizzlies','timberwolves','cavaliers','cavs'];
    const nflTeams = ['chiefs','eagles','cowboys','bills','niners','49ers','ravens','bengals','dolphins','lions','packers'];
    const nhlTeams = ['rangers','bruins','oilers','panthers','avalanche','maple leafs','leafs','canadiens','penguins'];

    let sportCmd = '/odds soccer today';
    if (nbaTeams.includes(mentionedTeam)) sportCmd = '/odds nba';
    else if (nflTeams.includes(mentionedTeam)) sportCmd = '/odds nfl';
    else if (nhlTeams.includes(mentionedTeam)) sportCmd = '/odds nhl';

    // Check if they're asking a question about the team
    const isQuestion = /\b(will|can|should|think|gonna|going to|win|lose|beat|chance|worth|bet on|predict|ganar|gewinnt|gagner|vincere|vencer)\b/i.test(lower);
    if (isQuestion) {
      const teamCap = mentionedTeam.charAt(0).toUpperCase() + mentionedTeam.slice(1);
      await bot.sendMessage(msg.chat.id, `${t('let_me_check', msg.chat.id).replace('...', '')} ${teamCap}...`);
    }
    setUserContext(msg.chat.id, { lastCommand: sportCmd });
    bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: sportCmd, message_id: msg.message_id });
    return;
  }

  // 2. Betting education — explain concepts in plain language
  const BETTING_EXPLAINERS = {
    'what.*arbitrage|what.*arb|explain.*arb|how.*arb.*work': [
      '*Arbitrage* is when different bookmakers disagree on odds enough that you can bet all outcomes and guarantee a profit no matter what happens.\n',
      'Example: Book A has Team X at 2.10, Book B has Team Y at 2.10. You bet both — guaranteed ~5% profit.\n',
      'I scan for these automatically. Say "arbs" and I\'ll show you if there are any right now.',
    ],
    'what.*value.*bet|what.*\\+ev|explain.*value|how.*value.*work': [
      '*Value bets* are when a bookmaker\'s odds are higher than they should be — meaning the payout is better than the true probability.\n',
      'I compare odds to sharp bookmakers (Pinnacle, Betfair) who are rarely wrong. When a soft bookmaker offers better odds, that\'s value.\n',
      'Say "value bets" and I\'ll show you what I\'ve found.',
    ],
    'what.*sharp|what.*smart.*money|what.*steam|explain.*sharp': [
      '*Sharp money* = professional bettors. They move the odds at bookmakers like Pinnacle and Betfair.\n',
      'When Pinnacle drops odds on a team suddenly (a "steam move"), it usually means pros are betting big on it.\n',
      'Following sharp money is one of the most reliable strategies. Say "sharp money" to see what\'s moving.',
    ],
    'what.*kelly|how.*much.*bet|how.*size|explain.*kelly|what.*stake': [
      '*Kelly Criterion* tells you exactly how much to bet based on your edge and odds.\n',
      'Bet too much → you go broke on a bad streak. Bet too little → you leave money on the table.\n',
      'Most pros use "half Kelly" (half the suggested amount) for safety. Say "kelly 55 2.0" and I\'ll calculate it for you.',
    ],
    'what.*vig|what.*juice|what.*margin|what.*overround': [
      '*Vig* (or juice/margin) is the bookmaker\'s cut. They set odds so they profit no matter what happens.\n',
      'Example: Fair odds for a coin flip are 2.00/2.00. But bookmakers offer 1.90/1.90 — that 5% difference is the vig.\n',
      'I strip the vig to find the *true* odds, which helps spot value bets.',
    ],
    'what.*closing.*line|what.*clv|explain.*clv': [
      '*Closing Line Value (CLV)* = whether you beat the final odds before kickoff.\n',
      'If you bet at 2.10 and the line closes at 1.95, you got better odds than the market — that\'s positive CLV.\n',
      'Consistently beating closing lines is the #1 predictor of long-term profit.',
    ],
    'how.*work|how.*use|what.*do|what.*this|how.*start|where.*begin|getting.*started': [
      'I scan 40+ bookmakers in real-time and find opportunities for you.\n',
      'Just tell me what you\'re interested in:\n',
      '  "What\'s good today?" — I\'ll show you the best bets',
      '  "Arsenal" — I\'ll show you their odds',
      '  "Any arbs?" — I\'ll check for guaranteed profits',
      '  "Sharp money" — I\'ll show where pros are betting\n',
      'I can also track your bets, calculate stake sizes, and send you alerts when I find something good.',
    ],
    'is.*safe|is.*legal|can.*trust|is.*legit|risky|risk': [
      'Betting always carries risk — no system can guarantee profits long-term (except arbitrage, which has its own challenges).\n',
      'What I do is give you a *mathematical edge* by finding mispriced odds and tracking sharp money.\n',
      'The key principles:\n',
      '  Never bet more than you can afford to lose',
      '  Use Kelly Criterion for sizing (say "kelly")',
      '  Track everything (I do this automatically)',
      '  Value > gut feeling',
    ],
    'which.*book|which.*bet|best.*book|recommend.*book|where.*bet': [
      'I compare odds across all major bookmakers and show you which one has the best price for each bet.\n',
      'Sharp books (Pinnacle, Betfair) have the most accurate odds but lower limits. Soft books (Bet365, Unibet, 888sport) often have mispriced odds — that\'s where the value is.\n',
      'Say "compare Arsenal" and I\'ll show you odds side by side across all bookmakers.',
    ],
  };

  for (const [pattern, lines] of Object.entries(BETTING_EXPLAINERS)) {
    if (new RegExp(pattern, 'i').test(lower)) {
      await bot.sendMessage(msg.chat.id, lines.join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '📊 Show me signals', callback_data: 'cmd:signals' }, { text: '🔒 Check arbs', callback_data: 'cmd:arb' }],
        ]},
      });
      return;
    }
  }

  // 3. Opinion/prediction questions — route to relevant data
  if (/\b(should\s*i|worth|good\s*idea|recommend|what.*think|predict|gonna|will.*win|debería|soll\s*ich|devrais|dovrei|devo|skal\s*jeg|borde\s*jag)\b/i.test(lower)) {
    await bot.sendMessage(msg.chat.id, t('show_data', msg.chat.id));
    bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: '/signals', message_id: msg.message_id });
    return;
  }

  // 4. Time-related → show relevant market data
  if (/\btoday\b|\btonight\b|\bthis\s*(week|evening|afternoon|weekend)|tomorrow|later/i.test(lower)) {
    bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: '/signals', message_id: msg.message_id });
    return;
  }

  // 5. Money/profit related
  if (/\b(money|profit|earn|make.*money|income|side.*hustle|how.*much.*make|roi|return)\b/i.test(lower)) {
    const hasHistory = ctx.lastCommand;
    if (hasHistory) {
      bot.emit('message', { chat: { id: msg.chat.id }, from: msg.from, text: '/bankroll', message_id: msg.message_id });
    } else {
      await bot.sendMessage(msg.chat.id, [
        'I find profitable opportunities by scanning bookmakers for pricing mistakes.\n',
        'The main ways to profit:',
        '  🔒 *Arbitrage* — guaranteed profit (1-5% per bet)',
        '  💎 *Value bets* — positive expected value long-term',
        '  🚨 *Sharp following* — bet where the pros bet\n',
        'Want me to show you what\'s available right now?',
      ].join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: 'Yes, show me', callback_data: 'cmd:signals' }],
          [{ text: 'Tell me more about plans', callback_data: 'cmd:subscribe' }],
        ]},
      });
    }
    return;
  }

  // 6. Catch-all: gentle redirect
  const looksLikeCode = /\b(code|function|file|bug|deploy|commit|git|npm|error|crash|refactor|endpoint|database|script)\b/i.test(lower);
  if (!looksLikeCode) {
    await bot.sendMessage(msg.chat.id, t('not_sure', msg.chat.id), {
      reply_markup: { inline_keyboard: [
        [{ text: `📊 ${t('btn_signals', msg.chat.id)}`, callback_data: 'cmd:signals' }],
        [{ text: '⚽ Soccer', callback_data: 'cmd:odds soccer today' }, { text: '🏀 NBA', callback_data: 'cmd:odds nba' }],
      ]},
    });
    return;
  }

  // If it looks like a code question, fall through to Claude Code bridge
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
      await replyError(msg.chat.id, err);
    }
  }
});

// --- Bankroll Tracker ---
function loadBankroll() { try { return JSON.parse(fs.readFileSync(BANKROLL_FILE, 'utf8')); } catch { return {}; } }
function saveBankroll(data) { atomicWriteJson(BANKROLL_FILE, data); }

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

// --- Stake Units ---
// 1 unit = unitSize fraction of starting bankroll (default 1%).
// Units let users reason about P/L in stake-size-independent terms — universal
// currency among sharp bettors. Only meaningful when startBalance is set.
const DEFAULT_UNIT_SIZE = 0.01; // 1% of bankroll
function getUnitSize(br) {
  const raw = Number(br?.unitSize);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_UNIT_SIZE;
  return raw;
}
function getUnitValue(br) {
  const start = Number.isFinite(br?.startBalance) ? br.startBalance : 0;
  if (start <= 0) return 0;
  return start * getUnitSize(br);
}
function eurToUnits(euro, unitValue) {
  if (!Number.isFinite(unitValue) || unitValue <= 0) return null;
  return euro / unitValue;
}
function formatUnits(euro, unitValue, { signed = false } = {}) {
  const u = eurToUnits(euro, unitValue);
  if (u == null) return '';
  const sign = signed && u > 0 ? '+' : '';
  return ` (${sign}${u.toFixed(2)}u)`;
}

// /units — show or set stake unit size (as % of starting bankroll)
bot.onText(/\/units(?:\s+(\S+))?/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const br = getUserBankroll(msg.chat.id);
  const arg = (match?.[1] || '').trim();

  if (arg) {
    // Accept "1" → 1%, "0.5" → 0.5%, "1%" → 1%, "2%" → 2%
    const cleaned = arg.replace('%', '');
    const pct = parseFloat(cleaned);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      bot.sendMessage(msg.chat.id, 'Invalid unit size. Use a percent between 0 and 100, e.g. `/units 1` for 1% or `/units 0.5` for 0.5%.', { parse_mode: 'Markdown' });
      return;
    }
    br.unitSize = pct / 100;
    saveUserBankroll(msg.chat.id, br);
    const unitValue = getUnitValue(br);
    const lines = [
      `*Unit size set to ${pct}%*`,
      '',
      unitValue > 0
        ? `1 unit = *€${unitValue.toFixed(2)}* (${pct}% of €${br.startBalance.toFixed(2)} bankroll)`
        : '_Set your bankroll with /setbank <amount> to see € values per unit._',
    ];
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // Show current config
  const size = getUnitSize(br);
  const unitValue = getUnitValue(br);
  const lines = [
    '*Stake Units*',
    '',
    '1 unit = a fixed % of your starting bankroll — the sharp way to track P/L independent of stake size.',
    '',
    `Current unit size: *${(size * 100).toFixed(2)}%*`,
  ];
  if (unitValue > 0) {
    lines.push(`1 unit = *€${unitValue.toFixed(2)}* (of €${br.startBalance.toFixed(2)} bankroll)`);
  } else {
    lines.push('_Set your bankroll with `/setbank <amount>` to see € values._');
  }
  lines.push('', '*Change it:*', '`/units 1` — 1% per unit (default)', '`/units 0.5` — 0.5% per unit', '`/units 2` — 2% per unit');
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// /bankroll — show bankroll stats
bot.onText(/\/bankroll$/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const br = getUserBankroll(msg.chat.id);
  if (!br.bets.length) {
    bot.sendMessage(msg.chat.id, '*Bankroll Tracker*\n\nNo bets recorded yet.\n\n`/bet <stake> <odds> <team/match>` — record a bet\n`/betwin <id>` — mark bet as won\n`/betloss <id>` — mark bet as lost\n`/setbank <amount>` — set starting bankroll', { parse_mode: 'Markdown' });
    return;
  }
  const won = br.bets.filter(b => b.result === 'win');
  const lost = br.bets.filter(b => b.result === 'loss');
  const pending = br.bets.filter(b => !b.result);
  const totalStaked = br.bets.reduce((s, b) => s + b.stake, 0);
  const settledStake = won.reduce((s, b) => s + b.stake, 0) + lost.reduce((s, b) => s + b.stake, 0);
  const wonReturn = won.reduce((s, b) => s + (b.stake * b.odds), 0);
  const netProfit = wonReturn - settledStake;
  const roi = settledStake > 0 ? (netProfit / settledStake * 100) : 0;
  const winRate = (won.length + lost.length) > 0 ? (won.length / (won.length + lost.length) * 100) : 0;
  const avgOdds = br.bets.length > 0 ? br.bets.reduce((s, b) => s + b.odds, 0) / br.bets.length : 0;

  const lines = ['*Bankroll Tracker*\n'];
  const startBal = Number.isFinite(br.startBalance) ? br.startBalance : 0;
  const unitValue = getUnitValue(br);
  if (startBal > 0) lines.push(`Starting: €${startBal.toFixed(2)}`);
  if (startBal > 0) lines.push(`Current: *€${(startBal + netProfit).toFixed(2)}*`);
  if (unitValue > 0) lines.push(`Unit size: €${unitValue.toFixed(2)} (${(getUnitSize(br) * 100).toFixed(2)}%)`);
  lines.push(`Net P/L: *${netProfit >= 0 ? '+' : ''}€${netProfit.toFixed(2)}*${formatUnits(netProfit, unitValue, { signed: true })}`);
  lines.push(`ROI: *${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%*`);
  lines.push(`\nWin rate: ${winRate.toFixed(0)}% (${won.length}W / ${lost.length}L)`);
  lines.push(`Total staked: €${totalStaked.toFixed(2)}${formatUnits(totalStaked, unitValue)}`);
  lines.push(`Avg odds: ${avgOdds.toFixed(2)}`);
  if (pending.length) {
    lines.push(`\n*Pending (${pending.length}):*`);
    for (const b of pending.slice(-5)) {
      lines.push(`  #${b.id} — €${b.stake} @ ${b.odds.toFixed(2)} — ${escapeMd(b.desc)}`);
    }
  }
  // Last 5 settled
  const settled = br.bets.filter(b => b.result).slice(-5);
  if (settled.length) {
    lines.push(`\n*Recent:*`);
    for (const b of settled.reverse()) {
      const icon = b.result === 'win' ? '✅' : '❌';
      const pnl = b.result === 'win' ? `+€${(b.stake * b.odds - b.stake).toFixed(2)}` : `-€${b.stake.toFixed(2)}`;
      lines.push(`  ${icon} #${b.id} — ${escapeMd(b.desc)} (${pnl})`);
    }
  }
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// /bookmakers — pick preferred betting sites
bot.onText(/\/bookmakers?/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = msg.chat.id;
  const lang = getUserLang(chatId);
  const localBooks = BOOKMAKERS[lang] || [];
  const intlBooks = BOOKMAKERS._default;
  const current = getBookmakersForUser(chatId);

  const lines = ['*🏪 Your Bookmakers*', ''];
  if (current.length) {
    lines.push('Currently selected:');
    for (const b of current) lines.push(`  ${b.flag} ${b.name}`);
    lines.push('');
  }

  lines.push('_Tap below to pick your preferred sites. Signals will include direct links to them._');

  // Build selection buttons: show ALL countries so users can pick any bookmaker
  const buttons = [];
  // Local country first (if detected)
  if (localBooks.length) {
    buttons.push(localBooks.map(b => ({
      text: `${b.flag} ${b.name}`,
      callback_data: `bk:toggle:${b.id}`,
    })));
  }
  // All other countries
  for (const [code, books] of Object.entries(BOOKMAKERS)) {
    if (code === '_default' || code === lang) continue;
    // Show max 3 per row to fit Telegram button limits
    for (let i = 0; i < books.length; i += 3) {
      buttons.push(books.slice(i, i + 3).map(b => ({
        text: `${b.flag} ${b.name}`,
        callback_data: `bk:toggle:${b.id}`,
      })));
    }
  }
  // International
  buttons.push(intlBooks.map(b => ({
    text: `${b.flag} ${b.name}`,
    callback_data: `bk:toggle:${b.id}`,
  })));
  buttons.push([{ text: '🔄 Reset to default', callback_data: 'bk:reset' }]);

  bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  });
});

// Handle bookmaker selection toggles
bot.on('callback_query', async (query) => {
  if (!query.data?.startsWith('bk:')) return;
  const chatId = query.message.chat.id;
  const parts = query.data.split(':');

  if (parts[1] === 'reset') {
    setUserBookmakers(chatId, []);
    bot.answerCallbackQuery(query.id, { text: 'Reset to country default' });
    bot.editMessageText('✅ Bookmakers reset to default for your country.', {
      chat_id: chatId, message_id: query.message.message_id,
    });
    return;
  }

  if (parts[1] === 'toggle') {
    const bookId = parts[2];
    let prefs = getUserBookmakers(chatId) || [];
    if (prefs.includes(bookId)) {
      prefs = prefs.filter(id => id !== bookId);
    } else {
      prefs.push(bookId);
    }
    setUserBookmakers(chatId, prefs);

    const allBooks = Object.values(BOOKMAKERS).flat();
    const selected = prefs.map(id => allBooks.find(b => b.id === id)).filter(Boolean);
    const names = selected.map(b => `${b.flag} ${b.name}`).join(', ') || 'Country default';
    bot.answerCallbackQuery(query.id, { text: selected.length ? `Selected: ${selected.length}` : 'Removed' });

    // Update message text
    bot.editMessageText(`*🏪 Your Bookmakers*\n\nSelected: ${names}\n\n_Signals will include links to these sites._`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
    }).catch(() => {});
    return;
  }
});

// /betslip — open the Telegram Mini App bet slip builder
bot.onText(/\/betslip/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = msg.chat.id;
  const books = getBookmakersForUser(chatId);
  const booksParam = encodeURIComponent(JSON.stringify(books.slice(0, 4).map(b => ({ flag: b.flag, name: b.name, url: b.affiliate || b.url }))));

  // Fetch recent signals for the bet slip
  let signals = [];
  try {
    const track = JSON.parse(fs.readFileSync(stateFile('signal_track.json'), 'utf8'));
    signals = (track.active || []).slice(-10).map(s => ({
      match: s.match || s.event || '',
      outcome: s.outcome || '',
      odds: s.odds || 0,
      bookmaker: s.bookmaker || '',
      edge: s.edge || 0,
    }));
  } catch {}
  const signalsParam = encodeURIComponent(JSON.stringify(signals));

  // The Mini App URL — when deployed, replace localhost with your real domain
  const baseUrl = process.env.MINI_APP_URL || `http://localhost:${STRIPE_WEBHOOK_PORT}`;
  const url = `${baseUrl}/betslip?signals=${signalsParam}&books=${booksParam}`;

  await bot.sendMessage(chatId, '📋 *Bet Slip Builder*\n\nTap below to build your parlay and place it on your bookmaker.', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Open Bet Slip', web_app: { url } }],
      ],
    },
  });
});

// Handle data returned from Mini App bet slip
bot.on('web_app_data', async (msg) => {
  try {
    const data = JSON.parse(msg.web_app_data.data);
    const { picks, stake } = data;
    if (!picks || !picks.length) return;

    const combinedOdds = picks.reduce((acc, p) => acc * p.odds, 1);
    const potential = (stake * combinedOdds).toFixed(2);

    const lines = [
      '📋 *Your Bet Slip*',
      '',
      ...picks.map((p, i) => `  ${i + 1}. ${p.match} — ${p.outcome} @ ${p.odds.toFixed(2)}`),
      '',
      `Stake: €${stake} | Odds: ${combinedOdds.toFixed(2)} | Potential: *€${potential}*`,
    ];

    const books = getBookmakersForUser(msg.chat.id);
    await bot.sendMessage(msg.chat.id, lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          books.slice(0, 3).map(b => ({ text: `${b.flag} Bet on ${b.name}`, url: b.affiliate || b.url })),
          [{ text: '💰 Record in bankroll', callback_data: `fb:bet:50:${combinedOdds.toFixed(2)}:Parlay ${picks.length} legs` }],
        ],
      },
    });
  } catch (err) {
    log.warn(`[betslip] Error processing web_app_data: ${err.message}`);
  }
});

// /stats — personal performance dashboard with streaks, best/worst, trends
bot.onText(/\/stats/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const br = getUserBankroll(msg.chat.id);
  const settled = br.bets.filter(b => b.result);
  if (!settled.length) {
    bot.sendMessage(msg.chat.id, '*📈 Your Stats*\n\nNo settled bets yet. Record bets with `/bet` and settle with `/betwin` or `/betloss`.', { parse_mode: 'Markdown' });
    return;
  }

  const won = settled.filter(b => b.result === 'win');
  const lost = settled.filter(b => b.result === 'loss');
  const settledStake = settled.reduce((s, b) => s + b.stake, 0);
  const wonReturn = won.reduce((s, b) => s + (b.stake * b.odds), 0);
  const netProfit = wonReturn - settledStake;
  const roi = settledStake > 0 ? (netProfit / settledStake * 100) : 0;
  const winRate = (won.length / settled.length * 100);
  const avgOdds = settled.reduce((s, b) => s + b.odds, 0) / settled.length;
  const avgStake = settledStake / settled.length;

  // Current streak
  let streak = 0;
  let streakType = '';
  for (let i = settled.length - 1; i >= 0; i--) {
    if (i === settled.length - 1) {
      streakType = settled[i].result;
      streak = 1;
    } else if (settled[i].result === streakType) {
      streak++;
    } else break;
  }
  const streakIcon = streakType === 'win' ? '🔥' : '🥶';
  const streakLabel = streakType === 'win' ? `${streakIcon} ${streak}W streak` : `${streakIcon} ${streak}L streak`;

  // Best and worst bet
  let bestPnl = -Infinity, worstPnl = Infinity, bestBet = null, worstBet = null;
  for (const b of settled) {
    const pnl = b.result === 'win' ? (b.stake * b.odds - b.stake) : -b.stake;
    if (pnl > bestPnl) { bestPnl = pnl; bestBet = b; }
    if (pnl < worstPnl) { worstPnl = pnl; worstBet = b; }
  }

  // Last 7 days performance
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentBets = settled.filter(b => (b.settledAt || b.createdAt || '') >= weekAgo);
  const recentWon = recentBets.filter(b => b.result === 'win');
  const recentStake = recentBets.reduce((s, b) => s + b.stake, 0);
  const recentReturn = recentWon.reduce((s, b) => s + (b.stake * b.odds), 0);
  const recentPnl = recentReturn - recentStake;
  const recentRoi = recentStake > 0 ? (recentPnl / recentStake * 100) : 0;

  // Longest win streak ever
  let maxWin = 0, curWin = 0;
  for (const b of settled) {
    if (b.result === 'win') { curWin++; if (curWin > maxWin) maxWin = curWin; }
    else curWin = 0;
  }

  const lines = [
    '*📈 Your Stats*',
    '',
    `*Overall* (${settled.length} bets)`,
    `  Win rate: ${winRate.toFixed(0)}% (${won.length}W / ${lost.length}L)`,
    `  ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,
    `  Net P/L: ${netProfit >= 0 ? '+' : ''}€${netProfit.toFixed(2)}`,
    `  Avg stake: €${avgStake.toFixed(2)} | Avg odds: ${avgOdds.toFixed(2)}`,
    `  ${streakLabel} | Best streak: ${maxWin}W`,
    '',
    '*Last 7 days*',
    recentBets.length > 0
      ? `  ${recentBets.length} bets | ${recentWon.length}W / ${recentBets.length - recentWon.length}L | ${recentPnl >= 0 ? '+' : ''}€${recentPnl.toFixed(2)} (${recentRoi >= 0 ? '+' : ''}${recentRoi.toFixed(1)}%)`
      : '  No bets this week',
  ];

  if (bestBet) {
    lines.push('', '*Best bet*');
    lines.push(`  ✅ #${bestBet.id} — ${escapeMd(bestBet.desc)} (+€${bestPnl.toFixed(2)})`);
  }
  if (worstBet) {
    lines.push('*Worst bet*');
    lines.push(`  ❌ #${worstBet.id} — ${escapeMd(worstBet.desc)} (−€${Math.abs(worstPnl).toFixed(2)})`);
  }

  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// /setbank <amount>
bot.onText(/\/setbank\s+(\d+(?:\.\d+)?)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const br = getUserBankroll(msg.chat.id);
  br.startBalance = parseFloat(match[1]);
  saveUserBankroll(msg.chat.id, br);
  bot.sendMessage(msg.chat.id, `Starting bankroll set to *€${br.startBalance.toFixed(2)}*`, { parse_mode: 'Markdown' });
});

// /bet <stake> <odds> <description>
bot.onText(/\/bet\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const stake = parseFloat(match[1]);
  const odds = parseFloat(match[2]);
  const desc = match[3].trim();
  if (!Number.isFinite(stake) || stake <= 0) {
    bot.sendMessage(msg.chat.id, 'Invalid stake. Must be a positive number.');
    return;
  }
  if (!Number.isFinite(odds) || odds <= 1.0) {
    bot.sendMessage(msg.chat.id, 'Invalid odds. Decimal odds must be greater than 1.0 (e.g. 1.85).');
    return;
  }
  if (stake > 1_000_000) {
    bot.sendMessage(msg.chat.id, 'Stake too large.');
    return;
  }
  if (!desc || desc.length > 200) {
    bot.sendMessage(msg.chat.id, 'Description is required and must be under 200 chars.');
    return;
  }
  const br = getUserBankroll(msg.chat.id);
  // Assign ID based on max existing + 1 (safe even if bets are ever removed)
  const nextId = br.bets.reduce((m, b) => Math.max(m, b.id || 0), 0) + 1;
  const bet = {
    id: nextId,
    stake, odds, desc,
    date: new Date().toISOString(),
    result: null,
  };
  br.bets.push(bet);
  saveUserBankroll(msg.chat.id, br);
  const potWin = (bet.stake * bet.odds).toFixed(2);
  bot.sendMessage(msg.chat.id, `Bet #${bet.id} recorded\n€${bet.stake} @ ${bet.odds.toFixed(2)} on *${escapeMd(bet.desc)}*\nPotential win: *€${potWin}*`, { parse_mode: 'Markdown' });
});

// /betwin <id>
bot.onText(/\/betwin\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const br = getUserBankroll(msg.chat.id);
  const bet = br.bets.find(b => b.id === parseInt(match[1], 10));
  if (!bet) { bot.sendMessage(msg.chat.id, 'Bet not found.'); return; }
  if (bet.result) {
    bot.sendMessage(msg.chat.id, `Bet #${bet.id} already settled as *${bet.result}*. Use /betreset ${bet.id} first if this was a mistake.`, { parse_mode: 'Markdown' });
    return;
  }
  bet.result = 'win';
  bet.settledAt = new Date().toISOString();
  saveUserBankroll(msg.chat.id, br);
  const profit = (bet.stake * bet.odds - bet.stake).toFixed(2);
  bot.sendMessage(msg.chat.id, `✅ Bet #${bet.id} won! Profit: *+€${profit}*`, { parse_mode: 'Markdown' });
  checkAchievements(msg.chat.id, br);
});

// /betloss <id>
bot.onText(/\/betloss\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const br = getUserBankroll(msg.chat.id);
  const bet = br.bets.find(b => b.id === parseInt(match[1], 10));
  if (!bet) { bot.sendMessage(msg.chat.id, 'Bet not found.'); return; }
  if (bet.result) {
    bot.sendMessage(msg.chat.id, `Bet #${bet.id} already settled as *${bet.result}*. Use /betreset ${bet.id} first if this was a mistake.`, { parse_mode: 'Markdown' });
    return;
  }
  bet.result = 'loss';
  bet.settledAt = new Date().toISOString();
  saveUserBankroll(msg.chat.id, br);
  bot.sendMessage(msg.chat.id, `❌ Bet #${bet.id} lost. -€${bet.stake.toFixed(2)}`, { parse_mode: 'Markdown' });
  checkAchievements(msg.chat.id, br);
});

// /betreset <id> — undo a settlement (for mistakes)
bot.onText(/\/betreset\s+(\d+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const br = getUserBankroll(msg.chat.id);
  const bet = br.bets.find(b => b.id === parseInt(match[1], 10));
  if (!bet) { bot.sendMessage(msg.chat.id, 'Bet not found.'); return; }
  if (!bet.result) { bot.sendMessage(msg.chat.id, `Bet #${bet.id} is not settled.`); return; }
  const prev = bet.result;
  bet.result = null;
  delete bet.settledAt;
  delete bet.autoSettled;
  saveUserBankroll(msg.chat.id, br);
  bot.sendMessage(msg.chat.id, `Bet #${bet.id} reset from *${prev}* to pending.`, { parse_mode: 'Markdown' });
});

// --- Kelly Criterion ---
// /kelly <your_prob> <odds> [bankroll]
bot.onText(/\/kelly\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*(\d+(?:\.\d+)?)?/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const rawProb = parseFloat(match[1]);
  const odds = parseFloat(match[2]);
  const bankrollAmt = match[3] ? parseFloat(match[3]) : getUserBankroll(msg.chat.id).startBalance || 100;

  if (!Number.isFinite(rawProb) || !Number.isFinite(odds) || !Number.isFinite(bankrollAmt)) {
    bot.sendMessage(msg.chat.id, 'Invalid numbers. Usage: `/kelly <probability> <odds> [bankroll]`\nExample: `/kelly 55 2.0` (55% probability at 2.0 decimal odds)', { parse_mode: 'Markdown' });
    return;
  }
  if (odds <= 1.0) {
    bot.sendMessage(msg.chat.id, 'Invalid odds. Decimal odds must be greater than 1.0 (e.g. 1.85, 2.50).');
    return;
  }
  const prob = rawProb > 1 ? rawProb / 100 : rawProb;
  if (prob <= 0 || prob >= 1) {
    bot.sendMessage(msg.chat.id, 'Invalid probability. Use 0–1 (e.g. 0.55) or 0–100 (e.g. 55).');
    return;
  }
  if (bankrollAmt <= 0) {
    bot.sendMessage(msg.chat.id, 'Bankroll must be positive.');
    return;
  }

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
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */
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
      replyError(msg.chat.id, err);
    }
  });
});

// --- Live Scores + Odds ---
// /live — show in-play and about-to-start matches
bot.onText(/\/live/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */

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
      replyError(msg.chat.id, err);
    }
  });
});

// --- Alerts System ---
function loadAlerts() { try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch { return {}; } }
function saveAlerts(data) { atomicWriteJson(ALERTS_FILE, data); }

// /alert <team> — get notified when odds change for this team
bot.onText(/\/alert\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
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
  if (!gateRate(msg)) return;
  const alerts = loadAlerts();
  const userAlerts = alerts[msg.chat.id] || [];
  const idx = userAlerts.findIndex(a => a.id === parseInt(match[1], 10));
  if (idx === -1) { bot.sendMessage(msg.chat.id, 'Alert not found.'); return; }
  userAlerts.splice(idx, 1);
  alerts[msg.chat.id] = userAlerts;
  saveAlerts(alerts);
  bot.sendMessage(msg.chat.id, `Alert #${match[1]} removed.`);
});

// Alert checker — runs every 5 minutes
async function checkAlerts() {
  /* demo-mode: proceed — fetch functions handle fallback */
  const alerts = loadAlerts();
  let events = null; // lazy fetch

  // Accumulate lastOdds updates keyed by (chatId, alertId or query) — applied after the await loop
  // so concurrent /alert add|del calls don't get clobbered.
  const updates = []; // { chatId, query, lastOdds }

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
            bot.sendMessage(parseInt(chatId, 10),
              `*ODDS ALERT: ${found.home_team} vs ${found.away_team}*\n${time}\n\n${changes.join('\n')}`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          }
        }

        updates.push({ chatId, query: alert.query, lastOdds: current });
      } catch {}
    }
  }

  if (!updates.length) return;

  // Reload after awaits and apply patches to the fresh alerts map
  const fresh = loadAlerts();
  for (const u of updates) {
    const list = fresh[u.chatId] || [];
    const match = list.find(a => a.query === u.query);
    if (match) match.lastOdds = u.lastOdds;
  }
  saveAlerts(fresh);
}

setInterval(checkAlerts, 5 * 60 * 1000); // every 5 minutes

// --- Parlay History Tracking ---
function loadHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return { parlays: [] }; } }
function saveHistory(data) { atomicWriteJson(HISTORY_FILE, data); }

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
  if (!gateRate(msg)) return;
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
  if (!gateRate(msg)) return;
  const result = match[1];
  const n = parseInt(match[2], 10);
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
  /* demo-mode: proceed — fetch functions handle fallback */
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
      bot.sendMessage(parseInt(chatId, 10), lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (err) {
    log.info('[digest] Error:', err.message);
  }
}

// Check for digest time
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() === DIGEST_HOUR && now.getMinutes() < 2 && lastDigestDate !== today) {
    lastDigestDate = today;
    sendDailyDigest();
  }
}, 60_000);

// /digest — manually trigger daily digest
bot.onText(/\/digest/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  sendDailyDigest();
});

// --- Scheduled Briefings (every N hours) ---
async function sendScheduledBriefings() {
  /* demo-mode: proceed — fetch functions handle fallback */
  const scannerState = loadScannerState();

  // Send to all scanner subscribers (they opted in for proactive updates)
  const subscribers = Object.entries(scannerState.subscribers || {}).filter(([, sub]) => sub.active);
  if (!subscribers.length) return;

  log.info(`[briefing] Sending scheduled briefing to ${subscribers.length} subscriber(s)`);

  for (const [chatId] of subscribers) {
    if (isQuietTime(chatId)) continue; // respect quiet hours
    try {
      const briefing = await generateBriefing(parseInt(chatId, 10), 'scheduled');
      if (briefing) {
        await bot.sendMessage(parseInt(chatId, 10), briefing, { parse_mode: 'Markdown' });
        lastBriefingTime.set(parseInt(chatId, 10), Date.now());
      }
    } catch (err) {
      log.info(`[briefing] Error sending to ${chatId}: ${err.message}`);
    }
    // Stagger sends to avoid Telegram rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  // Reload after awaits — another writer may have updated briefing state during the send loop
  const bState = loadBriefingState();
  bState.lastScheduled = new Date().toISOString();
  saveBriefingState(bState);
}

// Run briefing every N hours
let lastBriefingRun = '';
setInterval(() => {
  const now = new Date();
  const slotKey = `${now.toISOString().slice(0, 10)}-${Math.floor(now.getHours() / BRIEFING_INTERVAL_HOURS)}`;
  // Minute window <2 absorbs setInterval drift; slotKey prevents duplicate sends.
  if (now.getMinutes() < 2 && slotKey !== lastBriefingRun) {
    if (now.getHours() % BRIEFING_INTERVAL_HOURS === 0) {
      lastBriefingRun = slotKey;
      sendScheduledBriefings().catch(err => log.warn(`[briefing] Error: ${err.message}`));
    }
  }
}, 60_000);

// Daily admin digest — sent every day at 08:00 UTC to all ADMIN_USERS
let lastDigestSlot = '';
setInterval(() => {
  const now = new Date();
  if (now.getUTCHours() !== 8 || now.getMinutes() >= 2) return;
  const slot = now.toISOString().slice(0, 10);
  if (slot === lastDigestSlot) return;
  lastDigestSlot = slot;
  if (ADMIN_USERS.length === 0) return;

  try {
    const tiers = loadTiers();
    const subs = loadSubscriptions();
    const bankrolls = loadBankroll();
    const referrals = loadReferrals();
    const onboarded = loadOnboarded();
    const userSettings = loadUserSettings();

    // Total users
    const allUsers = new Set();
    for (const k of Object.keys(tiers)) allUsers.add(k);
    for (const k of Object.keys(subs)) if (!k.startsWith('pending:')) allUsers.add(k);
    for (const k of Object.keys(bankrolls)) allUsers.add(k);
    for (const k of Object.keys(onboarded)) allUsers.add(k);
    for (const k of Object.keys(userSettings)) allUsers.add(k);

    // DAU / WAU
    const today = todayUtc();
    const d = new Date();
    const weekAgo = new Date(d.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterday = new Date(d.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let dau = 0, wau = 0, yesterdayActive = 0;
    for (const s of Object.values(userSettings)) {
      if (!s?.lastSeenDay) continue;
      if (s.lastSeenDay === today) dau++;
      if (s.lastSeenDay === yesterday) yesterdayActive++;
      if (s.lastSeenDay >= weekAgo) wau++;
    }

    // Subscription stats
    let activePaid = 0, trialing = 0, mrr = 0;
    for (const [key, s] of Object.entries(subs)) {
      if (key.startsWith('pending:')) continue;
      if (s.status === 'active') {
        activePaid++;
        if (s.tier === 'plus' || s.tier === 'pro') mrr += 50;
        else if (s.tier === 'plusmax' || s.tier === 'syndicate') mrr += 300;
      }
      if (s.status === 'trialing') trialing++;
    }

    // Referrals
    const refEntries = Object.values(referrals);
    const refTotal = refEntries.length;
    const refConverted = refEntries.filter(r => r.convertedAt).length;

    // Betting
    let totalBets = 0, aggregatePL = 0;
    for (const br of Object.values(bankrolls)) {
      if (!br.bets?.length) continue;
      totalBets += br.bets.length;
      const won = br.bets.filter(b => b.result === 'win');
      const lost = br.bets.filter(b => b.result === 'loss');
      aggregatePL += won.reduce((s, b) => s + (b.stake * b.odds - b.stake), 0) - lost.reduce((s, b) => s + b.stake, 0);
    }

    const lines = [
      `*📋 Daily Digest — ${today}*`,
      '',
      '*Users*',
      `  Total: ${allUsers.size}`,
      `  Active yesterday: ${yesterdayActive}`,
      `  WAU (7d): ${wau}`,
      '',
      '*Revenue*',
      `  Paying: ${activePaid} | Trials: ${trialing}`,
      `  MRR: €${mrr}`,
      '',
      '*Referrals*',
      `  ${refTotal} invited → ${refConverted} converted`,
      '',
      '*Betting*',
      `  ${totalBets} total bets | P/L: €${aggregatePL.toFixed(2)}`,
    ];

    for (const adminId of ADMIN_USERS) {
      bot.sendMessage(adminId, lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
    }
    log.info(`[digest] Daily admin digest sent to ${ADMIN_USERS.length} admin(s)`);
  } catch (err) {
    log.warn(`[digest] Error generating daily digest: ${err.message}`);
  }
}, 60_000);

// Settle reminders — nudge users with pending bets older than 48 hours (runs at 10:00 UTC daily)
let lastSettleReminderSlot = '';
setInterval(() => {
  const now = new Date();
  if (now.getUTCHours() !== 10 || now.getMinutes() >= 2) return;
  const slot = now.toISOString().slice(0, 10);
  if (slot === lastSettleReminderSlot) return;
  lastSettleReminderSlot = slot;

  try {
    const bankrolls = loadBankroll();
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (const [chatId, br] of Object.entries(bankrolls)) {
      const pending = (br.bets || []).filter(b => !b.result && new Date(b.createdAt || 0).getTime() < cutoff);
      if (pending.length === 0) continue;
      const lines = [
        `⏰ *Settle reminder*`,
        '',
        `You have *${pending.length}* pending bet(s) older than 48 hours:`,
      ];
      for (const b of pending.slice(0, 5)) {
        lines.push(`  #${b.id} — €${b.stake} @ ${b.odds.toFixed(2)} — ${(b.desc || '').slice(0, 30)}`);
      }
      if (pending.length > 5) lines.push(`  _...and ${pending.length - 5} more_`);
      lines.push('', 'Use `/betwin <id>` or `/betloss <id>` to settle them.');
      bot.sendMessage(parseInt(chatId, 10), lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (err) {
    log.warn(`[settle-reminder] Error: ${err.message}`);
  }
}, 60_000);

// Trial expiry reminder — warn users 2 days before trial ends (runs at 09:00 UTC daily)
let lastTrialReminderSlot = '';
setInterval(() => {
  const now = new Date();
  if (now.getUTCHours() !== 9 || now.getMinutes() >= 2) return;
  const slot = now.toISOString().slice(0, 10);
  if (slot === lastTrialReminderSlot) return;
  lastTrialReminderSlot = slot;

  try {
    const subs = loadSubscriptions();
    const twoDaysFromNow = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const oneDayFromNow = Date.now() + 1 * 24 * 60 * 60 * 1000;

    for (const [chatId, sub] of Object.entries(subs)) {
      if (chatId.startsWith('pending:')) continue;
      if (sub.status !== 'trialing') continue;
      if (!sub.currentPeriodEnd) continue;

      const endMs = new Date(sub.currentPeriodEnd).getTime();
      // Send reminder when trial ends within 2 days (but not already past)
      if (endMs > oneDayFromNow && endMs <= twoDaysFromNow) {
        const daysLeft = Math.ceil((endMs - Date.now()) / (24 * 60 * 60 * 1000));
        bot.sendMessage(parseInt(chatId, 10), [
          '⏳ *Trial ending soon*',
          '',
          `Your free trial ends in *${daysLeft} day(s)*.`,
          '',
          'After that, your card will be charged automatically.',
          'To cancel: /billing → Cancel subscription.',
          '',
          '_Enjoying Ruflo? Do nothing — your subscription continues seamlessly._',
        ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
  } catch (err) {
    log.warn(`[trial-reminder] Error: ${err.message}`);
  }
}, 60_000);

// Inactivity re-engagement — message users who haven't been active in 7+ days (runs at 11:00 UTC, Mondays only)
let lastReengageSlot = '';
setInterval(() => {
  const now = new Date();
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 11 || now.getMinutes() >= 2) return;
  const slot = now.toISOString().slice(0, 10);
  if (slot === lastReengageSlot) return;
  lastReengageSlot = slot;

  try {
    const settings = loadUserSettings();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let sent = 0;

    for (const [chatId, s] of Object.entries(settings)) {
      if (!s?.lastSeenDay) continue;
      // Only message users who were active 1-2 weeks ago (not ancient/dead accounts)
      if (s.lastSeenDay < twoWeeksAgo || s.lastSeenDay >= weekAgo) continue;
      if (!hasAcceptedLegal(chatId)) continue;

      bot.sendMessage(parseInt(chatId, 10), [
        "Hey! It's been a while 👋",
        '',
        "Here's what you've been missing:",
        '',
        '📊 Fresh signals are waiting for you',
        '💎 New value bets drop every day',
        '',
        '_Tap below to jump back in._',
      ].join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📊 Today's signals", callback_data: 'cmd:signals' },
              { text: '💎 Value bets', callback_data: 'cmd:value' },
            ],
          ],
        },
      }).catch(() => {});
      sent++;
      if (sent >= 50) break; // cap to avoid spam
    }
    if (sent > 0) log.info(`[re-engage] Sent ${sent} re-engagement message(s)`);
  } catch (err) {
    log.warn(`[re-engage] Error: ${err.message}`);
  }
}, 60_000);

// /briefing — manually trigger a briefing for yourself
bot.onText(/\/briefing/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const thinking = await bot.sendMessage(msg.chat.id, '🔍 Generating briefing...');
  try {
    const briefing = await generateBriefing(msg.chat.id, 'manual');
    await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
    if (briefing) {
      await bot.sendMessage(msg.chat.id, briefing, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(msg.chat.id, 'No events found right now.');
    }
  } catch (err) {
    await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
    await replyError(msg.chat.id, err);
  }
  lastBriefingTime.set(msg.chat.id, Date.now());
});

// --- Multi-sport Parlay ---
// /parlay <sport1> <sport2> ... — build cross-sport accumulator
bot.onText(/\/parlay\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */

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
      replyError(msg.chat.id, err);
    }
  });
});

// --- Telegram Inline Mode ---
bot.on('inline_query', async (query) => {
  const text = (query.query || '').trim().toLowerCase();
  /* demo-mode: proceed — fetch functions handle fallback */

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
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */
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
          const h = parseInt(homeScore, 10), a = parseInt(awayScore, 10);
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
          const hs = parseInt(m.scores?.find(s => s.name === m.home_team)?.score || '0', 10);
          const as = parseInt(m.scores?.find(s => s.name === m.away_team)?.score || '0', 10);
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
      replyError(msg.chat.id, err);
    }
  });
});

// --- Closing Line Value (CLV) Tracker ---
function loadCLV() { try { return JSON.parse(fs.readFileSync(CLV_FILE, 'utf8')); } catch { return { bets: [] }; } }
function saveCLV(data) { atomicWriteJson(CLV_FILE, data); }

// Auto-record closing odds for tracked bets
async function updateClosingOdds() {
  /* demo-mode: proceed — fetch functions handle fallback */
  const br = loadBankroll();
  let events = null;

  // Accumulate changes without mutating on-disk state until the end —
  // the fetch awaits inside the loop could let another writer (e.g. /bet) interleave.
  const betPatches = []; // { chatId, betId, closingOdds, closingTime, match, betOdds, desc }

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
          betPatches.push({
            chatId, betId: bet.id, closingOdds: bestOdds,
            closingTime: new Date().toISOString(),
            match: `${ev.home_team} vs ${ev.away_team}`,
            betOdds: bet.odds, desc: bet.desc,
          });
        }
      } catch {}
    }
  }

  if (!betPatches.length) return;

  // Reload both files after awaits and merge in the accumulated patches
  const freshBr = loadBankroll();
  const freshClv = loadCLV();
  for (const p of betPatches) {
    const userBet = freshBr[p.chatId]?.bets?.find(b => b.id === p.betId);
    if (userBet && !userBet.closingOdds) {
      userBet.closingOdds = p.closingOdds;
      userBet.closingTime = p.closingTime;
    }
    freshClv.bets.push({
      betId: p.betId, chatId: p.chatId, desc: p.desc,
      betOdds: p.betOdds, closingOdds: p.closingOdds,
      match: p.match, closingTime: p.closingTime,
    });
  }
  saveBankroll(freshBr);
  saveCLV(freshClv);
}

// Run CLV check every 15 minutes
setInterval(updateClosingOdds, 15 * 60 * 1000);

// /closing — show CLV stats
bot.onText(/\/closing/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const clv = loadCLV();
  if (!clv.bets.length) {
    bot.sendMessage(msg.chat.id, '*Closing Line Value*\n\nNo CLV data yet. Place bets with `/bet` and the bot will automatically track closing odds near kickoff.\n\n_CLV = did you beat the closing line? Positive CLV = long-term edge._', { parse_mode: 'Markdown' });
    return;
  }

  let totalCLV = 0, count = 0;
  const lines = ['*Closing Line Value Tracker*\n'];

  const recent = clv.bets.slice(-10).reverse();
  for (const b of recent) {
    // Pick the closing price for the outcome the user actually bet on.
    // Heuristic: the outcome whose closing price is closest to the original bet odds.
    // This is far more accurate than Math.max, which was always comparing vs the underdog.
    const closingVals = Object.values(b.closingOdds || {}).filter(v => Number.isFinite(v));
    if (!closingVals.length) continue;
    const closingForPick = closingVals.reduce((best, p) =>
      Math.abs(p - b.betOdds) < Math.abs(best - b.betOdds) ? p : best
    , closingVals[0]);
    const clvPct = ((b.betOdds / closingForPick) - 1) * 100;
    totalCLV += clvPct;
    count++;
    const icon = clvPct > 0 ? '✅' : '❌';
    lines.push(`${icon} ${escapeMd(b.desc)}`);
    lines.push(`  Bet @ ${b.betOdds.toFixed(2)} | Close @ ~${closingForPick.toFixed(2)} | CLV: *${clvPct >= 0 ? '+' : ''}${clvPct.toFixed(1)}%*`);
  }

  const avgCLV = count > 0 ? totalCLV / count : 0;
  lines.push(`\n*Average CLV: ${avgCLV >= 0 ? '+' : ''}${avgCLV.toFixed(1)}%*`);
  lines.push(`_${count} bets tracked_`);
  lines.push('\n_Positive CLV = you consistently beat the market. This is the #1 metric pros use._');
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// ============================================================
// --- /track — Signal Performance Dashboard ---
// ============================================================
bot.onText(/\/track\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const arg = (match[1] || '').trim().toLowerCase();
  const track = loadSignalTrack();

  if (arg === 'all' || arg === 'detail') {
    // Show last 20 signals with results
    const recent = track.signals.filter(s => s.result && s.result !== 'expired').slice(-20).reverse();
    if (!recent.length) {
      bot.sendMessage(msg.chat.id, '*Signal Track Record*\n\nNo settled signals yet. The scanner automatically tracks and settles signals against actual results.\n\n_Use /scanner on to start generating signals._', { parse_mode: 'Markdown' });
      return;
    }
    const lines = ['*Signal Track Record (Last 20)*\n'];
    for (const s of recent) {
      const icon = s.result === 'win' ? '✅' : s.result === 'loss' ? '❌' : s.result === 'push' ? '🟡' : 'ℹ️';
      const pnl = s.hypotheticalReturn ? `€${(s.hypotheticalReturn - s.hypotheticalStake).toFixed(2)}` : '-';
      lines.push(`${icon} *${s.type}* — ${s.match}`);
      if (s.outcome) lines.push(`  ${s.outcome} @ ${s.odds?.toFixed(2) || '-'} | ${s.edge ? (s.edge * 100).toFixed(1) + '% edge' : ''}`);
      if (s.actualScore) lines.push(`  Result: ${s.actualScore} | P&L: ${pnl}`);
      lines.push('');
    }
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // Default: show summary stats
  const { stats } = track;
  const roi = stats.totalStaked > 0 ? ((stats.totalReturn - stats.totalStaked) / stats.totalStaked * 100) : 0;
  const winRate = stats.settled > 0 ? (stats.won / (stats.won + stats.lost) * 100) : 0;
  const pnl = stats.totalReturn - stats.totalStaked;
  const valueSignals = track.signals.filter(s => s.type === 'VALUE');
  const settledValue = valueSignals.filter(s => s.result === 'win' || s.result === 'loss');
  const valueWinRate = settledValue.length > 0 ? (settledValue.filter(s => s.result === 'win').length / settledValue.length * 100) : 0;
  const avgEdge = valueSignals.length > 0 ? (valueSignals.reduce((sum, s) => sum + (s.edge || 0), 0) / valueSignals.length * 100) : 0;

  // By league breakdown
  const leagueStats = {};
  for (const s of track.signals.filter(s => s.result === 'win' || s.result === 'loss')) {
    const league = s.league || 'unknown';
    if (!leagueStats[league]) leagueStats[league] = { won: 0, lost: 0, staked: 0, returned: 0 };
    leagueStats[league][s.result === 'win' ? 'won' : 'lost']++;
    leagueStats[league].staked += s.hypotheticalStake;
    leagueStats[league].returned += s.hypotheticalReturn || 0;
  }

  // Recent form (last 10)
  const lastTen = track.signals.filter(s => s.result === 'win' || s.result === 'loss').slice(-10);
  const form = lastTen.map(s => s.result === 'win' ? '✅' : '❌').join('');

  const lines = [
    '*Signal Performance Dashboard*\n',
    `*Overall:*`,
    `  Signals tracked: ${stats.total}`,
    `  Settled: ${stats.settled} (${stats.won}W / ${stats.lost}L / ${stats.push}P)`,
    `  Win rate: *${winRate.toFixed(1)}%*`,
    `  ROI: *${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%*`,
    `  P&L: *${pnl >= 0 ? '+' : ''}€${pnl.toFixed(2)}* (€10 flat stakes)`,
    '',
    `*Value Bets:*`,
    `  Tracked: ${valueSignals.length} | Settled: ${settledValue.length}`,
    `  Win rate: *${valueWinRate.toFixed(1)}%*`,
    `  Avg edge: ${avgEdge.toFixed(1)}%`,
    '',
    `*Arbs:* ${track.signals.filter(s => s.type === 'ARB').length} found`,
    `*Steam Moves:* ${track.signals.filter(s => s.type === 'STEAM').length} detected`,
    '',
  ];

  if (form.length) {
    lines.push(`*Recent form:* ${form}`);
    lines.push('');
  }

  // Top 3 leagues by ROI
  const leagueArr = Object.entries(leagueStats)
    .map(([league, ls]) => ({ league, roi: ls.staked > 0 ? ((ls.returned - ls.staked) / ls.staked * 100) : 0, ...ls }))
    .sort((a, b) => b.roi - a.roi);
  if (leagueArr.length > 0) {
    lines.push('*By league:*');
    for (const ls of leagueArr.slice(0, 5)) {
      const name = LEAGUE_CATALOG[ls.league]?.name || ls.league;
      lines.push(`  ${name}: ${ls.won}W/${ls.lost}L | ROI: ${ls.roi >= 0 ? '+' : ''}${ls.roi.toFixed(1)}%`);
    }
    lines.push('');
  }

  lines.push('_Use /track all for detailed signal history_');
  lines.push('_Use /proof for shareable track record_');

  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// --- /proof — Shareable track record summary ---
bot.onText(/\/proof/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const track = loadSignalTrack();
  const { stats } = track;

  if (stats.settled < 5) {
    bot.sendMessage(msg.chat.id, '*Track Record*\n\nNeed at least 5 settled signals to generate a proof card. Keep the scanner running!\n\n_Current: ' + stats.settled + ' settled_', { parse_mode: 'Markdown' });
    return;
  }

  const roi = stats.totalStaked > 0 ? ((stats.totalReturn - stats.totalStaked) / stats.totalStaked * 100) : 0;
  const winRate = (stats.won / (stats.won + stats.lost) * 100);
  const pnl = stats.totalReturn - stats.totalStaked;
  const streak = (() => {
    const recent = track.signals.filter(s => s.result === 'win' || s.result === 'loss').slice(-20);
    let current = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].result === recent[recent.length - 1].result) current++;
      else break;
    }
    return { count: current, type: recent[recent.length - 1]?.result || 'none' };
  })();

  const lines = [
    '━━━━━━━━━━━━━━━━━━━━━━',
    '  *RUFLO VERIFIED TRACK RECORD*',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `  📊 Signals: ${stats.total} tracked | ${stats.settled} settled`,
    `  ✅ Win Rate: *${winRate.toFixed(1)}%*`,
    `  📈 ROI: *${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%*`,
    `  💰 P&L: *${pnl >= 0 ? '+' : ''}€${pnl.toFixed(2)}* (€10 stakes)`,
    `  🔥 Current streak: ${streak.count}x ${streak.type}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    `  _Generated ${new Date().toLocaleDateString('en-GB')} by Ruflo_`,
    '━━━━━━━━━━━━━━━━━━━━━━',
  ];

  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// --- ELO Rating System ---
function loadElo() { try { return JSON.parse(fs.readFileSync(ELO_FILE, 'utf8')); } catch { return {}; } }
function saveElo(data) { atomicWriteJson(ELO_FILE, data); }

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
  /* demo-mode: proceed — fetch functions handle fallback */
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
      updateElo(m.home_team, m.away_team, parseInt(hs, 10), parseInt(as, 10));
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
  if (!gateRate(msg)) return;
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
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */

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
      replyError(msg.chat.id, err);
    }
  });
});

// --- Surebets (arb with exact stake calculation) ---
// /surebets [bankroll] — find arbs with exact stake breakdown
bot.onText(/\/surebets\s*(\d+(?:\.\d+)?)?/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */
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
      replyError(msg.chat.id, err);
    }
  });
});

// --- Bet Slip Buttons (inline betting from /odds) ---
// Adds "Quick Bet €5/€10" buttons to /compare results
// Handled via callback_query below

// --- Auto-settle Bets (check scores and auto-resolve) ---
// Patterns that mean we CAN'T safely auto-settle as money-line
const AUTO_SETTLE_BLOCKLIST = /\b(over|under|spread|handicap|total|btts|both\s*teams|correct\s*score|first\s*half|second\s*half|asian|ou|o\/u|ht\/ft|dnb|draw\s*no\s*bet|double\s*chance|\+\d|-\d|[+-]\d+(\.\d+)?|\d+\.\d+\s*goals|o\d|u\d)\b/i;

async function autoSettleBets() {
  /* demo-mode: proceed — fetch functions handle fallback */
  try {
    const scoresUrl = `${ODDS_BASE}/sports/soccer/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3&dateFormat=iso`;
    const res = await fetch(scoresUrl);
    if (!res.ok) return;
    const completed = (await res.json()).filter(m => m.completed);
    if (!completed.length) return;

    // Snapshot the current state BEFORE we start analyzing, to know which bets are pending
    const snapshot = loadBankroll();
    // Accumulate settlement patches — do NOT mutate the live file until all analysis is done
    const patches = []; // { chatId, betId, result, scoreStr, desc, stake, odds }

    for (const [chatId, br] of Object.entries(snapshot)) {
      for (const bet of (br.bets || [])) {
        if (bet.result) continue;
        const desc = (bet.desc || '').toLowerCase().trim();
        if (!desc) continue;

        // Skip anything we can't interpret as a simple money-line bet
        if (AUTO_SETTLE_BLOCKLIST.test(desc)) continue;

        // Find ALL completed matches this description plausibly matches.
        // If more than one matches, skip — ambiguity means we'd rather be safe.
        const candidates = [];
        for (const m of completed) {
          const homeL = m.home_team.toLowerCase();
          const awayL = m.away_team.toLowerCase();
          // Require the full team name to appear as a whole word in the description.
          // This kills "Real" matching both "Real Madrid" and "Real Sociedad".
          const homeRe = new RegExp(`\\b${homeL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
          const awayRe = new RegExp(`\\b${awayL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
          const hasHome = homeRe.test(desc);
          const hasAway = awayRe.test(desc);
          if (hasHome || hasAway) candidates.push({ m, hasHome, hasAway });
        }
        if (candidates.length !== 1) continue; // 0 = no match, >1 = ambiguous

        const { m: matchEv, hasHome, hasAway } = candidates[0];
        const homeScoreRaw = matchEv.scores?.find(s => s.name === matchEv.home_team)?.score;
        const awayScoreRaw = matchEv.scores?.find(s => s.name === matchEv.away_team)?.score;
        const hs = parseInt(homeScoreRaw ?? '', 10);
        const as = parseInt(awayScoreRaw ?? '', 10);
        if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;

        let betWon = null;
        const isDraw = /\bdraw\b/.test(desc) || /\bx\b/.test(desc);
        if (isDraw && !hasHome && !hasAway) {
          betWon = hs === as;
        } else if (hasHome && !hasAway) {
          betWon = hs > as;
        } else if (hasAway && !hasHome) {
          betWon = as > hs;
        } else {
          // Both team names in description (e.g. "Arsenal vs Chelsea") — too ambiguous
          continue;
        }

        patches.push({
          chatId,
          betId: bet.id,
          result: betWon ? 'win' : 'loss',
          scoreStr: `${matchEv.home_team} ${hs}-${as} ${matchEv.away_team}`,
          desc: bet.desc,
          stake: bet.stake,
          odds: bet.odds,
        });
      }
    }

    if (!patches.length) return;

    // Reload fresh bankroll AFTER awaits & analysis, then merge patches in
    const fresh = loadBankroll();
    let applied = 0;
    for (const p of patches) {
      const userBr = fresh[p.chatId];
      if (!userBr) continue;
      const freshBet = userBr.bets?.find(b => b.id === p.betId);
      if (!freshBet || freshBet.result) continue; // user settled manually in the meantime
      freshBet.result = p.result;
      freshBet.settledAt = new Date().toISOString();
      freshBet.autoSettled = true;
      applied++;

      const icon = p.result === 'win' ? '✅' : '❌';
      const pnl = p.result === 'win' ? `+€${(p.stake * p.odds - p.stake).toFixed(2)}` : `-€${p.stake.toFixed(2)}`;
      bot.sendMessage(parseInt(p.chatId, 10),
        `${icon} *Auto-settled:* Bet #${p.betId}\n${escapeMd(p.desc)} — ${pnl}\nFinal: ${escapeMd(p.scoreStr)}\n_If wrong, use \`/betreset ${p.betId}\`._`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
    if (applied > 0) saveBankroll(fresh);
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

    const unitValue = getUnitValue(br);
    const lines = ['*Weekly Betting Report*\n'];
    lines.push(`*P/L: ${netPL >= 0 ? '+' : ''}€${netPL.toFixed(2)}*${formatUnits(netPL, unitValue, { signed: true })}`);
    lines.push(`ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
    lines.push(`Record: ${won.length}W / ${lost.length}L (${winRate.toFixed(0)}%)`);
    lines.push(`Staked: €${totalStaked.toFixed(2)}${formatUnits(totalStaked, unitValue)}`);

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
    bot.sendMessage(parseInt(chatId, 10), lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
  }
}

// Weekly report check (Monday at DIGEST_HOUR)
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getDay() === WEEKLY_REPORT_DAY && now.getHours() === DIGEST_HOUR && now.getMinutes() < 2 && lastWeeklyDate !== today) {
    lastWeeklyDate = today;
    sendWeeklyReport();
  }
}, 60_000);

// /weekly — trigger weekly report manually
bot.onText(/\/weekly/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  sendWeeklyReport();
});

// --- Quick Bet Buttons (extend callback handler) ---
// Adds bet recording from inline keyboard buttons

// --- Enhanced /compare with bet buttons ---
// We'll extend the callback_query handler to support quick bets

// ============================================================
// ============================================================
// --- STRIPE SUBSCRIPTION MANAGEMENT ---
// ============================================================
function loadSubscriptions() {
  try { return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveSubscriptions(data) {
  atomicWriteJson(SUBSCRIPTIONS_FILE, data);
}
function getUserSubscription(chatId) {
  return loadSubscriptions()[String(chatId)] || null;
}
function setUserSubscription(chatId, sub) {
  const all = loadSubscriptions();
  all[String(chatId)] = sub;
  saveSubscriptions(all);
}

// ============================================================
// --- REFERRAL PROGRAM ---
// ============================================================
// Data model:
//   referrals.json = {
//     "<refereeChatId>": { referrer: "<referrerChatId>", invitedAt, convertedAt, rewardApplied },
//   }
// Plus derived stats: iterate all entries where referrer === X to count invites/conversions.
function loadReferrals() {
  try { return JSON.parse(fs.readFileSync(REFERRALS_FILE, 'utf8')); } catch { return {}; }
}
function saveReferrals(data) {
  atomicWriteJson(REFERRALS_FILE, data);
}
function recordReferral(refereeChatId, referrerChatId) {
  const referee = String(refereeChatId);
  const referrer = String(referrerChatId);
  if (referee === referrer) return { ok: false, reason: 'self' };
  const data = loadReferrals();
  if (data[referee]) return { ok: false, reason: 'already_referred' };
  // Prevent cycles: if the referrer was referred by the referee, reject
  if (data[referrer]?.referrer === referee) return { ok: false, reason: 'cycle' };
  // Don't record referral for users who already have an active paid subscription
  const existingSub = getUserSubscription(referee);
  if (existingSub?.stripeSubscriptionId && (existingSub.status === 'active' || existingSub.status === 'trialing')) {
    return { ok: false, reason: 'already_subscribed' };
  }
  data[referee] = {
    referrer,
    invitedAt: new Date().toISOString(),
    convertedAt: null,
    rewardApplied: false,
  };
  saveReferrals(data);
  return { ok: true };
}
function getReferrerFor(chatId) {
  return loadReferrals()[String(chatId)]?.referrer || null;
}
function getReferralStats(chatId) {
  const who = String(chatId);
  const data = loadReferrals();
  let invited = 0;
  let converted = 0;
  for (const entry of Object.values(data)) {
    if (entry.referrer !== who) continue;
    invited++;
    if (entry.convertedAt) converted++;
  }
  return { invited, converted };
}
function markReferralConverted(refereeChatId) {
  const referee = String(refereeChatId);
  const data = loadReferrals();
  const entry = data[referee];
  if (!entry) return null;
  if (entry.convertedAt) return entry; // idempotent
  entry.convertedAt = new Date().toISOString();
  data[referee] = entry;
  saveReferrals(data);
  return entry;
}
function markReferralRewardApplied(refereeChatId) {
  const referee = String(refereeChatId);
  const data = loadReferrals();
  const entry = data[referee];
  if (!entry) return;
  entry.rewardApplied = true;
  data[referee] = entry;
  saveReferrals(data);
}
function buildReferralLink(chatId) {
  return `https://t.me/${BOT_USERNAME}?start=ref_${chatId}`;
}

// Apply a one-off Stripe coupon credit to a customer's upcoming invoice.
// Uses a pre-configured STRIPE_REFERRAL_COUPON (create once in Stripe dashboard as
// a 100%-off, duration=once coupon) — we just attach it to the customer so the
// next invoice is free. Safe to skip if not configured.
async function applyReferralReward(chatId, reasonLabel) {
  if (!stripe || !STRIPE_REFERRAL_COUPON) return false;
  const sub = getUserSubscription(chatId);
  if (!sub?.stripeCustomerId) return false;
  try {
    await stripe.customers.update(sub.stripeCustomerId, { coupon: STRIPE_REFERRAL_COUPON });
    log.info(`[referral] Applied coupon to ${chatId} (${reasonLabel})`);
    return true;
  } catch (err) {
    log.warn(`[referral] Failed to apply coupon to ${chatId}: ${err.message}`);
    return false;
  }
}

// --- Stripe webhook idempotency ---
const STRIPE_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days > Stripe's 3-day retry window
function loadStripeEvents() {
  try { return JSON.parse(fs.readFileSync(STRIPE_EVENTS_FILE, 'utf8')); } catch { return {}; }
}
function isStripeEventProcessed(eventId) {
  const events = loadStripeEvents();
  return !!events[eventId];
}
function markStripeEventProcessed(eventId) {
  const events = loadStripeEvents();
  events[eventId] = Date.now();
  const cutoff = Date.now() - STRIPE_EVENT_TTL_MS;
  for (const [id, ts] of Object.entries(events)) {
    if (ts < cutoff) delete events[id];
  }
  atomicWriteJson(STRIPE_EVENTS_FILE, events);
}

// Serialize webhook processing to avoid concurrent read-modify-write on subscriptions.json
let stripeWebhookChain = Promise.resolve();
function serializeWebhook(fn) {
  const next = stripeWebhookChain.then(fn, fn);
  stripeWebhookChain = next.catch(() => {});
  return next;
}

// Create Stripe Checkout session for a tier
async function createCheckoutSession(chatId, tierKey, opts = {}) {
  if (!stripe) throw new Error('Stripe not configured');
  const priceId = STRIPE_PRICES[tierKey];
  if (!priceId) throw new Error(`No Stripe price ID for tier: ${tierKey}`);

  const trialDays = opts.trialDays && opts.trialDays > 0 ? Math.floor(opts.trialDays) : 0;
  const metadata = { chatId: String(chatId), tier: tierKey };
  if (trialDays) metadata.trial = '1';

  const subscriptionData = { metadata: { ...metadata } };
  if (trialDays) subscriptionData.trial_period_days = trialDays;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: STRIPE_CANCEL_URL,
    metadata,
    subscription_data: subscriptionData,
  });

  return session;
}

// Check if a user is eligible for a free trial (never had one, no active sub)
function isTrialEligible(chatId) {
  const sub = getUserSubscription(chatId);
  if (!sub) return true;
  if (sub.trialUsed) return false;
  if (sub.stripeSubscriptionId && sub.status === 'active') return false;
  if (sub.stripeSubscriptionId && sub.status === 'trialing') return false;
  return true;
}

// Cancel a Stripe subscription
async function cancelSubscription(chatId) {
  if (!stripe) throw new Error('Stripe not configured');
  const sub = getUserSubscription(chatId);
  if (!sub?.stripeSubscriptionId) throw new Error('No active subscription');

  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  // Reload after the await — a webhook could have landed and updated state
  const fresh = getUserSubscription(chatId) || sub;
  fresh.cancelAtPeriodEnd = true;
  setUserSubscription(chatId, fresh);
  return fresh;
}

// Reactivate a cancelled subscription (before period ends)
async function reactivateSubscription(chatId) {
  if (!stripe) throw new Error('Stripe not configured');
  const sub = getUserSubscription(chatId);
  if (!sub?.stripeSubscriptionId) throw new Error('No subscription to reactivate');

  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    cancel_at_period_end: false,
  });

  const fresh = getUserSubscription(chatId) || sub;
  fresh.cancelAtPeriodEnd = false;
  setUserSubscription(chatId, fresh);
  return fresh;
}

// --- Stripe Webhook Server ---
const botStartTime = Date.now();
function startStripeWebhook() {
  const app = express();

  // Health check — always available for uptime monitoring / load balancers
  // --- Telegram Mini App: Bet Slip Builder ---
  app.get('/betslip', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Ruflo Bet Slip</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--tg-theme-bg-color, #1a1a2e); color: var(--tg-theme-text-color, #eee); padding: 16px; }
    h2 { font-size: 18px; margin-bottom: 12px; }
    .signal { background: var(--tg-theme-secondary-bg-color, #16213e); border-radius: 12px; padding: 14px; margin-bottom: 10px; cursor: pointer; border: 2px solid transparent; transition: border-color 0.2s; }
    .signal.selected { border-color: var(--tg-theme-button-color, #4ecdc4); }
    .signal .match { font-weight: 600; font-size: 15px; }
    .signal .details { font-size: 13px; opacity: 0.7; margin-top: 4px; }
    .signal .odds { font-size: 20px; font-weight: 700; color: var(--tg-theme-button-color, #4ecdc4); float: right; margin-top: -20px; }
    .stake-row { display: flex; gap: 8px; margin: 16px 0; align-items: center; }
    .stake-row label { font-size: 14px; white-space: nowrap; }
    .stake-row input { flex: 1; background: var(--tg-theme-secondary-bg-color, #16213e); color: var(--tg-theme-text-color, #eee); border: 1px solid #444; border-radius: 8px; padding: 10px; font-size: 16px; }
    .quick-stake { display: flex; gap: 6px; margin-bottom: 16px; }
    .quick-stake button { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid #444; background: var(--tg-theme-secondary-bg-color, #16213e); color: var(--tg-theme-text-color, #eee); font-size: 14px; cursor: pointer; }
    .quick-stake button:active { background: var(--tg-theme-button-color, #4ecdc4); color: #000; }
    .summary { background: var(--tg-theme-secondary-bg-color, #16213e); border-radius: 12px; padding: 14px; margin-top: 16px; }
    .summary .total-odds { font-size: 24px; font-weight: 700; color: var(--tg-theme-button-color, #4ecdc4); }
    .summary .potential { font-size: 14px; opacity: 0.7; }
    .book-buttons { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
    .book-buttons a { flex: 1; min-width: 80px; text-align: center; padding: 10px; border-radius: 8px; background: var(--tg-theme-button-color, #4ecdc4); color: #000; text-decoration: none; font-weight: 600; font-size: 14px; }
    .empty { text-align: center; padding: 40px 20px; opacity: 0.5; }
  </style>
</head>
<body>
  <h2>📋 Build Your Bet Slip</h2>
  <div id="signals"></div>
  <div class="stake-row">
    <label>Stake €</label>
    <input type="number" id="stake" value="10" min="1" step="1" inputmode="decimal">
  </div>
  <div class="quick-stake">
    <button onclick="setStake(5)">€5</button>
    <button onclick="setStake(10)">€10</button>
    <button onclick="setStake(25)">€25</button>
    <button onclick="setStake(50)">€50</button>
  </div>
  <div class="summary" id="summary" style="display:none">
    <div>Selections: <span id="count">0</span> | Combined odds: <span class="total-odds" id="totalOdds">-</span></div>
    <div class="potential">Potential return: €<span id="potential">0</span></div>
    <div class="book-buttons" id="bookButtons"></div>
  </div>
  <div class="empty" id="empty">Tap signals above to add to your bet slip</div>

  <script>
    const tg = window.Telegram?.WebApp;
    if (tg) tg.ready();
    const params = new URLSearchParams(window.location.search);
    let signals = [];
    try { signals = JSON.parse(decodeURIComponent(params.get('signals') || '[]')); } catch {}
    let books = [];
    try { books = JSON.parse(decodeURIComponent(params.get('books') || '[]')); } catch {}
    const selected = new Set();

    function render() {
      const container = document.getElementById('signals');
      if (!signals.length) { container.innerHTML = '<div class="empty">No signals available right now</div>'; return; }
      container.innerHTML = signals.map((s, i) => \`
        <div class="signal \${selected.has(i) ? 'selected' : ''}" onclick="toggle(\${i})">
          <div class="match">\${s.match}</div>
          <div class="odds">\${s.odds.toFixed(2)}</div>
          <div class="details">\${s.outcome} · \${s.bookmaker} · Edge: \${(s.edge * 100).toFixed(1)}%</div>
        </div>
      \`).join('');
      updateSummary();
    }

    function toggle(i) { selected.has(i) ? selected.delete(i) : selected.add(i); render(); }
    function setStake(v) { document.getElementById('stake').value = v; updateSummary(); }

    function updateSummary() {
      const stake = parseFloat(document.getElementById('stake').value) || 0;
      const picks = [...selected].map(i => signals[i]);
      const summaryEl = document.getElementById('summary');
      const emptyEl = document.getElementById('empty');
      if (!picks.length) { summaryEl.style.display = 'none'; emptyEl.style.display = 'block'; return; }
      summaryEl.style.display = 'block'; emptyEl.style.display = 'none';
      const combinedOdds = picks.reduce((acc, p) => acc * p.odds, 1);
      document.getElementById('count').textContent = picks.length;
      document.getElementById('totalOdds').textContent = combinedOdds.toFixed(2);
      document.getElementById('potential').textContent = (stake * combinedOdds).toFixed(2);
      // Bookmaker buttons
      const bbEl = document.getElementById('bookButtons');
      bbEl.innerHTML = books.map(b => \`<a href="\${b.url}" target="_blank">\${b.flag} \${b.name}</a>\`).join('');
    }

    document.getElementById('stake').addEventListener('input', updateSummary);
    render();

    // Send data back to bot via Telegram WebApp
    if (tg) {
      tg.MainButton.setText('📋 Copy Bet Slip');
      tg.MainButton.show();
      tg.MainButton.onClick(() => {
        const picks = [...selected].map(i => signals[i]);
        const stake = parseFloat(document.getElementById('stake').value) || 10;
        tg.sendData(JSON.stringify({ picks, stake }));
      });
    }
  </script>
</body>
</html>`);
  });

  // API endpoint for Mini App to fetch current signals
  app.get('/api/signals', (req, res) => {
    try {
      const track = JSON.parse(fs.readFileSync(stateFile('signal_track.json'), 'utf8'));
      const recent = (track.active || []).slice(-20).map(s => ({
        match: s.match || s.event || '',
        outcome: s.outcome || '',
        odds: s.odds || 0,
        bookmaker: s.bookmaker || '',
        edge: s.edge || 0,
        time: s.time || '',
      }));
      res.json({ signals: recent });
    } catch {
      res.json({ signals: [] });
    }
  });

  app.get('/health', (req, res) => {
    const uptimeSec = Math.floor((Date.now() - botStartTime) / 1000);
    const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    let signalTrackSize = 0;
    try { signalTrackSize = fs.statSync(SIGNAL_TRACK_FILE).size; } catch {}
    res.json({
      status: 'ok',
      version: '1.1',
      uptimeSec,
      memoryMb: memMb,
      sessions: {
        active: activeSessions.size,
        persisted: claudeSessions.size,
      },
      features: {
        oddsApi: _hasOddsKey,
        stripe: !!stripe,
        ai: !!ANTHROPIC_API_KEY,
      },
      signalTrackBytes: signalTrackSize,
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness probe — returns 503 if critical deps are missing
  app.get('/ready', (req, res) => {
    if (!TOKEN) return res.status(503).json({ ready: false, reason: 'no telegram token' });
    res.json({ ready: true });
  });

  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    log.info('[http] Stripe webhook disabled (missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET)');
    app.listen(STRIPE_WEBHOOK_PORT, '0.0.0.0', () => {
      log.info(`[http] Health server listening on port ${STRIPE_WEBHOOK_PORT} (/health, /ready)`);
    });
    return;
  }

  // Stripe requires raw body for signature verification
  app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      log.info(`[stripe] Webhook signature verification failed: ${err.message}`);
      return res.status(400).send('Webhook signature verification failed');
    }

    log.info(`[stripe] Event: ${event.type} id=${event.id}`);

    // Acknowledge immediately so Stripe doesn't retry while we process
    res.json({ received: true });

    // Serialize all webhook processing to avoid concurrent read-modify-write races
    serializeWebhook(async () => {
      if (isStripeEventProcessed(event.id)) {
        log.info(`[stripe] Duplicate event ${event.id} — skipping`);
        return;
      }

      try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const chatId = session.metadata?.chatId;
          const tier = session.metadata?.tier;
          const isTrial = session.metadata?.trial === '1';
          if (!chatId || !tier) break;

          // Get the subscription ID from the session
          const subId = session.subscription;

          // Preserve any state already set by a racing invoice.paid (Stripe doesn't guarantee ordering)
          const existing = getUserSubscription(chatId) || {};
          const alreadyActivated = existing.stripeSubscriptionId === subId;

          // Check for a pending invoice.paid that arrived before this event
          const allSubs = loadSubscriptions();
          const pendingKey = `pending:${subId}`;
          const pending = allSubs[pendingKey];
          if (pending) {
            delete allSubs[pendingKey];
            saveSubscriptions(allSubs);
          }

          // Upgrade the user
          setUserTier(chatId, tier);
          setUserSubscription(chatId, {
            ...existing,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: subId,
            tier,
            // Don't downgrade 'active' to 'trialing' if invoice.paid already fired (live or pending)
            status: (pending?.status === 'active' || existing.status === 'active') ? 'active' : (isTrial ? 'trialing' : 'active'),
            cancelAtPeriodEnd: false,
            trialUsed: isTrial ? true : existing.trialUsed,
            createdAt: existing.createdAt || new Date().toISOString(),
            // Preserve currentPeriodEnd from pending stash or existing state
            currentPeriodEnd: pending?.currentPeriodEnd || existing.currentPeriodEnd || null,
          });

          // Skip welcome spam on duplicate (shouldn't happen thanks to dedup, but defense in depth)
          if (alreadyActivated && existing.welcomeSent) break;

          // Notify user
          const tierInfo = TIERS[tier];
          const featuresLine = tierInfo.features.includes('*') ? 'All features unlocked.' : `Features: ${tierInfo.features.join(', ')}`;
          const body = isTrial ? [
            '✅ *Trial started!*',
            '',
            `You're on *${tierInfo.name}* for the next 7 days — free.`,
            featuresLine,
            '',
            '_After the trial, your card is charged automatically._',
            '_Cancel anytime with /billing before the trial ends._',
          ] : [
            '✅ *Payment successful!*',
            '',
            `You're now on *${tierInfo.name}* (${tierInfo.price})`,
            featuresLine,
            '',
            '_Your subscription will auto-renew monthly._',
            '_Use /billing to manage your subscription._',
          ];
          bot.sendMessage(parseInt(chatId, 10), body.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});

          // Mark welcome as sent so out-of-order retries don't double-message
          const afterWelcome = getUserSubscription(chatId);
          if (afterWelcome) setUserSubscription(chatId, { ...afterWelcome, welcomeSent: true });

          // Notify admins of new subscriber
          if (!alreadyActivated) {
            const adminMsg = [
              '🔔 *New subscriber*',
              '',
              `Chat ID: \`${chatId}\``,
              `Tier: *${tierInfo.name}* (${tierInfo.price})`,
              isTrial ? '🆓 Trial (7 days)' : '💳 Paid',
            ].join('\n');
            for (const adminId of ADMIN_USERS) {
              bot.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' }).catch(() => {});
            }
          }

          // Referral reward: if this is a first-time paid conversion and the user was referred,
          // credit both parties with a free month via Stripe coupon.
          if (!alreadyActivated) {
            const referral = loadReferrals()[String(chatId)];
            if (referral && !referral.rewardApplied) {
              markReferralConverted(chatId);
              const refereeRewarded = await applyReferralReward(chatId, 'referee');
              const referrerRewarded = await applyReferralReward(referral.referrer, 'referrer');
              if (refereeRewarded || referrerRewarded) {
                markReferralRewardApplied(chatId);
              }
              if (refereeRewarded) {
                bot.sendMessage(parseInt(chatId, 10), [
                  '🎁 *Referral bonus applied!*',
                  '',
                  'Your next month is *on us* — a friend invited you.',
                ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
              }
              if (referrerRewarded) {
                bot.sendMessage(parseInt(referral.referrer, 10), [
                  '🎉 *A friend you invited just subscribed!*',
                  '',
                  'Your next month is *free* — thanks for spreading Ruflo.',
                  '',
                  '_Invite more with /refer._',
                ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
              }
            }
          }
          break;
        }

        case 'invoice.paid': {
          const invoice = event.data.object;
          const subId = invoice.subscription;
          const periodEndTs = invoice.lines?.data?.[0]?.period?.end;
          const periodEnd = periodEndTs ? new Date(periodEndTs * 1000).toISOString() : null;
          // Find user by subscription ID (read fresh inside mutex)
          const subs = loadSubscriptions();
          let matched = false;
          for (const [chatId, sub] of Object.entries(subs)) {
            if (sub.stripeSubscriptionId === subId) {
              setUserSubscription(chatId, { ...sub, status: 'active', currentPeriodEnd: periodEnd });
              matched = true;
              break;
            }
          }
          if (!matched) {
            // Out-of-order: invoice.paid arrived before checkout.session.completed.
            // Stash by subId so checkout handler can merge when it lands.
            const pending = loadSubscriptions();
            pending[`pending:${subId}`] = { pendingInvoice: true, currentPeriodEnd: periodEnd, status: 'active' };
            saveSubscriptions(pending);
          }
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const subId = invoice.subscription;
          const subs = loadSubscriptions();
          for (const [chatId, sub] of Object.entries(subs)) {
            if (sub.stripeSubscriptionId === subId) {
              sub.status = 'past_due';
              setUserSubscription(chatId, sub);

              bot.sendMessage(parseInt(chatId, 10), [
                '⚠️ *Payment failed*',
                '',
                'Your subscription payment couldn\'t be processed.',
                'Please update your payment method to keep your access.',
                '',
                '_Use /billing to update payment details._',
              ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
              break;
            }
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const chatId = subscription.metadata?.chatId;
          if (!chatId) break;

          // Downgrade to free
          setUserTier(chatId, 'free');
          setUserSubscription(chatId, {
            ...getUserSubscription(chatId),
            status: 'cancelled',
            cancelledAt: new Date().toISOString(),
          });

          bot.sendMessage(parseInt(chatId, 10), [
            '*Subscription ended*',
            '',
            'You\'ve been moved to the *Free* tier.',
            'You can re-subscribe anytime with /subscribe.',
          ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});

          // Notify admins of churn
          for (const adminId of ADMIN_USERS) {
            bot.sendMessage(adminId, [
              '⚠️ *Subscriber lost*',
              '',
              `Chat ID: \`${chatId}\``,
              'Status: cancelled → free tier',
            ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
          }
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          const chatId = subscription.metadata?.chatId;
          if (!chatId) break;

          const sub = getUserSubscription(chatId);
          if (sub) {
            sub.cancelAtPeriodEnd = subscription.cancel_at_period_end;
            sub.status = subscription.status;
            sub.currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
            setUserSubscription(chatId, sub);
          }
          break;
        }
      }
      markStripeEventProcessed(event.id);
      } catch (err) {
        log.info(`[stripe] Error handling ${event.type} (${event.id}): ${err.message}`);
        // Don't mark processed — allow a manual replay if needed
      }
    });
  });

  app.listen(STRIPE_WEBHOOK_PORT, '0.0.0.0', () => {
    log.info(`[http] Server listening on port ${STRIPE_WEBHOOK_PORT} (/health, /ready, /webhook)`);
  });
}

startStripeWebhook();

// --- /subscribe — Upgrade subscription with Stripe ---
bot.onText(/\/subscribe\s*(.*)/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const arg = (match[1] || '').trim().toLowerCase();
  const chatId = String(msg.chat.id);

  if (!stripe) {
    bot.sendMessage(msg.chat.id, '*Payments not configured yet.*\n\nContact the admin to set up Stripe payments.', { parse_mode: 'Markdown' });
    return;
  }

  // Direct subscribe: /subscribe plus or /subscribe plusmax
  if (arg === 'plus' || arg === 'plusmax') {
    if (!STRIPE_PRICES[arg]) {
      bot.sendMessage(msg.chat.id, `Stripe price not configured for ${arg} tier. Contact admin.`);
      return;
    }
    try {
      const session = await createCheckoutSession(chatId, arg);
      bot.sendMessage(msg.chat.id, [
        `*Upgrade to ${TIERS[arg].name}* (${TIERS[arg].price})\n`,
        'Click below to complete payment:',
      ].join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: `💳 Pay ${TIERS[arg].price}`, url: session.url },
          ]],
        },
      });
    } catch (err) {
      replyError(msg.chat.id, err);
    }
    return;
  }

  // Show pricing
  const current = getUserTier(chatId);
  const sub = getUserSubscription(chatId);
  const lines = [
    '*Ruflo — Plans & Pricing*\n',
    '━━━━━━━━━━━━━━━━━━━━━━━\n',
  ];

  const displayTiers = ['free', 'plus', 'plusmax'];
  for (const key of displayTiers) {
    const tier = TIERS[key];
    const isCurrent = key === current || (key === 'plus' && current === 'pro') || (key === 'plusmax' && current === 'syndicate');
    const marker = isCurrent ? ' ← your plan' : '';
    const icon = key === 'free' ? '🆓' : key === 'plus' ? '⚡' : '🔱';
    lines.push(`${icon} *${tier.name}* — ${tier.price}${marker}`);
    if (key === 'free') {
      lines.push('  Basic odds comparison');
      lines.push('  3 value signals / day');
      lines.push('  1 arbitrage alert / day');
    } else if (key === 'plus') {
      lines.push('  Everything in Free, plus:');
      lines.push('  20 signals / day + arb scanner');
      lines.push('  Sharp money tracking');
      lines.push('  Steam move alerts');
      lines.push('  Kelly criterion + predictions');
    } else {
      lines.push('  Everything in Plus, plus:');
      lines.push('  Unlimited signals & arbs');
      lines.push('  Priority real-time alerts');
      lines.push('  Cross-market arbitrage');
      lines.push('  Full API access');
    }
    lines.push('');
  }
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━');

  if (sub?.status === 'active' && !sub.cancelAtPeriodEnd) {
    lines.push(`_Active subscription: ${TIERS[sub.tier]?.name || sub.tier}_`);
    lines.push('_Use /billing to manage_');
  }

  // Build upgrade buttons
  const buttons = [];
  if (current === 'free') {
    if (STRIPE_PRICES.plus && isTrialEligible(chatId)) {
      buttons.push([{ text: t('trial_button', chatId), callback_data: 'stripe:trial' }]);
    }
    if (STRIPE_PRICES.plus) buttons.push([{ text: '⚡ Upgrade to Plus — €50/mo', callback_data: 'stripe:plus' }]);
    if (STRIPE_PRICES.plusmax) buttons.push([{ text: '🔱 Upgrade to Plus Max — €300/mo', callback_data: 'stripe:plusmax' }]);
  } else if (current === 'plus' || current === 'pro') {
    if (STRIPE_PRICES.plusmax) buttons.push([{ text: '🔱 Upgrade to Plus Max — €300/mo', callback_data: 'stripe:plusmax' }]);
  }

  bot.sendMessage(msg.chat.id, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
});

// --- /trial — Start a 7-day free Plus trial ---
bot.onText(/\/trial/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = String(msg.chat.id);

  if (!stripe || !STRIPE_PRICES.plus) {
    bot.sendMessage(msg.chat.id, t('trial_unavailable', chatId), { parse_mode: 'Markdown' });
    return;
  }

  if (!isTrialEligible(chatId)) {
    const sub = getUserSubscription(chatId);
    const key = sub?.stripeSubscriptionId && (sub.status === 'active' || sub.status === 'trialing')
      ? 'trial_active_sub'
      : 'trial_already_used';
    bot.sendMessage(msg.chat.id, t(key, chatId), { parse_mode: 'Markdown' });
    return;
  }

  try {
    const session = await createCheckoutSession(chatId, 'plus', { trialDays: 7 });
    bot.sendMessage(msg.chat.id, t('trial_cta', chatId), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: t('trial_button', chatId), url: session.url },
        ]],
      },
    });
  } catch (err) {
    replyError(msg.chat.id, err);
  }
});

// --- /billing — Manage subscription ---
bot.onText(/\/billing/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = String(msg.chat.id);
  const sub = getUserSubscription(chatId);
  const current = getUserTier(chatId);
  const t = TIERS[current];

  if (!sub || sub.status === 'cancelled' || !sub.stripeSubscriptionId) {
    bot.sendMessage(msg.chat.id, [
      '*Billing*\n',
      `Current tier: *${t.name}* (${t.price})`,
      'No active subscription.',
      '',
      '_Use /subscribe to upgrade._',
    ].join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown';
  const lines = [
    '*Billing & Subscription*\n',
    `Plan: *${t.name}* (${t.price})`,
    `Status: ${sub.status === 'active' ? '✅ Active' : sub.status === 'past_due' ? '⚠️ Past due' : sub.status}`,
    `Renews: ${periodEnd}`,
  ];

  if (sub.cancelAtPeriodEnd) {
    lines.push('');
    lines.push(`⚠️ *Cancellation scheduled* — access until ${periodEnd}`);
  }

  const buttons = [];
  if (sub.cancelAtPeriodEnd) {
    buttons.push([{ text: '🔄 Reactivate subscription', callback_data: 'stripe:reactivate' }]);
  } else {
    buttons.push([{ text: '❌ Cancel subscription', callback_data: 'stripe:cancel' }]);
  }

  // Customer portal for payment method updates
  if (stripe && sub.stripeCustomerId) {
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: STRIPE_SUCCESS_URL,
      });
      buttons.push([{ text: '💳 Update payment method', url: portal.url }]);
    } catch {}
  }

  bot.sendMessage(msg.chat.id, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  });
});

// --- /tier — View or change subscription tier (Stripe-aware) ---
bot.onText(/\/tier\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const arg = (match[1] || '').trim().toLowerCase();
  const chatId = String(msg.chat.id);

  // If Stripe is active, redirect manual tier changes to /subscribe
  if (stripe && arg && ['plus', 'plusmax'].includes(arg)) {
    bot.sendMessage(msg.chat.id, `Use /subscribe ${arg} to upgrade via payment.\n\n_Tier changes require an active subscription._`, { parse_mode: 'Markdown' });
    return;
  }

  // Allow manual free downgrade
  if (arg === 'free') {
    setUserTier(chatId, 'free');
    bot.sendMessage(msg.chat.id, 'Tier set to *Free*.\n\n_If you have an active subscription, use /billing to cancel it._', { parse_mode: 'Markdown' });
    return;
  }

  // Manual tier set (only when Stripe not configured — for testing)
  if (!stripe && arg && ['plus', 'plusmax'].includes(arg)) {
    setUserTier(chatId, arg);
    const t = TIERS[arg];
    bot.sendMessage(msg.chat.id, `Tier set to *${t.name}* (${t.price})\n\nFeatures: ${t.features.join(', ')}`, { parse_mode: 'Markdown' });
    return;
  }

  // Show current tier info
  const current = getUserTier(chatId);
  const t = TIERS[current];
  const sub = getUserSubscription(chatId);
  const lines = ['*Your Subscription*\n', `Current: *${t.name}* (${t.price})\n`];

  // Only show the main tiers (not legacy aliases)
  for (const key of ['free', 'plus', 'plusmax']) {
    const tier = TIERS[key];
    const active = key === current ? ' ← current' : '';
    lines.push(`*${tier.name}* — ${tier.price}${active}`);
    lines.push(`  Signals: ${tier.maxSignals === -1 ? 'Unlimited' : tier.maxSignals} | Arbs: ${tier.maxArbs === -1 ? 'Unlimited' : tier.maxArbs}`);
    lines.push(`  Features: ${tier.features.includes('*') ? 'All' : tier.features.join(', ')}\n`);
  }

  if (sub?.status === 'active') {
    lines.push('_Use /billing to manage your subscription_');
  } else if (stripe) {
    lines.push('_Use /subscribe to upgrade_');
  } else {
    lines.push('_Use `/tier <free|plus|plusmax>` to change_');
  }
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// ============================================================
// --- /setedge <percent> — Set minimum EV threshold ---
// ============================================================
bot.onText(/\/setedge\s+(\d+(?:\.\d+)?)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const pct = parseFloat(match[1]);
  const edge = pct > 1 ? pct / 100 : pct; // accept both 2 and 0.02
  setUserSetting(String(msg.chat.id), 'minEdge', edge);
  bot.sendMessage(msg.chat.id, `Minimum EV edge set to *${(edge * 100).toFixed(1)}%*\nValue bets below this threshold will be filtered out.`, { parse_mode: 'Markdown' });
});

// --- /quiet — Set quiet hours (suppress notifications) ---
bot.onText(/\/quiet\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const arg = (match[1] || '').trim();
  const chatId = String(msg.chat.id);

  if (!arg || arg === 'status') {
    const qh = getUserQuietHours(chatId);
    if (qh) {
      bot.sendMessage(msg.chat.id, `*Quiet Hours: ON*\n🌙 ${qh.start}:00 — ${qh.end}:00\n\nNo push alerts during these hours.\n\n\`/quiet off\` to disable\n\`/quiet 23-8\` to change`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(msg.chat.id, '*Quiet Hours: OFF*\n\nSet quiet hours to pause push alerts at night:\n  `/quiet 23-8` — quiet from 23:00 to 08:00\n  `/quiet 0-7` — quiet from midnight to 07:00', { parse_mode: 'Markdown' });
    }
    return;
  }

  if (arg === 'off') {
    setUserSetting(chatId, 'quietHours', null);
    bot.sendMessage(msg.chat.id, '✅ Quiet hours disabled. You\'ll receive alerts 24/7.', { parse_mode: 'Markdown' });
    return;
  }

  const hourMatch = arg.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
  if (hourMatch) {
    const start = parseInt(hourMatch[1], 10);
    const end = parseInt(hourMatch[2], 10);
    if (start >= 0 && start <= 23 && end >= 0 && end <= 23) {
      setUserSetting(chatId, 'quietHours', { start, end });
      bot.sendMessage(msg.chat.id, `🌙 Quiet hours set: *${start}:00 — ${end}:00*\nNo push alerts during this time.`, { parse_mode: 'Markdown' });
      return;
    }
  }

  bot.sendMessage(msg.chat.id, 'Usage: `/quiet 23-8` or `/quiet off`', { parse_mode: 'Markdown' });
});

// --- /menu — Show interactive button menu ---
bot.onText(/\/menu/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  bot.sendMessage(msg.chat.id, '*What would you like to see?*\n\nTap a button below or just type what you want:', {
    parse_mode: 'Markdown',
    reply_markup: mainMenuButtons(),
  });
});

// ============================================================
// --- /signals — Unified ranked signals dashboard ---
// ============================================================
bot.onText(/\/signals\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */
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
      replyError(msg.chat.id, err);
    }
  });
});

// ============================================================
// --- /xarb — Cross-market arbitrage scanner ---
// ============================================================
bot.onText(/\/xarb\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */
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
      replyError(msg.chat.id, err);
    }
  });
});

// ============================================================
// --- /bias — Bookmaker bias report ---
// ============================================================
bot.onText(/\/bias/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
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
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */
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
      replyError(msg.chat.id, err);
    }
  });
});

// ============================================================
// --- /predict — Closing line prediction ---
// ============================================================
bot.onText(/\/predict\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */
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
      replyError(msg.chat.id, err);
    }
  });
});

// ============================================================
// --- /liquidity — Liquidity scores for upcoming events ---
// ============================================================
bot.onText(/\/liquidity\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */

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
      replyError(msg.chat.id, err);
    }
  });
});

// ============================================================
// --- BACKGROUND SCANNER (Proactive Push Engine) ---
// ============================================================
const SCANNER_FILE = stateFile('scanner_state.json');
// Scanner interval — configurable via SCANNER_INTERVAL_MIN env var.
// Default 480 min (8h) = 3 scans/day. With 5 soccer leagues = 450 API calls/month (free tier: 500/month).
const SCANNER_INTERVAL_MIN = parseInt(process.env.SCANNER_INTERVAL_MIN || '480', 10);
const SCANNER_INTERVAL_MS = SCANNER_INTERVAL_MIN * 60 * 1000;
// Scanner uses DEFAULT_SCANNER_LEAGUES (tier 1) unless subscriber overrides
const SCANNER_COOLDOWN_MS = Math.max(SCANNER_INTERVAL_MS, 30 * 60 * 1000); // don't re-alert same signal within one scan cycle

function loadScannerState() {
  try { return JSON.parse(fs.readFileSync(SCANNER_FILE, 'utf8')); } catch { return { subscribers: {}, sentSignals: {}, lastRun: null, stats: { runs: 0, arbs: 0, values: 0, steams: 0 } }; }
}
function saveScannerState(state) { atomicWriteJson(SCANNER_FILE, state); }

// Check if we already alerted this signal recently
function wasRecentlyAlerted(state, signalKey) {
  const last = state.sentSignals[signalKey];
  if (!last) return false;
  return (Date.now() - last) < SCANNER_COOLDOWN_MS;
}

function makeSignalKey(type, match, outcome) {
  return `${type}:${match}:${outcome || 'all'}`;
}

// Main scanner loop
async function runScanner() {
  /* demo-mode: proceed — fetch functions handle fallback */
  // Snapshot at start — subscriber list and rate-limiting map are read-only during this run.
  // We reload the state at the end to merge in any concurrent /scanner on|off changes.
  const state = loadScannerState();
  const subscribers = Object.entries(state.subscribers).filter(([, sub]) => sub.active);
  if (!subscribers.length) return;

  // Deltas accumulated during the run — merged into fresh state at the end.
  // sentSignals is a working copy so wasRecentlyAlerted and within-run dedupe stay correct.
  const workingSentSignals = { ...(state.sentSignals || {}) };
  const sentSignalUpdates = {}; // keys added during this run -> timestamp
  const statsDelta = { runs: 1, arbs: 0, values: 0, steams: 0 };
  const localState = { sentSignals: workingSentSignals };

  // Collect union of all leagues subscribers care about (saves API calls)
  const leaguesNeeded = new Set();
  for (const [, sub] of subscribers) {
    const subLeagues = sub.leagues || DEFAULT_SCANNER_LEAGUES;
    for (const l of subLeagues) leaguesNeeded.add(l);
  }
  const leaguesToFetch = [...leaguesNeeded];
  log.info(`[scanner] Run #${(state.stats?.runs || 0) + 1} — ${subscribers.length} subscriber(s), scanning ${leaguesToFetch.length} leagues`);

  // Fetch odds for each league (batch to save API calls)
  let allEvents = [];
  const eventLeagueMap = new Map(); // eventId -> league key
  for (const league of leaguesToFetch) {
    try {
      const events = await fetchOdds(league, 'h2h');
      for (const ev of events) eventLeagueMap.set(ev.id, league);
      allEvents = allEvents.concat(events);
    } catch (err) {
      log.warn(`[scanner] Error fetching ${league}: ${err.message}`);
    }
    // Small delay between API calls to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  if (!allEvents.length) {
    // Merge run count into fresh state even on empty fetch
    const fresh = loadScannerState();
    fresh.lastRun = new Date().toISOString();
    fresh.stats = fresh.stats || { runs: 0, arbs: 0, values: 0, steams: 0 };
    fresh.stats.runs += 1;
    saveScannerState(fresh);
    return;
  }
  log.info(`[scanner] Fetched ${allEvents.length} events across ${leaguesToFetch.length} leagues`);

  // Run detection on all events
  const movements = updateOddsCache(allEvents);
  const steamMoves = movements.filter(m => m.isSteam);

  // Record odds history for line movement tracking
  const sharpSignals = recordOddsSnapshot(allEvents);
  const rlmSignals = sharpSignals.filter(s => s.type === 'RLM');
  if (sharpSignals.length) log.info(`[scanner] Sharp signals: ${sharpSignals.length} (${rlmSignals.length} RLM)`);

  const allArbs = [];
  const allValueBets = [];

  for (const ev of allEvents) {
    const league = eventLeagueMap.get(ev.id) || 'unknown';
    const arb = findArbitrage(ev);
    if (arb) allArbs.push({ ...arb, match: `${ev.home_team} vs ${ev.away_team}`, time: ev.commence_time, league });

    const vbs = findValueBets(ev);
    for (const vb of vbs) allValueBets.push({ ...vb, match: `${ev.home_team} vs ${ev.away_team}`, time: ev.commence_time, league });
  }

  // Tag steam moves with league
  for (const sm of steamMoves) {
    const ev = allEvents.find(e => `${e.home_team} vs ${e.away_team}` === sm.event);
    sm.league = ev ? (eventLeagueMap.get(ev.id) || 'unknown') : 'unknown';
  }

  statsDelta.arbs += allArbs.length;
  statsDelta.values += allValueBets.length;
  statsDelta.steams += steamMoves.length;

  // Track signals for historical performance proof
  const trackedKeys = new Set(); // de-dupe within this run
  for (const arb of allArbs) {
    const tk = `ARB:${arb.match}`;
    if (trackedKeys.has(tk)) continue;
    trackedKeys.add(tk);
    trackSignal({ type: 'ARB', match: arb.match, league: arb.league, time: arb.time, arbProfit: arb.profit, arbOutcomes: arb.outcomes });
  }
  for (const vb of allValueBets) {
    const tk = `VALUE:${vb.match}:${vb.outcome}`;
    if (trackedKeys.has(tk)) continue;
    trackedKeys.add(tk);
    trackSignal({ type: 'VALUE', match: vb.match, league: vb.league, time: vb.time, outcome: vb.outcome, bookmaker: vb.bookmaker, odds: vb.odds, edge: vb.edge });
  }
  for (const sm of steamMoves) {
    const tk = `STEAM:${sm.event}:${sm.outcome}`;
    if (trackedKeys.has(tk)) continue;
    trackedKeys.add(tk);
    trackSignal({ type: 'STEAM', match: sm.event, league: sm.league, time: sm.time, outcome: sm.outcome, bookmaker: sm.bookmaker });
  }

  log.info(`[scanner] Found: ${allArbs.length} arbs, ${allValueBets.length} value bets, ${steamMoves.length} steam moves`);

  // Push to each subscriber
  for (const [chatId, sub] of subscribers) {
    // Skip users in quiet hours
    if (isQuietTime(chatId)) continue;

    const settings = getUserSettings(chatId);
    const tier = getUserTier(chatId);
    const tierConfig = TIERS[tier];
    const minEdge = sub.minEdge ?? settings.minEdge ?? 0.02;
    const minArbProfit = sub.minArbProfit ?? settings.minArbProfit ?? 0.5;
    const subLeagueSet = new Set(sub.leagues || DEFAULT_SCANNER_LEAGUES);
    const wantsArbs = settings.notifyArbs !== false;
    const wantsValue = settings.notifyValue !== false;
    const wantsSteam = settings.notifySteam !== false;
    let sentCount = 0;

    // --- Arb alerts ---
    if (wantsArbs && hasFeature(chatId, 'arb')) {
      const maxArbs = tierConfig.maxArbs === -1 ? 999 : tierConfig.maxArbs;
      for (const arb of allArbs) {
        if (!subLeagueSet.has(arb.league)) continue;
        if (arb.profit < minArbProfit) continue;
        const key = makeSignalKey('ARB', arb.match, 'all');
        if (wasRecentlyAlerted(localState, `${chatId}:${key}`)) continue;
        if (sentCount >= maxArbs) break;

        const outcomes = Object.entries(arb.outcomes)
          .map(([name, { price, bookmaker }]) => `  ${name}: *${price.toFixed(2)}* (${bookmaker})`)
          .join('\n');
        const time = new Date(arb.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

        const arbStr = arbStrength(arb.profit);
        bot.sendMessage(parseInt(chatId, 10), [
          `🔒 *ARB ALERT* ${arbStr}`,
          `${arb.match} — ${time}`,
          `Guaranteed profit: *${arb.profit.toFixed(2)}%*`,
          '',
          outcomes,
          '',
          `_Total implied: ${(arb.totalImplied * 100).toFixed(1)}% | Use /surebets for stakes_`,
        ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});

        { const tnow = Date.now(); workingSentSignals[`${chatId}:${key}`] = tnow; sentSignalUpdates[`${chatId}:${key}`] = tnow; }
        sentCount++;
      }
    }

    // --- Value bet alerts ---
    if (wantsValue && (hasFeature(chatId, 'basic_value') || hasFeature(chatId, 'signals'))) {
      const maxSignals = tierConfig.maxSignals === -1 ? 999 : tierConfig.maxSignals;
      const filtered = allValueBets
        .filter(vb => subLeagueSet.has(vb.league) && vb.edge >= minEdge)
        .sort((a, b) => b.edge - a.edge);

      let valueSent = 0;
      for (const vb of filtered) {
        const key = makeSignalKey('VALUE', vb.match, vb.outcome);
        if (wasRecentlyAlerted(localState, `${chatId}:${key}`)) continue;
        if (valueSent >= maxSignals) break;

        const time = new Date(vb.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const strength = signalStrength(vb.edge);
        const conf = confidenceBar(vb.trueProb * 100);
        bot.sendMessage(parseInt(chatId, 10), [
          `💎 *VALUE BET* ${strength}`,
          `${vb.match} — ${time}`,
          '',
          `  ${vb.outcome} @ *${vb.odds.toFixed(2)}* (${vb.bookmaker})`,
          `  Edge: *${(vb.edge * 100).toFixed(1)}%* | EV: +€${vb.ev}/€100`,
          `  Confidence: ${conf}`,
          '',
          `_/kelly ${(vb.trueProb * 100).toFixed(0)} ${vb.odds.toFixed(2)} for optimal stake_`,
        ].join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              // Bookmaker links row — direct links to bet on this
              formatBookmakerButtons(chatId),
              // Feedback + quick-bet row
              [
                { text: '👍', callback_data: `fb:up:${key.slice(0, 40)}` },
                { text: '👎', callback_data: `fb:down:${key.slice(0, 40)}` },
                { text: '💰 Bet this', callback_data: `fb:bet:${(vb.trueProb * 100).toFixed(0)}:${vb.odds.toFixed(2)}:${vb.match.slice(0, 30)}` },
              ],
            ],
          },
        }).catch(() => {});

        { const tnow = Date.now(); workingSentSignals[`${chatId}:${key}`] = tnow; sentSignalUpdates[`${chatId}:${key}`] = tnow; }
        valueSent++;
      }
    }

    // --- Steam move alerts ---
    if (wantsSteam && (hasFeature(chatId, 'sharp') || hasFeature(chatId, 'moves'))) {
      for (const sm of steamMoves) {
        if (!subLeagueSet.has(sm.league)) continue;
        const key = makeSignalKey('STEAM', sm.event, sm.outcome);
        if (wasRecentlyAlerted(localState, `${chatId}:${key}`)) continue;

        const arrow = sm.direction === 'UP' ? '📈' : '📉';
        bot.sendMessage(parseInt(chatId, 10), [
          `🚨 *STEAM MOVE — ${sm.bookmaker}*`,
          `${sm.event}`,
          '',
          `  ${arrow} ${sm.outcome}: ${sm.oldPrice.toFixed(2)} → *${sm.newPrice.toFixed(2)}* (${sm.direction === 'UP' ? '+' : ''}${sm.change.toFixed(2)})`,
          '',
          `_Sharp money detected. Line likely to tighten across books._`,
        ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});

        { const tnow = Date.now(); workingSentSignals[`${chatId}:${key}`] = tnow; sentSignalUpdates[`${chatId}:${key}`] = tnow; }
      }
    }
  }

  // Reload to merge in any concurrent /scanner on|off changes, then apply our deltas
  const fresh = loadScannerState();
  fresh.lastRun = new Date().toISOString();
  fresh.stats = fresh.stats || { runs: 0, arbs: 0, values: 0, steams: 0 };
  fresh.stats.runs += statsDelta.runs;
  fresh.stats.arbs += statsDelta.arbs;
  fresh.stats.values += statsDelta.values;
  fresh.stats.steams += statsDelta.steams;
  fresh.sentSignals = fresh.sentSignals || {};
  Object.assign(fresh.sentSignals, sentSignalUpdates);

  // Prune old signal keys (older than 2 hours)
  const pruneThreshold = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, ts] of Object.entries(fresh.sentSignals)) {
    if (ts < pruneThreshold) delete fresh.sentSignals[key];
  }

  saveScannerState(fresh);
}

// --- /scanner command — toggle and configure ---
bot.onText(/\/scanner\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const arg = (match[1] || '').trim().toLowerCase();
  const chatId = String(msg.chat.id);
  const state = loadScannerState();

  if (!arg || arg === 'status') {
    const sub = state.subscribers[chatId];
    if (!sub || !sub.active) {
      bot.sendMessage(msg.chat.id, [
        '*Background Scanner: OFF*',
        '',
        'The scanner checks odds every 3 min and pushes:',
        '  🔒 Arb alerts (guaranteed profit)',
        '  💎 Value bets (edge vs sharp lines)',
        '  🚨 Steam moves (sharp bookmaker line changes)',
        '',
        'Commands:',
        '  `/scanner on` — activate push alerts',
        '  `/scanner off` — deactivate',
        '  `/scanner edge 3` — set min EV to 3%',
        '  `/scanner arb 1` — set min arb to 1%',
        '  `/scanner leagues` — view/choose leagues',
        '  `/scanner stats` — scanner statistics',
      ].join('\n'), { parse_mode: 'Markdown' });
    } else {
      const settings = getUserSettings(chatId);
      bot.sendMessage(msg.chat.id, [
        '*Background Scanner: ON* ✅',
        '',
        `Min edge: ${((sub.minEdge ?? settings.minEdge ?? 0.02) * 100).toFixed(1)}%`,
        `Min arb profit: ${(sub.minArbProfit ?? settings.minArbProfit ?? 0.5).toFixed(1)}%`,
        `Leagues: ${(sub.leagues || DEFAULT_SCANNER_LEAGUES).length} active`,
        `Last scan: ${state.lastRun ? new Date(state.lastRun).toLocaleString('en-GB') : 'pending'}`,
        '',
        '  `/scanner off` — pause alerts',
        '  `/scanner edge 3` — set min EV',
        '  `/scanner arb 1` — set min arb %',
        '  `/scanner leagues` — manage leagues',
      ].join('\n'), { parse_mode: 'Markdown' });
    }
    saveScannerState(state);
    return;
  }

  if (arg === 'on') {
    if (!state.subscribers[chatId]) state.subscribers[chatId] = {};
    state.subscribers[chatId].active = true;
    saveScannerState(state);
    const leagueCount = (state.subscribers[chatId].leagues || DEFAULT_SCANNER_LEAGUES).length;
    const intervalLabel = SCANNER_INTERVAL_MIN >= 60 ? `${(SCANNER_INTERVAL_MIN / 60).toFixed(SCANNER_INTERVAL_MIN % 60 === 0 ? 0 : 1)}h` : `${SCANNER_INTERVAL_MIN} min`;
    bot.sendMessage(msg.chat.id, `✅ *Scanner activated.* You'll receive push alerts for arbs, value bets, and steam moves.\n\n_Scanning every ${intervalLabel} across ${leagueCount} leagues. Use /scanner leagues to customize._`, { parse_mode: 'Markdown' });
    return;
  }

  if (arg === 'off') {
    if (state.subscribers[chatId]) state.subscribers[chatId].active = false;
    saveScannerState(state);
    bot.sendMessage(msg.chat.id, '⏸️ Scanner paused. Use `/scanner on` to resume.', { parse_mode: 'Markdown' });
    return;
  }

  const edgeMatch = arg.match(/^edge\s+(\d+(?:\.\d+)?)$/);
  if (edgeMatch) {
    const pct = parseFloat(edgeMatch[1]);
    if (!state.subscribers[chatId]) state.subscribers[chatId] = { active: true };
    state.subscribers[chatId].minEdge = pct / 100;
    saveScannerState(state);
    bot.sendMessage(msg.chat.id, `✅ Min edge set to *${pct}%*. Only value bets above this threshold will be pushed.`, { parse_mode: 'Markdown' });
    return;
  }

  const arbMatch = arg.match(/^arb\s+(\d+(?:\.\d+)?)$/);
  if (arbMatch) {
    const pct = parseFloat(arbMatch[1]);
    if (!state.subscribers[chatId]) state.subscribers[chatId] = { active: true };
    state.subscribers[chatId].minArbProfit = pct;
    saveScannerState(state);
    bot.sendMessage(msg.chat.id, `✅ Min arb profit set to *${pct}%*. Only arbs above this threshold will be pushed.`, { parse_mode: 'Markdown' });
    return;
  }

  if (arg === 'stats') {
    bot.sendMessage(msg.chat.id, [
      '*Scanner Statistics*\n',
      `Total scans: ${state.stats.runs}`,
      `Arbs found: ${state.stats.arbs}`,
      `Value bets found: ${state.stats.values}`,
      `Steam moves: ${state.stats.steams}`,
      `Active subscribers: ${Object.values(state.subscribers).filter(s => s.active).length}`,
      `Last run: ${state.lastRun || 'never'}`,
    ].join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // /scanner leagues — show available leagues grouped by sport
  if (arg === 'leagues') {
    const sub = state.subscribers[chatId] || {};
    const activeLeagues = new Set(sub.leagues || DEFAULT_SCANNER_LEAGUES);
    const sportGroups = {};
    for (const [key, info] of Object.entries(LEAGUE_CATALOG)) {
      if (!sportGroups[info.sport]) sportGroups[info.sport] = [];
      const active = activeLeagues.has(key) ? '✅' : '⬜';
      sportGroups[info.sport].push(`  ${active} \`${key}\` — ${info.name}`);
    }
    const lines = ['*Scanner Leagues*\n', `Active: ${activeLeagues.size} / ${Object.keys(LEAGUE_CATALOG).length}\n`];
    const sportNames = { soccer: '⚽ Soccer', basketball: '🏀 Basketball', american_football: '🏈 American Football', ice_hockey: '🏒 Ice Hockey', baseball: '⚾ Baseball', tennis: '🎾 Tennis', mma: '🥊 MMA', rugby: '🏉 Rugby', cricket: '🏏 Cricket' };
    const sportOrder = Object.keys(sportNames);
    const sortedSports = Object.keys(sportGroups).sort((a, b) => {
      const ia = sportOrder.indexOf(a), ib = sportOrder.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    for (const sport of sortedSports) {
      const items = sportGroups[sport].sort((a, b) => {
        const keyA = a.match(/`([^`]+)`/)?.[1];
        const keyB = b.match(/`([^`]+)`/)?.[1];
        const infoA = LEAGUE_CATALOG[keyA];
        const infoB = LEAGUE_CATALOG[keyB];
        if (infoA && infoB) {
          if (infoA.tier !== infoB.tier) return infoA.tier - infoB.tier;
          return infoA.name.localeCompare(infoB.name);
        }
        return 0;
      });
      lines.push(`*${sportNames[sport] || sport}:*`);
      lines.push(...items);
      lines.push('');
    }
    lines.push('_Commands:_');
    lines.push('  `/scanner add soccer_epl` — add a league');
    lines.push('  `/scanner remove soccer_epl` — remove a league');
    lines.push('  `/scanner preset tier1` — top leagues only');
    lines.push('  `/scanner preset tier2` — major + mid leagues');
    lines.push('  `/scanner preset all` — everything');
    lines.push('  `/scanner preset soccer` — all soccer');
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // /scanner add <league>
  const addMatch = arg.match(/^add\s+(.+)$/);
  if (addMatch) {
    const league = addMatch[1].trim();
    if (!LEAGUE_CATALOG[league]) {
      bot.sendMessage(msg.chat.id, `League \`${league}\` not found. Use \`/scanner leagues\` to see available leagues.`, { parse_mode: 'Markdown' });
      return;
    }
    if (!state.subscribers[chatId]) state.subscribers[chatId] = { active: true };
    if (!state.subscribers[chatId].leagues) state.subscribers[chatId].leagues = [...DEFAULT_SCANNER_LEAGUES];
    if (!state.subscribers[chatId].leagues.includes(league)) {
      state.subscribers[chatId].leagues.push(league);
    }
    saveScannerState(state);
    bot.sendMessage(msg.chat.id, `✅ Added *${LEAGUE_CATALOG[league].name}* to your scanner. Now tracking ${state.subscribers[chatId].leagues.length} leagues.`, { parse_mode: 'Markdown' });
    return;
  }

  // /scanner remove <league>
  const removeMatch = arg.match(/^remove\s+(.+)$/);
  if (removeMatch) {
    const league = removeMatch[1].trim();
    if (!state.subscribers[chatId]?.leagues) {
      bot.sendMessage(msg.chat.id, 'You\'re using default leagues. Use `/scanner add` first to customize.', { parse_mode: 'Markdown' });
      return;
    }
    state.subscribers[chatId].leagues = state.subscribers[chatId].leagues.filter(l => l !== league);
    saveScannerState(state);
    const name = LEAGUE_CATALOG[league]?.name || league;
    bot.sendMessage(msg.chat.id, `✅ Removed *${name}*. Now tracking ${state.subscribers[chatId].leagues.length} leagues.`, { parse_mode: 'Markdown' });
    return;
  }

  // /scanner preset <name>
  const presetMatch = arg.match(/^preset\s+(.+)$/);
  if (presetMatch) {
    const preset = presetMatch[1].trim().toLowerCase();
    if (!state.subscribers[chatId]) state.subscribers[chatId] = { active: true };
    let leagues;
    let label;
    if (preset === 'tier1') {
      leagues = Object.entries(LEAGUE_CATALOG).filter(([, i]) => i.tier === 1).map(([k]) => k);
      label = 'Tier 1 (top leagues)';
    } else if (preset === 'tier2') {
      leagues = Object.entries(LEAGUE_CATALOG).filter(([, i]) => i.tier <= 2).map(([k]) => k);
      label = 'Tier 1 + 2 (major leagues)';
    } else if (preset === 'all') {
      leagues = Object.keys(LEAGUE_CATALOG);
      label = 'All leagues';
    } else {
      // Sport-specific preset (soccer, basketball, etc.)
      leagues = Object.entries(LEAGUE_CATALOG).filter(([, i]) => i.sport === preset).map(([k]) => k);
      if (!leagues.length) {
        bot.sendMessage(msg.chat.id, `Unknown preset \`${preset}\`. Use: tier1, tier2, all, soccer, basketball, ice\\_hockey, tennis, mma`, { parse_mode: 'Markdown' });
        return;
      }
      label = `All ${preset}`;
    }
    state.subscribers[chatId].leagues = leagues;
    saveScannerState(state);
    bot.sendMessage(msg.chat.id, `✅ Preset *${label}* applied — now tracking *${leagues.length}* leagues.\n\n_Use /scanner leagues to see details._`, { parse_mode: 'Markdown' });
    return;
  }

  bot.sendMessage(msg.chat.id, 'Unknown option. Use `/scanner on`, `/scanner off`, `/scanner edge 3`, `/scanner arb 1`, `/scanner leagues`, or `/scanner stats`.', { parse_mode: 'Markdown' });
});

// Start scanner loop
let scannerInterval = null;
function startScanner() {
  if (scannerInterval) return;
  scannerInterval = setInterval(async () => {
    try { await runScanner(); } catch (err) { log.warn(`[scanner] Error: ${err.message}`); }
  }, SCANNER_INTERVAL_MS);
  // First run after 10 seconds (let bot connect first)
  setTimeout(async () => {
    try { await runScanner(); } catch (err) { log.warn(`[scanner] First run error: ${err.message}`); }
  }, 10_000);
  const scansPerDay = (24 * 60) / SCANNER_INTERVAL_MIN;
  const estMonthly = Math.round(scansPerDay * DEFAULT_SCANNER_LEAGUES.length * 30);
  const intervalLabel = SCANNER_INTERVAL_MIN >= 60 ? `${(SCANNER_INTERVAL_MIN / 60).toFixed(SCANNER_INTERVAL_MIN % 60 === 0 ? 0 : 1)}h` : `${SCANNER_INTERVAL_MIN}min`;
  log.info(`[scanner] Background scanner started — every ${intervalLabel}, ${DEFAULT_SCANNER_LEAGUES.length} leagues, ~${estMonthly} API calls/month (free tier: 500)`);
}

if (ODDS_API_KEY && !DEMO_MODE) {
  startScanner();
} else {
  log.info('[scanner] Skipped — no API key (demo mode active)');
}

// --- Help: updated command list ---
// ============================================================
// --- NOTIFICATION PREFERENCES (button-driven) ---
// ============================================================
bot.onText(/\/prefs/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const settings = getUserSettings(msg.chat.id);
  const currentAlerts = [];
  if (settings.notifyArbs !== false) currentAlerts.push('Arbs');
  if (settings.notifyValue !== false) currentAlerts.push('Value');
  if (settings.notifySteam !== false) currentAlerts.push('Steam');
  const qh = settings.quietHours;

  const lines = [
    '*Alert Preferences*\n',
    `Current alerts: *${currentAlerts.join(', ') || 'All'}*`,
    `Min edge: *${((settings.minEdge || 0.02) * 100).toFixed(0)}%*`,
    `Quiet hours: *${qh ? `${qh.start}:00 — ${qh.end}:00` : 'OFF'}*\n`,
    '_Tap below to change:_',
  ];

  bot.sendMessage(msg.chat.id, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔒 Arbs Only', callback_data: 'pref:arbs_only' },
          { text: '💎 Value Only', callback_data: 'pref:value_only' },
          { text: '📊 All Alerts', callback_data: 'pref:all_alerts' },
        ],
        [
          { text: '2% Edge', callback_data: 'pref:minedge_2' },
          { text: '5% Edge', callback_data: 'pref:minedge_5' },
          { text: '8% Edge', callback_data: 'pref:minedge_8' },
        ],
        [
          { text: '🌙 Quiet 23-08', callback_data: 'pref:quiet_night' },
          { text: '🔔 24/7 Alerts', callback_data: 'pref:quiet_off' },
        ],
      ],
    },
  });
});

// ============================================================
// --- LEADERBOARD ---
// ============================================================
bot.onText(/\/leaderboard/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const allBankroll = loadBankroll();
  const entries = [];

  for (const [chatId, br] of Object.entries(allBankroll)) {
    if (!br.bets || !br.bets.length) continue;
    const won = br.bets.filter(b => b.result === 'win');
    const lost = br.bets.filter(b => b.result === 'loss');
    const settled = won.length + lost.length;
    if (settled === 0) continue;
    const totalStaked = [...won, ...lost].reduce((s, b) => s + b.stake, 0);
    const totalReturn = won.reduce((s, b) => s + (b.stake * b.odds), 0);
    const netProfit = totalReturn - totalStaked;
    const roi = totalStaked > 0 ? (netProfit / totalStaked * 100) : 0;
    const winRate = (won.length / settled * 100);
    const unitValue = getUnitValue(br);
    entries.push({ chatId, netProfit, roi, winRate, settled, won: won.length, unitValue });
  }

  if (!entries.length) {
    bot.sendMessage(msg.chat.id, '*Leaderboard*\n\nNo settled bets yet. Use `/bet <stake> <odds> <desc>` to start tracking.', { parse_mode: 'Markdown' });
    return;
  }

  entries.sort((a, b) => b.netProfit - a.netProfit);
  const lines = ['*Leaderboard — Top Performers*\n'];
  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < Math.min(entries.length, 10); i++) {
    const e = entries[i];
    const medal = medals[i] || `${i + 1}.`;
    const isYou = String(e.chatId) === String(msg.chat.id) ? ' ← you' : '';
    const unitsStr = formatUnits(e.netProfit, e.unitValue, { signed: true });
    lines.push(`${medal} *${e.netProfit >= 0 ? '+' : ''}€${e.netProfit.toFixed(2)}*${unitsStr} | ROI ${e.roi >= 0 ? '+' : ''}${e.roi.toFixed(1)}% | ${e.winRate.toFixed(0)}% WR (${e.settled} bets)${isYou}`);
  }

  // Your position if not in top 10
  const yourIdx = entries.findIndex(e => String(e.chatId) === String(msg.chat.id));
  if (yourIdx >= 10) {
    const e = entries[yourIdx];
    const unitsStr = formatUnits(e.netProfit, e.unitValue, { signed: true });
    lines.push(`\n${yourIdx + 1}. *${e.netProfit >= 0 ? '+' : ''}€${e.netProfit.toFixed(2)}*${unitsStr} | ROI ${e.roi >= 0 ? '+' : ''}${e.roi.toFixed(1)}% ← you`);
  }

  lines.push(`\n_${entries.length} tracked bettor(s)_`);
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
});

// ============================================================
// --- ODDS COMPARISON TABLE (visual bookmaker comparison) ---
// ============================================================
bot.onText(/\/table\s+(.+)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  /* demo-mode: proceed even without API key — fetchOdds/fetchAllSoccer handle fallback */

  const query = match[1].trim().toLowerCase();
  bot.sendMessage(msg.chat.id, 'Generating odds table...').then(async (thinking) => {
    try {
      const events = await fetchAllSoccer();
      const ev = events.find(e =>
        e.home_team.toLowerCase().includes(query) ||
        e.away_team.toLowerCase().includes(query) ||
        `${e.home_team} vs ${e.away_team}`.toLowerCase().includes(query)
      );
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});

      if (!ev) {
        bot.sendMessage(msg.chat.id, `No match found for "${query}". Try a team name.`);
        return;
      }

      const time = new Date(ev.commence_time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const lines = [`*${ev.home_team} vs ${ev.away_team}*`, `${time}\n`, '```'];

      // Build table header
      const outcomes = new Set();
      for (const bm of (ev.bookmakers || [])) {
        for (const mkt of bm.markets.filter(m => m.key === 'h2h')) {
          for (const out of mkt.outcomes) outcomes.add(out.name);
        }
      }
      const outcomeList = [...outcomes];
      const colWidth = 8;
      const nameWidth = 14;
      let header = 'Bookmaker'.padEnd(nameWidth);
      for (const o of outcomeList) header += o.slice(0, colWidth).padStart(colWidth);
      lines.push(header);
      lines.push('─'.repeat(nameWidth + colWidth * outcomeList.length));

      // Best odds tracking
      const bestOdds = {};
      for (const o of outcomeList) bestOdds[o] = 0;

      // Collect all rows
      const rows = [];
      for (const bm of (ev.bookmakers || [])) {
        const h2h = bm.markets.find(m => m.key === 'h2h');
        if (!h2h) continue;
        const oddsMap = Object.fromEntries(h2h.outcomes.map(o => [o.name, o.price]));
        for (const o of outcomeList) {
          if (oddsMap[o] && oddsMap[o] > bestOdds[o]) bestOdds[o] = oddsMap[o];
        }
        rows.push({ name: bm.title, odds: oddsMap });
      }

      // Print rows with best odds marked
      for (const row of rows) {
        let line = row.name.slice(0, nameWidth - 1).padEnd(nameWidth);
        for (const o of outcomeList) {
          const price = row.odds[o];
          if (price) {
            const isBest = price === bestOdds[o];
            const val = price.toFixed(2);
            line += (isBest ? `*${val}*` : ` ${val} `).padStart(colWidth);
          } else {
            line += '  -   '.padStart(colWidth);
          }
        }
        lines.push(line);
      }
      lines.push('```');

      // Summary
      lines.push('\n*Best odds:*');
      for (const o of outcomeList) {
        const bestBm = rows.find(r => r.odds[o] === bestOdds[o]);
        lines.push(`  ${o}: *${bestOdds[o].toFixed(2)}* (${bestBm?.name || '?'})`);
      }

      // True prob
      const pinOdds = getPinnacleOdds(ev.bookmakers || []);
      if (pinOdds) {
        const trueProbs = removeVig(Object.entries(pinOdds).map(([n, p]) => ({ name: n, price: p })));
        lines.push('\n*True probability (Pinnacle):*');
        for (const tp of trueProbs) {
          lines.push(`  ${tp.name}: *${(tp.impliedProb * 100).toFixed(1)}%*`);
        }
      }

      await sendResponse(msg.chat.id, lines.join('\n'));
    } catch (err) {
      await bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
      replyError(msg.chat.id, err);
    }
  });
});

// ============================================================
// --- NATURAL LANGUAGE BET TRACKING ---
// ============================================================
// "bet Man City ML 2.10 €50" or "50 on Arsenal at 1.90"
bot.onText(/^(?:bet|placed?|put)\s+(.+?)\s+(\d+(?:\.\d+)?)\s*[€$£]?\s*(\d+(?:\.\d+)?)/i, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const desc = match[1].trim();
  const odds = parseFloat(match[2]);
  const stake = parseFloat(match[3]);
  if (odds < 1.01 || odds > 100 || stake <= 0) return; // sanity check
  const br = getUserBankroll(msg.chat.id);
  const bet = { id: br.bets.length + 1, stake, odds, desc, date: new Date().toISOString(), result: null };
  br.bets.push(bet);
  saveUserBankroll(msg.chat.id, br);
  const potWin = (stake * odds).toFixed(2);
  bot.sendMessage(msg.chat.id, [
    `*Bet #${bet.id} recorded*\n`,
    `  ${desc}`,
    `  €${stake} @ ${odds.toFixed(2)}`,
    `  Potential return: *€${potWin}*\n`,
    `Mark result: /betwin ${bet.id} or /betloss ${bet.id}`,
  ].join('\n'), { parse_mode: 'Markdown' });
});
// Also match: "50 on Arsenal at 1.90" / "€100 on Man City 2.10"
bot.onText(/^[€$£]?(\d+(?:\.\d+)?)\s+on\s+(.+?)\s+(?:at\s+)?(\d+(?:\.\d+)?)/i, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const stake = parseFloat(match[1]);
  const desc = match[2].trim();
  const odds = parseFloat(match[3]);
  if (odds < 1.01 || odds > 100 || stake <= 0) return;
  const br = getUserBankroll(msg.chat.id);
  const bet = { id: br.bets.length + 1, stake, odds, desc, date: new Date().toISOString(), result: null };
  br.bets.push(bet);
  saveUserBankroll(msg.chat.id, br);
  const potWin = (stake * odds).toFixed(2);
  bot.sendMessage(msg.chat.id, [
    `*Bet #${bet.id} recorded*\n`,
    `  ${desc}`,
    `  €${stake} @ ${odds.toFixed(2)}`,
    `  Potential return: *€${potWin}*\n`,
    `Mark result: /betwin ${bet.id} or /betloss ${bet.id}`,
  ].join('\n'), { parse_mode: 'Markdown' });
});

// ============================================================
// --- DAILY MORNING BRIEFING (scheduled at configurable hour) ---
// ============================================================
const MORNING_HOUR = parseInt(process.env.MORNING_BRIEFING_HOUR || '9', 10);
let lastMorningBriefing = '';
setInterval(async () => {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  if (now.getHours() === MORNING_HOUR && now.getMinutes() < 2 && lastMorningBriefing !== dayKey) {
    lastMorningBriefing = dayKey;
    log.info(`[morning] Sending morning briefing to subscribers`);
    const scannerState = loadScannerState();
    const subscribers = Object.entries(scannerState.subscribers || {}).filter(([, sub]) => sub.active);
    for (const [chatId] of subscribers) {
      if (isQuietTime(chatId)) continue;
      try {
        const lines = [
          `*Good morning! Here\'s your daily briefing*\n`,
          `📅 ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}\n`,
        ];

        if (ODDS_API_KEY) {
          const events = await fetchAllSoccer();
          const today = filterByDay(events, 'today');

          // Count opportunities
          let arbCount = 0, valueCount = 0;
          for (const ev of today) {
            if (findArbitrage(ev)) arbCount++;
            valueCount += findValueBets(ev).length;
          }

          lines.push(`*Today\'s markets:* ${today.length} events`);
          if (arbCount) lines.push(`🔒 *${arbCount} arb(s)* detected`);
          if (valueCount) lines.push(`💎 *${valueCount} value bet(s)* found`);
          if (!arbCount && !valueCount) lines.push('No signals yet — I\'ll alert you when I find something.');

          // Top 3 matches
          if (today.length) {
            lines.push('\n*Key matches:*');
            for (const ev of today.slice(0, 3)) {
              const time = new Date(ev.commence_time).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit' });
              lines.push(`  ⚽ ${ev.home_team} vs ${ev.away_team} — ${time}`);
            }
          }
        }

        lines.push('\n_Reply "signals" or tap below for details_');
        await bot.sendMessage(parseInt(chatId, 10), lines.join('\n'), { parse_mode: 'Markdown', reply_markup: mainMenuButtons() });
      } catch (err) {
        log.info(`[morning] Error for ${chatId}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}, 60_000);

// NOTE: second /menu handler removed — was a duplicate of the one at the
// original interactive-menu section; both would fire on the same command.

// ============================================================
// --- LEGAL / GDPR COMMANDS ---
// ============================================================
// /terms — full Terms of Service
bot.onText(/\/terms/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const lines = [
    '*Ruflo — Terms of Service*',
    '_Version ' + LEGAL_VERSION + '_',
    '',
    '*1. Service*',
    'Ruflo is an information service providing sports betting market data, odds comparison, and analytical signals. Ruflo is *not* a bookmaker, does not accept wagers, and does not hold user funds.',
    '',
    '*2. Eligibility*',
    'You must be at least 18 years old (or the legal gambling age in your jurisdiction, whichever is higher) to use Ruflo. By using the service you confirm you meet this requirement. Sports betting is illegal in some jurisdictions — it is your responsibility to comply with local law.',
    '',
    '*3. No Guarantees*',
    'All signals, odds, predictions, arbitrage opportunities, and analytics are provided *"as is"* without warranty of any kind. Past performance does not indicate future results. Ruflo is not liable for losses resulting from your betting decisions.',
    '',
    '*4. Responsible Gambling*',
    'Gambling can be addictive. Never bet more than you can afford to lose. If you or someone you know has a gambling problem, contact BeGambleAware (www.begambleaware.org) or a local support service.',
    '',
    '*5. Subscriptions*',
    'Paid plans (Plus €50/mo, Plus Max €300/mo) are processed via Stripe and renew automatically. Cancel anytime via /billing — access continues until the end of the paid period. No refunds for partial months.',
    '',
    '*6. Data & Privacy*',
    'See /privacy. You may export your data via /export or delete your account via /delete at any time.',
    '',
    '*7. Prohibited Use*',
    'Do not use Ruflo for money laundering, fraud, or in jurisdictions where sports betting is illegal. We reserve the right to suspend accounts that violate these terms.',
    '',
    '*8. Changes*',
    'Terms may be updated. Continued use after changes constitutes acceptance.',
    '',
    '_Contact: support@ruflo.bet_',
  ];
  safeReply(msg.chat.id, lines.join('\n'));
});

// /privacy — Privacy Policy
bot.onText(/\/privacy/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const lines = [
    '*Ruflo — Privacy Policy*',
    '_Version ' + LEGAL_VERSION + '_',
    '',
    '*What we collect:*',
    '• Your Telegram user ID and first name',
    '• Language preference (auto-detected from Telegram)',
    '• Favorite sports and notification settings',
    '• Your logged bets, bankroll entries, and parlay history (only what you type)',
    '• Subscription status from Stripe (no card details stored by us)',
    '',
    '*What we do NOT collect:*',
    '• Your phone number, email (unless you give it to Stripe)',
    '• Your location or device info',
    '• Messages or content outside /commands',
    '',
    '*How we use it:*',
    'Purely to provide the bot service — deliver signals, track your bankroll, process subscriptions. We do not sell or share your data with third parties (except Stripe for payments).',
    '',
    '*Your rights (GDPR):*',
    '• /export — download everything we have about you',
    '• /delete — permanently erase your data (irreversible)',
    '• /language — change your language',
    '',
    '*Retention:*',
    'Data is kept until you delete it or 12 months after your last activity.',
    '',
    '*Security:*',
    'Data is stored on our servers with standard access controls. We use HTTPS for all external API calls (Telegram, Stripe, odds feed).',
    '',
    '_Contact: privacy@ruflo.bet_',
  ];
  safeReply(msg.chat.id, lines.join('\n'));
});

// /disclaimer — short risk disclaimer
bot.onText(/\/disclaimer/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const lines = [
    '*⚠️ Risk Disclaimer*',
    '',
    t('legal_18_plus', msg.chat.id),
    '',
    t('legal_risk', msg.chat.id),
    '',
    t('legal_nodata', msg.chat.id),
    '',
    '_Need help? BeGambleAware: www.begambleaware.org_',
  ];
  safeReply(msg.chat.id, lines.join('\n'));
});

// /settings — unified settings hub
bot.onText(/\/settings/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = msg.chat.id;
  const settings = getUserSettings(chatId);
  const tier = getUserTier(chatId);
  const lang = getUserLang(chatId);
  const flags = { en: '🇬🇧', es: '🇪🇸', de: '🇩🇪', fr: '🇫🇷', it: '🇮🇹', pt: '🇵🇹', nl: '🇳🇱', hr: '🇭🇷', pl: '🇵🇱', tr: '🇹🇷', ro: '🇷🇴', cs: '🇨🇿', sk: '🇸🇰', sv: '🇸🇪', da: '🇩🇰', no: '🇳🇴' };
  const edge = ((settings.minEdge || 0.02) * 100).toFixed(1);
  const sports = (settings.favSports || ['all']).join(', ');
  const quiet = settings.quietHours ? `${settings.quietHours.start}:00 – ${settings.quietHours.end}:00` : 'off';
  const lines = [
    t('settings_title', chatId),
    '',
    `${t('settings_language', chatId)}: ${flags[lang] || '🌍'} ${lang}`,
    `${t('settings_sports', chatId)}: ${sports}`,
    `${t('settings_edge', chatId)}: ${edge}%`,
    `${t('settings_quiet', chatId)}: ${quiet}`,
    `${t('settings_tier', chatId)}: ${TIERS[tier]?.name || tier}`,
  ];
  bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: t('settings_language', chatId), callback_data: 'settings:lang' }],
        [{ text: t('settings_sports', chatId), callback_data: 'settings:sports' }],
        [{ text: t('settings_edge', chatId), callback_data: 'settings:edge' }],
        [{ text: t('settings_quiet', chatId), callback_data: 'settings:quiet' }],
        [{ text: t('settings_tier', chatId), callback_data: 'settings:tier' }],
        [{ text: t('settings_privacy', chatId), callback_data: 'settings:privacy' }],
      ],
    },
  });
});

// /export — GDPR data export (Article 15 — must deliver the full dataset)
bot.onText(/\/export/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = msg.chat.id;
  const data = collectUserData(chatId);
  const json = JSON.stringify(data, null, 2);
  await safeReply(chatId, t('export_ready', chatId));

  // Budget per chunk: Telegram message limit minus fence overhead + part counter.
  // Use plain text (no Markdown) to avoid backtick/bracket parse failures inside the JSON payload.
  const BUDGET = 3800;
  const parts = [];
  for (let i = 0; i < json.length; i += BUDGET) parts.push(json.slice(i, i + BUDGET));
  for (let i = 0; i < parts.length; i++) {
    const header = parts.length > 1 ? `(${i + 1}/${parts.length})\n` : '';
    try { await bot.sendMessage(chatId, header + parts[i]); }
    catch (e) { log.warn('[export] send failed:', e?.message); }
  }
});

// /delete — GDPR data deletion (requires confirmation)
bot.onText(/\/delete/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, t('delete_confirm', chatId), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: t('btn_confirm_delete', chatId), callback_data: 'gdpr:delete_confirm' }],
        [{ text: t('btn_cancel', chatId), callback_data: 'gdpr:cancel' }],
      ],
    },
  });
});

// ============================================================
// --- Secondary callback handler for ToS, settings, GDPR ---
// ============================================================
// Uses its own listener so we don't touch the main callback_query handler.
// Only acts on prefixes it recognizes; everything else is ignored.
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const chatId = query.message?.chat?.id;
  if (!chatId || !query.from) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }
  if (!isAllowed(query.from.id)) {
    await bot.answerCallbackQuery(query.id, { text: 'Not authorized.' }).catch(() => {});
    return;
  }
  if (!gateRate({ chat: { id: chatId }, from: query.from })) {
    await bot.answerCallbackQuery(query.id, { text: 'Slow down.' }).catch(() => {});
    return;
  }

  // ToS acceptance flow
  if (data === 'tos:accept') {
    recordLegalAcceptance(chatId);
    await bot.answerCallbackQuery(query.id, { text: '✅' }).catch(() => {});
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    // Restart onboarding by re-emitting /start
    bot.emit('message', { chat: { id: chatId }, from: query.from, text: '/start', message_id: query.message.message_id });
    return;
  }
  if (data === 'tos:decline') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    await safeReply(chatId, t('legal_declined', chatId));
    return;
  }
  if (data === 'tos:view_terms') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    bot.emit('message', { chat: { id: chatId }, from: query.from, text: '/terms', message_id: query.message.message_id });
    return;
  }
  if (data === 'tos:view_privacy') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    bot.emit('message', { chat: { id: chatId }, from: query.from, text: '/privacy', message_id: query.message.message_id });
    return;
  }

  // GDPR delete confirmation
  if (data === 'gdpr:delete_confirm') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    deleteUserData(chatId);
    await safeReply(chatId, t('delete_done', chatId));
    return;
  }
  if (data === 'gdpr:cancel') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    return;
  }

  // Settings sub-menu routing
  if (data === 'settings:lang') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    bot.emit('message', { chat: { id: chatId }, from: query.from, text: '/language', message_id: query.message.message_id });
    return;
  }
  if (data === 'settings:sports') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    bot.emit('message', { chat: { id: chatId }, from: query.from, text: '/start', message_id: query.message.message_id });
    return;
  }
  if (data === 'settings:edge') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await safeReply(chatId, 'Set minimum edge (0.5% – 10%):\nExample: `/setedge 3` for 3% minimum edge.');
    return;
  }
  if (data === 'settings:quiet') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await safeReply(chatId, 'Set quiet hours:\nExample: `/quiet 23 8` to mute 23:00–08:00.');
    return;
  }
  if (data === 'settings:tier') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    bot.emit('message', { chat: { id: chatId }, from: query.from, text: '/subscribe', message_id: query.message.message_id });
    return;
  }
  if (data === 'settings:privacy') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await safeReply(chatId, [
      '*🔒 Privacy & Data*',
      '',
      '/privacy — full policy',
      '/terms — terms of service',
      '/export — download your data',
      '/delete — permanently erase your data',
    ].join('\n'));
    return;
  }
});

// ============================================================
// --- ADMIN DASHBOARD ---
// ============================================================
// /broadcast <message> — send a message to all active subscribers (admin-only).
bot.onText(/\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  if (!isAdmin(msg.from.id)) {
    bot.sendMessage(msg.chat.id, 'Not authorized. /broadcast is restricted to bot operators.');
    return;
  }
  const text = (match?.[1] || '').trim();
  if (!text) {
    bot.sendMessage(msg.chat.id, [
      '*📢 Broadcast*',
      '',
      'Usage: `/broadcast Your message here`',
      '',
      'Sends a message to all active subscribers.',
      'Supports Markdown formatting.',
      '',
      'Preview first: `/broadcast preview Your message`',
    ].join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // Preview mode — show the message without sending
  const isPreview = text.startsWith('preview ');
  const broadcastText = isPreview ? text.slice(8).trim() : text;
  if (!broadcastText) {
    bot.sendMessage(msg.chat.id, 'Empty message. Usage: `/broadcast Your message here`', { parse_mode: 'Markdown' });
    return;
  }

  if (isPreview) {
    await bot.sendMessage(msg.chat.id, `*📢 Preview:*\n\n${broadcastText}`, { parse_mode: 'Markdown' });
    await bot.sendMessage(msg.chat.id, '_Send without "preview" to broadcast to all subscribers._', { parse_mode: 'Markdown' });
    return;
  }

  // Gather all active subscribers
  const scannerState = loadScannerState();
  const recipients = Object.entries(scannerState.subscribers || {})
    .filter(([, sub]) => sub.active)
    .map(([id]) => id);

  if (recipients.length === 0) {
    bot.sendMessage(msg.chat.id, 'No active subscribers to broadcast to.');
    return;
  }

  // Confirm before sending
  await bot.sendMessage(msg.chat.id, `Send this to *${recipients.length}* subscriber(s)?`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: `✅ Send to ${recipients.length}`, callback_data: 'broadcast:confirm' },
          { text: '❌ Cancel', callback_data: 'broadcast:cancel' },
        ],
      ],
    },
  });

  // Store pending broadcast for confirmation callback
  pendingBroadcasts.set(msg.chat.id, { text: broadcastText, recipients, requestedAt: Date.now() });
});

const pendingBroadcasts = new Map();

// Handle signal feedback (thumbs up/down) and quick-bet from alerts
bot.on('callback_query', async (query) => {
  if (!query.data?.startsWith('fb:')) return;
  const parts = query.data.split(':');
  const action = parts[1];
  const chatId = query.message.chat.id;

  if (action === 'up') {
    bot.answerCallbackQuery(query.id, { text: '👍 Thanks! We\'ll send more like this.' });
    log.info(`[feedback] ${chatId} upvoted signal ${parts[2]}`);
    // Remove buttons after voting
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    return;
  }
  if (action === 'down') {
    bot.answerCallbackQuery(query.id, { text: '👎 Noted. We\'ll improve signal quality.' });
    log.info(`[feedback] ${chatId} downvoted signal ${parts[2]}`);
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    return;
  }
  if (action === 'bet') {
    // Quick-bet: auto-calculate Kelly stake and record the bet
    const prob = parseFloat(parts[2]);
    const odds = parseFloat(parts[3]);
    const desc = parts.slice(4).join(':') || 'Signal bet';
    const br = getUserBankroll(chatId);
    const unitValue = getUnitValue(br);

    // Kelly fraction
    const edge = (prob / 100) * odds - 1;
    const kelly = edge > 0 ? (edge / (odds - 1)) : 0;
    const startBal = Number.isFinite(br.startBalance) && br.startBalance > 0 ? br.startBalance : 100;
    const stake = Math.max(1, Math.round(startBal * kelly * 0.5)); // half-Kelly for safety

    bot.answerCallbackQuery(query.id, { text: `Recording €${stake} bet...` });
    // Record the bet
    const betId = (br.bets.length > 0 ? Math.max(...br.bets.map(b => b.id || 0)) + 1 : 1);
    br.bets.push({ id: betId, stake, odds, desc, result: null, createdAt: new Date().toISOString() });
    saveUserBankroll(chatId, br);

    const unitStr = unitValue > 0 ? ` (${(stake / unitValue).toFixed(1)}u)` : '';
    bot.sendMessage(chatId, [
      `✅ *Bet #${betId} recorded*`,
      '',
      `  €${stake}${unitStr} @ ${odds.toFixed(2)} — ${escapeMd(desc)}`,
      `  _(Half-Kelly stake based on ${prob}% edge)_`,
      '',
      `Settle later: \`/betwin ${betId}\` or \`/betloss ${betId}\``,
    ].join('\n'), { parse_mode: 'Markdown' }).catch(() => {});

    // Remove buttons
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});

    // Check for achievement milestones
    checkAchievements(chatId, br);
    log.info(`[quick-bet] ${chatId} bet #${betId} €${stake} @ ${odds} on "${desc}"`);
    return;
  }
});

// Achievement badges — milestones that fire once per user
const ACHIEVEMENTS = [
  { id: 'first_bet', check: br => br.bets.length >= 1, msg: '🏅 *First Bet!*\nYou placed your first bet. The journey begins!' },
  { id: 'ten_bets', check: br => br.bets.length >= 10, msg: '🎖️ *10 Bets!*\nYou\'ve placed 10 bets. Getting serious!' },
  { id: 'fifty_bets', check: br => br.bets.length >= 50, msg: '🏆 *50 Bets!*\nHalf century of bets. You\'re a regular!' },
  { id: 'first_win', check: br => br.bets.some(b => b.result === 'win'), msg: '✅ *First Win!*\nNothing beats that first win.' },
  { id: 'five_streak', check: br => { let s = 0; for (const b of br.bets) { if (b.result === 'win') { s++; if (s >= 5) return true; } else s = 0; } return false; }, msg: '🔥 *5-Win Streak!*\nYou\'re on fire!' },
  { id: 'ten_streak', check: br => { let s = 0; for (const b of br.bets) { if (b.result === 'win') { s++; if (s >= 10) return true; } else s = 0; } return false; }, msg: '🔥🔥 *10-Win Streak!*\nUnstoppable!' },
  { id: 'profit_100', check: br => { const w = br.bets.filter(b => b.result === 'win'); const l = br.bets.filter(b => b.result === 'loss'); const pnl = w.reduce((s, b) => s + (b.stake * b.odds - b.stake), 0) - l.reduce((s, b) => s + b.stake, 0); return pnl >= 100; }, msg: '💰 *€100 Profit!*\nYou\'ve made your first hundred in profit!' },
  { id: 'profit_1000', check: br => { const w = br.bets.filter(b => b.result === 'win'); const l = br.bets.filter(b => b.result === 'loss'); const pnl = w.reduce((s, b) => s + (b.stake * b.odds - b.stake), 0) - l.reduce((s, b) => s + b.stake, 0); return pnl >= 1000; }, msg: '💎 *€1,000 Profit!*\nSerious money. You know what you\'re doing.' },
];

function checkAchievements(chatId, br) {
  const settings = loadUserSettings();
  const key = String(chatId);
  if (!settings[key]) settings[key] = {};
  if (!settings[key].achievements) settings[key].achievements = [];
  const earned = settings[key].achievements;

  for (const a of ACHIEVEMENTS) {
    if (earned.includes(a.id)) continue;
    try {
      if (a.check(br)) {
        earned.push(a.id);
        bot.sendMessage(parseInt(chatId, 10), a.msg, { parse_mode: 'Markdown' }).catch(() => {});
      }
    } catch {}
  }
  settings[key].achievements = earned;
  saveUserSettings(settings);
}

// Handle broadcast confirmation
bot.on('callback_query', async (query) => {
  if (!query.data?.startsWith('broadcast:')) return;
  const chatId = query.message.chat.id;
  if (!isAdmin(query.from.id)) {
    bot.answerCallbackQuery(query.id, { text: 'Not authorized' });
    return;
  }

  const action = query.data.split(':')[1];
  const pending = pendingBroadcasts.get(chatId);

  if (action === 'cancel') {
    pendingBroadcasts.delete(chatId);
    bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
    bot.editMessageText('❌ Broadcast cancelled.', { chat_id: chatId, message_id: query.message.message_id });
    return;
  }

  if (action === 'confirm' && pending) {
    pendingBroadcasts.delete(chatId);
    bot.answerCallbackQuery(query.id, { text: 'Sending...' });
    bot.editMessageText(`📢 Broadcasting to ${pending.recipients.length} subscriber(s)...`, {
      chat_id: chatId,
      message_id: query.message.message_id,
    });

    let sent = 0;
    let failed = 0;
    for (const recipientId of pending.recipients) {
      try {
        await bot.sendMessage(parseInt(recipientId, 10), pending.text, { parse_mode: 'Markdown' });
        sent++;
      } catch (err) {
        failed++;
        log.warn(`[broadcast] Failed to send to ${recipientId}: ${err.message}`);
      }
      // Small delay to avoid Telegram rate limits (30 msgs/sec)
      if (sent % 25 === 0) await new Promise(r => setTimeout(r, 1000));
    }

    bot.sendMessage(chatId, `✅ Broadcast complete: *${sent}* sent, *${failed}* failed.`, { parse_mode: 'Markdown' });
    log.info(`[broadcast] Admin ${chatId} sent broadcast to ${sent}/${pending.recipients.length} subscribers`);
    return;
  }

  bot.answerCallbackQuery(query.id, { text: 'No pending broadcast' });
});

// /admin stats — live operational dashboard for bot operator.
// /admin whois <chatId> — lookup a specific user.
// /admin help — list subcommands.
// Access gated by TELEGRAM_ADMIN_USERS env (comma-separated user IDs).
bot.onText(/\/admin(?:\s+(\w+))?(?:\s+(.+))?/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  if (!isAdmin(msg.from.id)) {
    bot.sendMessage(msg.chat.id, 'Not authorized. /admin is restricted to bot operators.');
    return;
  }
  const sub = (match?.[1] || 'stats').toLowerCase();
  const arg = (match?.[2] || '').trim();

  if (sub === 'help') {
    bot.sendMessage(msg.chat.id, [
      '*Admin Commands*',
      '',
      '`/admin stats` — live dashboard (users, subs, revenue, referrals)',
      '`/admin whois <chatId>` — lookup a user',
      '`/broadcast <msg>` — send message to all subscribers',
      '`/broadcast preview <msg>` — preview before sending',
      '`/admin help` — this menu',
    ].join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  if (sub === 'whois') {
    if (!arg) { bot.sendMessage(msg.chat.id, 'Usage: `/admin whois <chatId>`', { parse_mode: 'Markdown' }); return; }
    const id = arg.replace(/\D/g, '');
    const tier = getUserTier(id);
    const userSub = getUserSubscription(id);
    const br = loadBankroll()[id] || {};
    const settings = loadUserSettings()[id] || {};
    const lang = loadUserLangs()[id] || 'en';
    const refStats = getReferralStats(id);
    const referrer = getReferrerFor(id);
    const lines = [
      `*User ${id}*`,
      '',
      `Tier: *${TIERS[tier]?.name || tier}* (${TIERS[tier]?.price || '?'})`,
      `Language: ${lang}`,
      `Last seen: ${settings.lastSeenDay || 'never'}`,
      '',
      '*Subscription:*',
      userSub ? [
        `  Status: ${userSub.status}`,
        `  Sub ID: \`${userSub.stripeSubscriptionId || '—'}\``,
        `  Renews: ${userSub.currentPeriodEnd ? new Date(userSub.currentPeriodEnd).toISOString().slice(0, 10) : '—'}`,
        `  Cancel at period end: ${userSub.cancelAtPeriodEnd ? 'yes' : 'no'}`,
        `  Trial used: ${userSub.trialUsed ? 'yes' : 'no'}`,
      ].join('\n') : '  _No subscription_',
      '',
      '*Bankroll:*',
      br.bets?.length
        ? `  ${br.bets.length} bets · start €${(br.startBalance || 0).toFixed(2)}`
        : '  _No bets_',
      '',
      '*Referrals:*',
      `  Invited by: ${referrer || '—'}`,
      `  Sent invites: ${refStats.invited} (${refStats.converted} converted)`,
    ];
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  if (sub === 'stats') {
    // Aggregate across all state files
    const tiers = loadTiers();
    const subs = loadSubscriptions();
    const bankrolls = loadBankroll();
    const referrals = loadReferrals();
    const onboarded = loadOnboarded();
    const settings = loadUserSettings();
    const legal = loadLegal();

    // All known users = union of everyone who appears in any state file
    const allUsers = new Set();
    for (const k of Object.keys(tiers)) allUsers.add(k);
    for (const k of Object.keys(subs)) if (!k.startsWith('pending:')) allUsers.add(k);
    for (const k of Object.keys(bankrolls)) allUsers.add(k);
    for (const k of Object.keys(referrals)) allUsers.add(k);
    for (const k of Object.keys(onboarded)) allUsers.add(k);
    for (const k of Object.keys(settings)) allUsers.add(k);
    const totalUsers = allUsers.size;

    // DAU / WAU from lastSeenDay
    const today = todayUtc();
    const d = new Date();
    const weekAgo = new Date(d.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let dau = 0, wau = 0;
    for (const s of Object.values(settings)) {
      if (!s?.lastSeenDay) continue;
      if (s.lastSeenDay === today) dau++;
      if (s.lastSeenDay >= weekAgo) wau++;
    }

    // Subscription breakdown
    const subCounts = { active: 0, trialing: 0, past_due: 0, cancelled: 0, other: 0 };
    const tierCounts = { free: 0, plus: 0, plusmax: 0 };
    let mrr = 0;
    for (const [chatId, s] of Object.entries(subs)) {
      if (chatId.startsWith('pending:')) continue;
      const status = s.status || 'other';
      if (subCounts[status] != null) subCounts[status]++;
      else subCounts.other++;
      if (status === 'active' || status === 'trialing') {
        const tier = s.tier || 'free';
        if (tier === 'plus' || tier === 'pro') { tierCounts.plus++; if (status === 'active') mrr += 50; }
        else if (tier === 'plusmax' || tier === 'syndicate') { tierCounts.plusmax++; if (status === 'active') mrr += 300; }
      }
    }
    // Free users = everyone else
    tierCounts.free = Math.max(0, totalUsers - tierCounts.plus - tierCounts.plusmax);

    // Referral funnel
    const refEntries = Object.values(referrals);
    const refInvited = refEntries.length;
    const refConverted = refEntries.filter(r => r.convertedAt).length;
    const refConversion = refInvited > 0 ? (refConverted / refInvited * 100) : 0;

    // Betting activity
    let usersWithBets = 0, totalBets = 0, settledBets = 0, aggregatePL = 0;
    for (const br of Object.values(bankrolls)) {
      if (!br.bets?.length) continue;
      usersWithBets++;
      totalBets += br.bets.length;
      const won = br.bets.filter(b => b.result === 'win');
      const lost = br.bets.filter(b => b.result === 'loss');
      settledBets += won.length + lost.length;
      aggregatePL += won.reduce((s, b) => s + (b.stake * b.odds - b.stake), 0) - lost.reduce((s, b) => s + b.stake, 0);
    }

    // System
    const uptimeMs = Date.now() - botStartTime;
    const uptimeDays = Math.floor(uptimeMs / (24 * 60 * 60 * 1000));
    const uptimeHours = Math.floor((uptimeMs / (60 * 60 * 1000)) % 24);
    const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

    const lines = [
      '*📊 Admin Dashboard*',
      '',
      '*Users*',
      `  Total: *${totalUsers}*`,
      `  DAU: *${dau}* · WAU: *${wau}*`,
      `  Onboarded: ${Object.keys(onboarded).length}`,
      `  Legal accepted: ${Object.keys(legal).length}`,
      '',
      '*Subscriptions*',
      `  Free: ${tierCounts.free}`,
      `  Plus: ${tierCounts.plus} · Plus Max: ${tierCounts.plusmax}`,
      `  Active: ${subCounts.active} · Trialing: ${subCounts.trialing}`,
      `  Past due: ${subCounts.past_due} · Cancelled: ${subCounts.cancelled}`,
      `  *MRR: €${mrr.toLocaleString()}*`,
      '',
      '*Referrals*',
      `  Invited: ${refInvited} · Converted: ${refConverted}`,
      `  Conversion: ${refConversion.toFixed(1)}%`,
      '',
      '*Betting activity*',
      `  Users with bets: ${usersWithBets}`,
      `  Total bets: ${totalBets} (${settledBets} settled)`,
      `  Aggregate P/L: ${aggregatePL >= 0 ? '+' : ''}€${aggregatePL.toFixed(2)}`,
      '',
      '*System*',
      `  Uptime: ${uptimeDays}d ${uptimeHours}h`,
      `  Memory: ${memMb} MB`,
      `  State dir: \`${STATE_DIR}\``,
      `  Sessions: ${activeSessions.size} active · ${claudeSessions.size} persisted`,
    ];
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  bot.sendMessage(msg.chat.id, `Unknown admin subcommand: \`${sub}\`. Try \`/admin help\`.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = msg.chat.id;
  const demo = isDemoMode() ? '\n_📋 Demo mode — showing sample data_\n' : '';
  const lines = [
    t('help_title', chatId),
    demo,
    t('help_intro', chatId) + '\n',
    t('help_opportunities', chatId),
    '  "What\'s good today?" — best signals',
    '  "Any arbs?" — arbitrage opportunities',
    '  "Value bets" — +EV vs sharp lines',
    '  "Sharp money" — where the pros are betting',
    '  "What moved?" — line movements',
    '',
    t('help_sports', chatId),
    '  /odds soccer · /odds nba · /odds nfl · /odds tennis · /odds mma',
    '',
    t('help_tracking', chatId),
    '  /bankroll · /stats · /kelly · /units · /track · /proof',
    '',
    t('help_alerts', chatId),
    '  /scanner · /alert · /briefing · /digest',
    '',
    t('help_more', chatId),
    '  /settings · /language · /bookmakers · /subscribe · /trial · /billing',
    '  /refer · /keyboard · /hidekeyboard',
    '  /terms · /privacy · /export · /delete',
    '',
    t('help_footer', chatId),
  ];
  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: mainMenuButtons() });
});

// --- /about command ---
bot.onText(/\/about/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const chatId = msg.chat.id;
  const lines = [
    t('about_title', chatId) + '\n',
    t('about_desc', chatId) + '\n',
    '  ' + t('about_value', chatId),
    '  ' + t('about_arb', chatId),
    '  ' + t('about_sharp', chatId),
    '  ' + t('about_steam', chatId) + '\n',
    t('about_builtfor', chatId) + '\n',
    t('about_how', chatId),
    t('about_step1', chatId),
    t('about_step2', chatId),
    t('about_step3', chatId),
    t('about_step4', chatId) + '\n',
    '/subscribe · /help · /settings',
  ];
  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
});

// --- /language command ---
bot.onText(/\/language\s*(.*)/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  if (!gateRate(msg)) return;
  const arg = (match[1] || '').trim().toLowerCase();
  const langMap = {
    english: 'en', en: 'en', spanish: 'es', español: 'es', es: 'es',
    german: 'de', deutsch: 'de', de: 'de', french: 'fr', français: 'fr', fr: 'fr',
    italian: 'it', italiano: 'it', it: 'it', portuguese: 'pt', português: 'pt', pt: 'pt',
    dutch: 'nl', nederlands: 'nl', nl: 'nl', croatian: 'hr', hrvatski: 'hr', hr: 'hr',
    polish: 'pl', polski: 'pl', pl: 'pl', turkish: 'tr', türkçe: 'tr', tr: 'tr',
    romanian: 'ro', română: 'ro', ro: 'ro', czech: 'cs', čeština: 'cs', cs: 'cs',
    slovak: 'sk', slovenčina: 'sk', slovensky: 'sk', sk: 'sk',
    swedish: 'sv', svenska: 'sv', sv: 'sv', danish: 'da', dansk: 'da', da: 'da',
    norwegian: 'no', norsk: 'no', no: 'no',
  };
  if (arg && langMap[arg]) {
    setUserLang(msg.chat.id, langMap[arg]);
    bot.sendMessage(msg.chat.id, t('lang_changed', msg.chat.id));
    return;
  }
  // Show language picker
  const current = getUserLang(msg.chat.id);
  const flags = { en: '🇬🇧', es: '🇪🇸', de: '🇩🇪', fr: '🇫🇷', it: '🇮🇹', pt: '🇵🇹', nl: '🇳🇱', hr: '🇭🇷', pl: '🇵🇱', tr: '🇹🇷', ro: '🇷🇴', cs: '🇨🇿', sk: '🇸🇰', sv: '🇸🇪', da: '🇩🇰', no: '🇳🇴' };
  const names = { en: 'English', es: 'Español', de: 'Deutsch', fr: 'Français', it: 'Italiano', pt: 'Português', nl: 'Nederlands', hr: 'Hrvatski', pl: 'Polski', tr: 'Türkçe', ro: 'Română', cs: 'Čeština', sk: 'Slovenčina', sv: 'Svenska', da: 'Dansk', no: 'Norsk' };
  bot.sendMessage(msg.chat.id, `Current: ${flags[current]} ${names[current]}\n\nTap to change:`, {
    reply_markup: { inline_keyboard: [
      [{ text: '🇬🇧 English', callback_data: 'lang:en' }, { text: '🇪🇸 Español', callback_data: 'lang:es' }, { text: '🇩🇪 Deutsch', callback_data: 'lang:de' }],
      [{ text: '🇫🇷 Français', callback_data: 'lang:fr' }, { text: '🇮🇹 Italiano', callback_data: 'lang:it' }, { text: '🇵🇹 Português', callback_data: 'lang:pt' }],
      [{ text: '🇳🇱 Nederlands', callback_data: 'lang:nl' }, { text: '🇭🇷 Hrvatski', callback_data: 'lang:hr' }, { text: '🇵🇱 Polski', callback_data: 'lang:pl' }],
      [{ text: '🇹🇷 Türkçe', callback_data: 'lang:tr' }, { text: '🇷🇴 Română', callback_data: 'lang:ro' }, { text: '🇨🇿 Čeština', callback_data: 'lang:cs' }],
      [{ text: '🇸🇰 Slovenčina', callback_data: 'lang:sk' }, { text: '🇸🇪 Svenska', callback_data: 'lang:sv' }, { text: '🇩🇰 Dansk', callback_data: 'lang:da' }],
      [{ text: '🇳🇴 Norsk', callback_data: 'lang:no' }],
    ]},
  });
});

// --- Crash guards ---
// Telegram API errors (user blocked bot, rate limit, bad request, etc.) must
// never crash the process. Log and continue.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  // Common benign Telegram errors we just log and swallow
  if (/ETELEGRAM|403|blocked by the user|chat not found|message is not modified/i.test(msg)) {
    log.warn('[unhandledRejection] telegram:', msg.slice(0, 200));
    return;
  }
  log.error('[unhandledRejection]', msg, reason?.stack || '');
});

process.on('uncaughtException', (err) => {
  log.error('[uncaughtException]', err?.message, err?.stack);
  // Don't exit — keep the bot alive. SIGINT/SIGTERM still work for clean shutdown.
});

// Telegram polling error handler — prevents crash on transient network failures
bot.on('polling_error', (err) => {
  const msg = err?.message || String(err);
  log.warn('[polling_error]', msg.slice(0, 200));
});

bot.on('webhook_error', (err) => {
  log.warn('[webhook_error]', err?.message || String(err));
});

bot.on('error', (err) => {
  log.warn('[bot error]', err?.message || String(err));
});

// --- Graceful shutdown ---
function shutdown(signal) {
  log.info(`\n[shutdown] Received ${signal}, shutting down gracefully...`);
  try { if (scannerInterval) clearInterval(scannerInterval); } catch {}
  try { saveSessionsToFile(); } catch (e) { log.warn('[shutdown] saveSessions:', e?.message); }
  try { bot.stopPolling(); } catch {}
  try { for (const controller of activeSessions.values()) controller.abort(); } catch {}
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
