// Feature tests for Ruflo Telegram Bot
// Tests pure logic without requiring Telegram/Stripe/Odds API connections
// Run: node tests/test-features.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(__dirname, '.test-tmp');

// --- Test infrastructure ---
let passed = 0;
let failed = 0;
let current = '';

function describe(name, fn) { current = name; console.log(`\n  ${name}`); fn(); }
function it(name, fn) {
  try { fn(); passed++; console.log(`    ✅ ${name}`); }
  catch (e) { failed++; console.log(`    ❌ ${name}\n       ${e.message}`); }
}
function assert(condition, msg) { if (!condition) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// Setup temp dir
if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ============================================================
// 1. NATURAL LANGUAGE ROUTER
// ============================================================
const NL_PATTERNS = [
  // Arbitrage
  { patterns: [/\barb/i, /\barbitrage/i, /\bsurebet/i, /\bguaranteed\s*profit/i, /\brisk.?free/i], command: '/arb', label: 'arbitrage' },
  // Value bets
  { patterns: [/\bvalue\s*bet/i, /\+ev\b/i, /\bedge/i, /\boverpriced/i, /\bpositive\s*ev/i, /\bexpected\s*value/i], command: '/value', label: 'value bets' },
  // Signals / what's good
  { patterns: [/\bsignal/i, /what.*good/i, /what.*hot/i, /any.*pick/i, /best.*bet/i, /what.*recommend/i, /anything\s*worth/i, /what.*play/i], command: '/signals', label: 'signals' },
  // Sharp / steam (before generic odds)
  { patterns: [/\bsharp/i, /\bsteam/i, /\bpinnacle/i, /\bline\s*move/i, /\bsmart\s*money/i, /where.*money\s*going/i], command: '/sharp', label: 'sharp money' },
  // Movements (before generic odds)
  { patterns: [/\bmoved?\b/i, /\bmoving/i, /\bshift/i, /odds.*chang/i, /\bchang.*odds/i], command: '/moves', label: 'movements' },
  // Live
  { patterns: [/\blive\b/i, /\bin.?play/i, /\bright\s*now\b/i, /what.*happening/i, /\bscores?\b/i], command: '/live', label: 'live' },
  // Specific sports (before generic odds)
  { patterns: [/\bnba\b/i, /\bbasketball\b/i], command: '/odds nba', label: 'NBA odds' },
  { patterns: [/\bnfl\b/i, /\bamerican\s*football\b/i], command: '/odds nfl', label: 'NFL odds' },
  { patterns: [/\bnhl\b/i, /\bhockey\b/i], command: '/odds nhl', label: 'NHL odds' },
  { patterns: [/\bmlb\b/i, /\bbaseball\b/i], command: '/odds mlb', label: 'MLB odds' },
  { patterns: [/\bufc\b/i, /\bmma\b/i, /\bfight/i], command: '/odds mma', label: 'MMA odds' },
  { patterns: [/\btennis\b/i], command: '/odds tennis', label: 'tennis odds' },
  { patterns: [/\bsoccer\b/i, /\bfootball\b/i, /\bepl\b/i, /\bpremier\s*league/i, /\bla\s*liga/i, /\bbundesliga/i, /\bserie\s*a/i, /\bchampions\s*league/i], command: '/odds soccer', label: 'soccer odds' },
  // Generic odds (after sport-specific and sharp/moves)
  { patterns: [/\bodds\b/i, /what.*odds/i, /show.*odds/i, /\bprices?\b.*\b(match|game|today)/i], command: '/odds soccer', label: 'odds' },
  // Subscribe / pricing (before bankroll)
  { patterns: [/\bsubscri/i, /\bupgrade/i, /\bpric/i, /\bplan/i, /\bbilling/i, /\bpay/i, /\bcost/i, /how\s*much.*(cost|pay|pric|charg|worth)/i], command: '/subscribe', label: 'subscribe' },
  // Bankroll / performance
  { patterns: [/\bbankroll/i, /\bbalance\b/i, /how.*doing/i, /my\s*(p&?l|profit|loss|roi|performance)/i, /how.*much.*won/i], command: '/bankroll', label: 'bankroll' },
  // Compare
  { patterns: [/\bcompare\b/i, /\bvs\b.*odds/i, /which\s*book/i], command: null, handler: 'compare', label: 'compare' },
  // Parlays
  { patterns: [/\bparlay/i, /\bacca/i, /\baccumulator/i, /\bcombo\b/i], command: '/odds soccer', label: 'parlays' },
  // Kelly
  { patterns: [/\bkelly/i, /how\s*much.*bet/i, /\bstake\s*siz/i, /\boptimal\s*stake/i], command: '/kelly', label: 'Kelly criterion' },
  // Briefing
  { patterns: [/\bbriefing/i, /\bupdate\s*me/i, /\bwhat.*miss/i, /\bcatch.*up/i, /\bsummary/i, /\boverview/i], command: '/briefing', label: 'briefing' },
  // Scanner
  { patterns: [/\bscanner/i, /\balert/i, /\bnotif/i, /\bpush/i, /turn.*on/i, /start.*alert/i], command: '/scanner', label: 'scanner' },
  // Help
  { patterns: [/\bhelp\b/i, /what\s*can\s*you/i, /\bcommand/i, /how\s*does\s*this/i, /\bfeature/i], command: '/help', label: 'help' },
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

function matchIntent(text) {
  const lower = text.toLowerCase().trim();
  if (lower.length < 3) return null;
  if (/^(hi|hey|hello|yo|sup|thanks|thx|ok|okay|cool|nice|great)\b/i.test(lower)) return null;
  for (const route of NL_PATTERNS) {
    for (const pattern of route.patterns) {
      if (pattern.test(lower)) return route;
    }
  }
  const hasToday = /\btoday\b/i.test(lower);
  const hasTomorrow = /\btomorrow\b/i.test(lower);
  const dayMod = hasToday ? ' today' : hasTomorrow ? ' tomorrow' : '';
  if (/what.*on\b|any\s*(game|match|event)/i.test(lower)) {
    return { command: `/odds soccer${dayMod}`, label: 'upcoming events' };
  }
  return null;
}

console.log('🧪 Ruflo Telegram Bot — Feature Tests\n');

describe('Natural Language Router — Betting intents', () => {
  it('matches "any arbs today?" → /arb', () => { assertEqual(matchIntent('any arbs today?')?.command, '/arb'); });
  it('matches "arbitrage opportunities" → /arb', () => { assertEqual(matchIntent('arbitrage opportunities')?.command, '/arb'); });
  it('matches "surebets for tonight" → /arb', () => { assertEqual(matchIntent('surebets for tonight')?.command, '/arb'); });
  it('matches "show me value bets" → /value', () => { assertEqual(matchIntent('show me value bets')?.command, '/value'); });
  it('matches "+EV picks" → /value', () => { assertEqual(matchIntent('+EV picks')?.command, '/value'); });
  it('matches "any edge today" → /value', () => { assertEqual(matchIntent('any edge today')?.command, '/value'); });
  it('matches "what are the odds" → /odds soccer', () => { assertEqual(matchIntent('what are the odds')?.command, '/odds soccer'); });
  it('matches "what\'s good today?" → /signals', () => { assertEqual(matchIntent("what's good today?")?.command, '/signals'); });
  it('matches "best bets right now" → /signals', () => { assertEqual(matchIntent('best bets right now')?.command, '/signals'); });
  it('matches "what do you recommend?" → /signals', () => { assertEqual(matchIntent('what do you recommend?')?.command, '/signals'); });
});

describe('Natural Language Router — Sport-specific', () => {
  it('matches "NBA tonight" → /odds nba', () => { assertEqual(matchIntent('NBA tonight')?.command, '/odds nba'); });
  it('matches "basketball games" → /odds nba', () => { assertEqual(matchIntent('basketball games')?.command, '/odds nba'); });
  it('matches "NFL week 12" → /odds nfl', () => { assertEqual(matchIntent('NFL week 12')?.command, '/odds nfl'); });
  it('matches "hockey odds" → /odds nhl', () => { assertEqual(matchIntent('hockey odds')?.command, '/odds nhl'); });
  it('matches "UFC this weekend" → /odds mma', () => { assertEqual(matchIntent('UFC this weekend')?.command, '/odds mma'); });
  it('matches "premier league" → /odds soccer', () => { assertEqual(matchIntent('premier league')?.command, '/odds soccer'); });
  it('matches "champions league" → /odds soccer', () => { assertEqual(matchIntent('champions league')?.command, '/odds soccer'); });
  it('matches "tennis picks" → /odds tennis', () => { assertEqual(matchIntent('tennis picks')?.command, '/odds tennis'); });
});

describe('Natural Language Router — Sharp / movements', () => {
  it('matches "sharp money" → /sharp', () => { assertEqual(matchIntent('sharp money')?.command, '/sharp'); });
  it('matches "where is the money going?" → /sharp', () => { assertEqual(matchIntent('where is the money going?')?.command, '/sharp'); });
  it('matches "pinnacle odds" → /sharp', () => { assertEqual(matchIntent('pinnacle odds')?.command, '/sharp'); });
  it('matches "steam moves" → /sharp', () => { assertEqual(matchIntent('steam moves')?.command, '/sharp'); });
  it('matches "what moved today?" → /moves', () => { assertEqual(matchIntent('what moved today?')?.command, '/moves'); });
  it('matches "odds changing fast" → /moves', () => { assertEqual(matchIntent('odds changing fast')?.command, '/moves'); });
});

describe('Natural Language Router — Features & tools', () => {
  it('matches "my bankroll" → /bankroll', () => { assertEqual(matchIntent('my bankroll')?.command, '/bankroll'); });
  it('matches "how am I doing?" → /bankroll', () => { assertEqual(matchIntent('how am I doing?')?.command, '/bankroll'); });
  it('matches "my P&L" → /bankroll', () => { assertEqual(matchIntent('my P&L')?.command, '/bankroll'); });
  it('matches "kelly criterion" → /kelly', () => { assertEqual(matchIntent('kelly criterion')?.command, '/kelly'); });
  it('matches "how much should I bet?" → /kelly', () => { assertEqual(matchIntent('how much should I bet?')?.command, '/kelly'); });
  it('matches "update me" → /briefing', () => { assertEqual(matchIntent('update me')?.command, '/briefing'); });
  it('matches "what did I miss?" → /briefing', () => { assertEqual(matchIntent('what did I miss?')?.command, '/briefing'); });
  it('matches "turn on alerts" → /scanner', () => { assertEqual(matchIntent('turn on alerts')?.command, '/scanner'); });
  it('matches "what can you do?" → /help', () => { assertEqual(matchIntent('what can you do?')?.command, '/help'); });
  it('matches "track record" → /track', () => { assertEqual(matchIntent('track record')?.command, '/track'); });
  it('matches "what\'s the win rate?" → /track', () => { assertEqual(matchIntent("what's the win rate?")?.command, '/track'); });
  it('matches "ROI so far" → /track', () => { assertEqual(matchIntent('ROI so far')?.command, '/track'); });
  it('matches "pricing plans" → /subscribe', () => { assertEqual(matchIntent('pricing plans')?.command, '/subscribe'); });
  it('matches "how much does it cost?" → /subscribe', () => { assertEqual(matchIntent('how much does it cost?')?.command, '/subscribe'); });
  it('matches "upgrade my plan" → /subscribe', () => { assertEqual(matchIntent('upgrade my plan')?.command, '/subscribe'); });
});

describe('Natural Language Router — Should NOT match', () => {
  it('ignores "hi"', () => { assertEqual(matchIntent('hi'), null); });
  it('ignores "hello"', () => { assertEqual(matchIntent('hello'), null); });
  it('ignores "hey"', () => { assertEqual(matchIntent('hey'), null); });
  it('ignores "ok"', () => { assertEqual(matchIntent('ok'), null); });
  it('ignores "thanks"', () => { assertEqual(matchIntent('thanks'), null); });
  it('ignores "yo"', () => { assertEqual(matchIntent('yo'), null); });
  it('ignores very short "ab"', () => { assertEqual(matchIntent('ab'), null); });
  it('ignores unrelated "fix the login bug"', () => { assertEqual(matchIntent('fix the login bug'), null); });
  it('ignores unrelated "deploy to production"', () => { assertEqual(matchIntent('deploy to production'), null); });
  it('ignores unrelated "write a function"', () => { assertEqual(matchIntent('write a function'), null); });
});

describe('Natural Language Router — Generic queries', () => {
  it('matches "any games today?" → upcoming events', () => {
    const result = matchIntent('any games today?');
    assert(result !== null, 'Should match');
    assert(result.command.includes('odds soccer'), `Should be odds, got ${result.command}`);
    assert(result.command.includes('today'), 'Should include today');
  });
  it('matches "what\'s on tomorrow?" → upcoming events', () => {
    const result = matchIntent("what's on tomorrow?");
    assert(result !== null, 'Should match');
    assert(result.command.includes('tomorrow'), 'Should include tomorrow');
  });
});

// ============================================================
// 2. QUIET HOURS
// ============================================================
describe('Quiet Hours — Logic', () => {
  function isQuietTimeAt(qh, hour) {
    if (!qh) return false;
    if (qh.start > qh.end) return hour >= qh.start || hour < qh.end;
    return hour >= qh.start && hour < qh.end;
  }

  it('null quiet hours = never quiet', () => { assertEqual(isQuietTimeAt(null, 14), false); });
  it('23-8: hour 23 is quiet', () => { assertEqual(isQuietTimeAt({ start: 23, end: 8 }, 23), true); });
  it('23-8: hour 0 is quiet', () => { assertEqual(isQuietTimeAt({ start: 23, end: 8 }, 0), true); });
  it('23-8: hour 3 is quiet', () => { assertEqual(isQuietTimeAt({ start: 23, end: 8 }, 3), true); });
  it('23-8: hour 7 is quiet', () => { assertEqual(isQuietTimeAt({ start: 23, end: 8 }, 7), true); });
  it('23-8: hour 8 is NOT quiet', () => { assertEqual(isQuietTimeAt({ start: 23, end: 8 }, 8), false); });
  it('23-8: hour 12 is NOT quiet', () => { assertEqual(isQuietTimeAt({ start: 23, end: 8 }, 12), false); });
  it('23-8: hour 22 is NOT quiet', () => { assertEqual(isQuietTimeAt({ start: 23, end: 8 }, 22), false); });
  it('9-17: hour 9 is quiet', () => { assertEqual(isQuietTimeAt({ start: 9, end: 17 }, 9), true); });
  it('9-17: hour 12 is quiet', () => { assertEqual(isQuietTimeAt({ start: 9, end: 17 }, 12), true); });
  it('9-17: hour 17 is NOT quiet', () => { assertEqual(isQuietTimeAt({ start: 9, end: 17 }, 17), false); });
  it('9-17: hour 20 is NOT quiet', () => { assertEqual(isQuietTimeAt({ start: 9, end: 17 }, 20), false); });
  it('0-6: hour 0 is quiet', () => { assertEqual(isQuietTimeAt({ start: 0, end: 6 }, 0), true); });
  it('0-6: hour 5 is quiet', () => { assertEqual(isQuietTimeAt({ start: 0, end: 6 }, 5), true); });
  it('0-6: hour 6 is NOT quiet', () => { assertEqual(isQuietTimeAt({ start: 0, end: 6 }, 6), false); });
});

// ============================================================
// 3. LEAGUE CATALOG
// ============================================================
const LEAGUE_CATALOG = {
  soccer_epl: { name: 'Premier League', sport: 'soccer', region: 'europe', tier: 1 },
  soccer_spain_la_liga: { name: 'La Liga', sport: 'soccer', region: 'europe', tier: 1 },
  soccer_germany_bundesliga: { name: 'Bundesliga', sport: 'soccer', region: 'europe', tier: 1 },
  soccer_italy_serie_a: { name: 'Serie A', sport: 'soccer', region: 'europe', tier: 1 },
  soccer_france_ligue_one: { name: 'Ligue 1', sport: 'soccer', region: 'europe', tier: 1 },
  soccer_uefa_champs_league: { name: 'Champions League', sport: 'soccer', region: 'europe', tier: 1 },
  soccer_uefa_europa_league: { name: 'Europa League', sport: 'soccer', region: 'europe', tier: 1 },
  soccer_netherlands_eredivisie: { name: 'Eredivisie', sport: 'soccer', region: 'europe', tier: 2 },
  soccer_portugal_primeira_liga: { name: 'Primeira Liga', sport: 'soccer', region: 'europe', tier: 2 },
  soccer_usa_mls: { name: 'MLS', sport: 'soccer', region: 'north_america', tier: 2 },
  soccer_brazil_campeonato: { name: 'Brasileirão', sport: 'soccer', region: 'south_america', tier: 2 },
  soccer_australia_aleague: { name: 'A-League', sport: 'soccer', region: 'oceania', tier: 3 },
  basketball_nba: { name: 'NBA', sport: 'basketball', region: 'north_america', tier: 1 },
  basketball_euroleague: { name: 'EuroLeague', sport: 'basketball', region: 'europe', tier: 2 },
  americanfootball_nfl: { name: 'NFL', sport: 'american_football', region: 'north_america', tier: 1 },
  icehockey_nhl: { name: 'NHL', sport: 'ice_hockey', region: 'north_america', tier: 1 },
  baseball_mlb: { name: 'MLB', sport: 'baseball', region: 'north_america', tier: 1 },
  mma_mixed_martial_arts: { name: 'MMA/UFC', sport: 'mma', region: 'international', tier: 1 },
  soccer_fifa_world_cup: { name: 'FIFA World Cup', sport: 'soccer', region: 'international', tier: 1 },
  soccer_uefa_european_championship: { name: 'Euro Championship', sport: 'soccer', region: 'international', tier: 1 },
  cricket_ipl: { name: 'IPL', sport: 'cricket', region: 'asia', tier: 2 },
};

const DEFAULT_SCANNER_LEAGUES = Object.entries(LEAGUE_CATALOG)
  .filter(([, info]) => info.tier === 1)
  .map(([key]) => key);

describe('League Catalog — Defaults', () => {
  it('has tier 1 defaults', () => { assert(DEFAULT_SCANNER_LEAGUES.length > 0, 'Should have defaults'); });
  it('includes EPL', () => { assert(DEFAULT_SCANNER_LEAGUES.includes('soccer_epl')); });
  it('includes NBA', () => { assert(DEFAULT_SCANNER_LEAGUES.includes('basketball_nba')); });
  it('includes NFL', () => { assert(DEFAULT_SCANNER_LEAGUES.includes('americanfootball_nfl')); });
  it('includes NHL', () => { assert(DEFAULT_SCANNER_LEAGUES.includes('icehockey_nhl')); });
  it('includes UFC', () => { assert(DEFAULT_SCANNER_LEAGUES.includes('mma_mixed_martial_arts')); });
  it('excludes tier 2 (Eredivisie)', () => { assert(!DEFAULT_SCANNER_LEAGUES.includes('soccer_netherlands_eredivisie')); });
  it('excludes tier 3 (A-League)', () => { assert(!DEFAULT_SCANNER_LEAGUES.includes('soccer_australia_aleague')); });
  it('excludes tier 2 (EuroLeague)', () => { assert(!DEFAULT_SCANNER_LEAGUES.includes('basketball_euroleague')); });
});

describe('League Catalog — Presets', () => {
  const tier2 = Object.entries(LEAGUE_CATALOG).filter(([, i]) => i.tier <= 2).map(([k]) => k);
  const allLeagues = Object.keys(LEAGUE_CATALOG);
  const soccerOnly = Object.entries(LEAGUE_CATALOG).filter(([, i]) => i.sport === 'soccer').map(([k]) => k);

  it('tier2 preset includes more than tier1', () => { assert(tier2.length > DEFAULT_SCANNER_LEAGUES.length); });
  it('tier2 includes Eredivisie', () => { assert(tier2.includes('soccer_netherlands_eredivisie')); });
  it('tier2 includes MLS', () => { assert(tier2.includes('soccer_usa_mls')); });
  it('tier2 excludes tier3 (A-League)', () => { assert(!tier2.includes('soccer_australia_aleague')); });
  it('all preset includes everything', () => { assertEqual(allLeagues.length, Object.keys(LEAGUE_CATALOG).length); });
  it('soccer preset has only soccer', () => {
    for (const key of soccerOnly) assert(LEAGUE_CATALOG[key].sport === 'soccer', `${key} should be soccer`);
  });
  it('soccer preset excludes NBA', () => { assert(!soccerOnly.includes('basketball_nba')); });
});

// ============================================================
// 4. TIER SYSTEM
// ============================================================
const TIERS = {
  free:      { name: 'Free',      price: '€0/mo',   maxSignals: 3,  maxArbs: 1,  features: ['basic_odds', 'basic_value'] },
  plus:      { name: 'Plus',      price: '€50/mo',  maxSignals: 20, maxArbs: 10, features: ['basic_odds', 'basic_value', 'arb', 'sharp', 'moves', 'consensus', 'bias', 'kelly', 'signals', 'xarb', 'predict'] },
  plusmax:   { name: 'Plus Max',  price: '€300/mo', maxSignals: -1, maxArbs: -1, features: ['*'] },
};

function hasFeature(tier, feature) {
  const t = TIERS[tier];
  return t.features.includes('*') || t.features.includes(feature);
}

describe('Tier System — Feature gating', () => {
  it('free has basic_odds', () => { assertEqual(hasFeature('free', 'basic_odds'), true); });
  it('free has basic_value', () => { assertEqual(hasFeature('free', 'basic_value'), true); });
  it('free lacks arb', () => { assertEqual(hasFeature('free', 'arb'), false); });
  it('free lacks sharp', () => { assertEqual(hasFeature('free', 'sharp'), false); });
  it('free lacks signals', () => { assertEqual(hasFeature('free', 'signals'), false); });
  it('free lacks xarb', () => { assertEqual(hasFeature('free', 'xarb'), false); });
  it('plus has arb', () => { assertEqual(hasFeature('plus', 'arb'), true); });
  it('plus has sharp', () => { assertEqual(hasFeature('plus', 'sharp'), true); });
  it('plus has signals', () => { assertEqual(hasFeature('plus', 'signals'), true); });
  it('plus has xarb', () => { assertEqual(hasFeature('plus', 'xarb'), true); });
  it('plus has kelly', () => { assertEqual(hasFeature('plus', 'kelly'), true); });
  it('plusmax has everything (wildcard)', () => { assertEqual(hasFeature('plusmax', 'arb'), true); });
  it('plusmax has made-up feature', () => { assertEqual(hasFeature('plusmax', 'anything_at_all'), true); });
  it('plusmax unlimited signals', () => { assertEqual(TIERS.plusmax.maxSignals, -1); });
  it('free limited to 3 signals', () => { assertEqual(TIERS.free.maxSignals, 3); });
  it('plus limited to 20 signals', () => { assertEqual(TIERS.plus.maxSignals, 20); });
});

// ============================================================
// 5. SIGNAL TRACKER
// ============================================================
describe('Signal Tracker — Recording', () => {
  const TRACK_FILE = path.join(TEMP_DIR, 'signal_track.json');

  function loadTrack() {
    try { return JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8')); }
    catch { return { signals: [], stats: { total: 0, settled: 0, won: 0, lost: 0, push: 0, totalStaked: 0, totalReturn: 0 } }; }
  }
  function saveTrack(data) { fs.writeFileSync(TRACK_FILE, JSON.stringify(data, null, 2)); }

  function trackSignal(signal) {
    const track = loadTrack();
    const id = `${signal.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    track.signals.push({
      id, type: signal.type, match: signal.match, league: signal.league || 'unknown',
      outcome: signal.outcome || null, bookmaker: signal.bookmaker || null,
      odds: signal.odds || null, edge: signal.edge || null,
      arbProfit: signal.arbProfit || null, commenceTime: signal.time,
      recordedAt: new Date().toISOString(), result: null, settledAt: null,
      hypotheticalStake: 10, hypotheticalReturn: null,
    });
    track.stats.total++;
    saveTrack(track);
    return id;
  }

  // Clean state
  if (fs.existsSync(TRACK_FILE)) fs.unlinkSync(TRACK_FILE);

  it('starts empty', () => {
    const track = loadTrack();
    assertEqual(track.signals.length, 0);
    assertEqual(track.stats.total, 0);
  });

  it('records a value bet signal', () => {
    const id = trackSignal({ type: 'VALUE', match: 'Arsenal vs Chelsea', league: 'soccer_epl', time: '2026-03-27T20:00:00Z', outcome: 'Arsenal', bookmaker: 'bet365', odds: 2.45, edge: 0.035 });
    assert(id.startsWith('VALUE-'), 'ID should start with type');
    const track = loadTrack();
    assertEqual(track.signals.length, 1);
    assertEqual(track.stats.total, 1);
    assertEqual(track.signals[0].match, 'Arsenal vs Chelsea');
    assertEqual(track.signals[0].odds, 2.45);
    assertEqual(track.signals[0].edge, 0.035);
    assertEqual(track.signals[0].result, null);
  });

  it('records an arb signal', () => {
    trackSignal({ type: 'ARB', match: 'Real Madrid vs Barcelona', league: 'soccer_spain_la_liga', time: '2026-03-28T21:00:00Z', arbProfit: 1.34 });
    const track = loadTrack();
    assertEqual(track.signals.length, 2);
    assertEqual(track.stats.total, 2);
    assertEqual(track.signals[1].type, 'ARB');
    assertEqual(track.signals[1].arbProfit, 1.34);
  });

  it('records a steam move signal', () => {
    trackSignal({ type: 'STEAM', match: 'Lakers vs Celtics', league: 'basketball_nba', time: '2026-03-27T01:30:00Z', outcome: 'Lakers', bookmaker: 'Pinnacle' });
    const track = loadTrack();
    assertEqual(track.signals.length, 3);
    assertEqual(track.stats.total, 3);
    assertEqual(track.signals[2].type, 'STEAM');
  });

  it('settlement updates stats correctly', () => {
    const track = loadTrack();
    // Simulate settling the value bet as a win
    const sig = track.signals[0];
    sig.result = 'win';
    sig.hypotheticalReturn = sig.hypotheticalStake * sig.odds;
    sig.settledAt = new Date().toISOString();
    track.stats.settled++;
    track.stats.won++;
    track.stats.totalStaked += sig.hypotheticalStake;
    track.stats.totalReturn += sig.hypotheticalReturn;
    saveTrack(track);

    const updated = loadTrack();
    assertEqual(updated.stats.settled, 1);
    assertEqual(updated.stats.won, 1);
    assertEqual(updated.stats.totalStaked, 10);
    assertEqual(updated.stats.totalReturn, 24.5); // 10 * 2.45
    const roi = ((updated.stats.totalReturn - updated.stats.totalStaked) / updated.stats.totalStaked * 100);
    assert(roi > 0, `ROI should be positive, got ${roi}`);
  });
});

// ============================================================
// 6. PER-USER DATA DIRECTORY
// ============================================================
describe('Per-User Data Directory', () => {
  const dataDir = path.join(TEMP_DIR, 'data');

  function ensureUserDir(chatId) {
    const userDir = path.join(dataDir, String(chatId));
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    return userDir;
  }
  function userFilePath(chatId, filename) { return path.join(ensureUserDir(chatId), filename); }
  function loadUserFile(chatId, filename, fallback = {}) {
    try { return JSON.parse(fs.readFileSync(userFilePath(chatId, filename), 'utf8')); }
    catch { return JSON.parse(JSON.stringify(fallback)); }
  }
  function saveUserFile(chatId, filename, data) {
    const fp = userFilePath(chatId, filename);
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, fp);
  }

  it('creates user directory', () => {
    const dir = ensureUserDir('12345');
    assert(fs.existsSync(dir), 'Directory should exist');
    assert(dir.includes('12345'), 'Path should contain chatId');
  });

  it('saves and loads user file', () => {
    saveUserFile('12345', 'settings.json', { minEdge: 0.03, theme: 'dark' });
    const loaded = loadUserFile('12345', 'settings.json');
    assertEqual(loaded.minEdge, 0.03);
    assertEqual(loaded.theme, 'dark');
  });

  it('returns fallback for missing file', () => {
    const loaded = loadUserFile('99999', 'nonexistent.json', { defaultVal: true });
    assertEqual(loaded.defaultVal, true);
  });

  it('isolates users from each other', () => {
    saveUserFile('111', 'prefs.json', { user: 'A' });
    saveUserFile('222', 'prefs.json', { user: 'B' });
    assertEqual(loadUserFile('111', 'prefs.json').user, 'A');
    assertEqual(loadUserFile('222', 'prefs.json').user, 'B');
  });

  it('atomic write survives (tmp + rename)', () => {
    saveUserFile('12345', 'atomic-test.json', { test: true });
    // The .tmp file should NOT exist after write
    assert(!fs.existsSync(userFilePath('12345', 'atomic-test.json') + '.tmp'), 'Temp file should be cleaned up');
    assertEqual(loadUserFile('12345', 'atomic-test.json').test, true);
  });
});

// ============================================================
// 7. SUBSCRIPTION STATE
// ============================================================
describe('Subscription State Management', () => {
  const SUB_FILE = path.join(TEMP_DIR, 'subscriptions.json');

  function loadSubs() { try { return JSON.parse(fs.readFileSync(SUB_FILE, 'utf8')); } catch { return {}; } }
  function saveSubs(data) { fs.writeFileSync(SUB_FILE, JSON.stringify(data, null, 2)); }
  function getUserSub(chatId) { return loadSubs()[String(chatId)] || null; }
  function setUserSub(chatId, sub) { const all = loadSubs(); all[String(chatId)] = sub; saveSubs(all); }

  it('returns null for unknown user', () => { assertEqual(getUserSub('999'), null); });

  it('saves subscription', () => {
    setUserSub('123', {
      stripeCustomerId: 'cus_test123',
      stripeSubscriptionId: 'sub_test123',
      tier: 'pro',
      status: 'active',
      cancelAtPeriodEnd: false,
      createdAt: '2026-03-26T12:00:00Z',
    });
    const sub = getUserSub('123');
    assertEqual(sub.tier, 'pro');
    assertEqual(sub.status, 'active');
    assertEqual(sub.stripeCustomerId, 'cus_test123');
  });

  it('updates existing subscription', () => {
    const sub = getUserSub('123');
    sub.cancelAtPeriodEnd = true;
    setUserSub('123', sub);
    assertEqual(getUserSub('123').cancelAtPeriodEnd, true);
    assertEqual(getUserSub('123').tier, 'pro'); // unchanged
  });

  it('handles cancellation flow', () => {
    const sub = getUserSub('123');
    sub.status = 'cancelled';
    sub.cancelledAt = '2026-04-26T12:00:00Z';
    setUserSub('123', sub);
    assertEqual(getUserSub('123').status, 'cancelled');
  });

  it('isolates different users', () => {
    setUserSub('456', { tier: 'syndicate', status: 'active' });
    assertEqual(getUserSub('123').status, 'cancelled');
    assertEqual(getUserSub('456').status, 'active');
  });
});

// ============================================================
// 8. SIGNAL DEDUPLICATION
// ============================================================
describe('Scanner — Signal deduplication', () => {
  const COOLDOWN = 30 * 60 * 1000;

  function makeSignalKey(type, match, outcome) { return `${type}:${match}:${outcome || 'all'}`; }
  function wasRecentlyAlerted(sentSignals, key, now = Date.now()) {
    const last = sentSignals[key];
    if (!last) return false;
    return (now - last) < COOLDOWN;
  }

  it('new signal is not recently alerted', () => {
    assertEqual(wasRecentlyAlerted({}, 'VALUE:Arsenal vs Chelsea:Arsenal'), false);
  });

  it('signal sent 5 min ago is recently alerted', () => {
    const now = Date.now();
    const sent = { 'VALUE:test:home': now - 5 * 60 * 1000 };
    assertEqual(wasRecentlyAlerted(sent, 'VALUE:test:home', now), true);
  });

  it('signal sent 31 min ago is NOT recently alerted', () => {
    const now = Date.now();
    const sent = { 'VALUE:test:home': now - 31 * 60 * 1000 };
    assertEqual(wasRecentlyAlerted(sent, 'VALUE:test:home', now), false);
  });

  it('different signal key is not alerted', () => {
    const now = Date.now();
    const sent = { 'VALUE:test:home': now };
    assertEqual(wasRecentlyAlerted(sent, 'VALUE:test:away', now), false);
  });

  it('signal keys are properly formatted', () => {
    assertEqual(makeSignalKey('ARB', 'A vs B', 'all'), 'ARB:A vs B:all');
    assertEqual(makeSignalKey('VALUE', 'X vs Y', 'X'), 'VALUE:X vs Y:X');
    assertEqual(makeSignalKey('STEAM', 'P vs Q', null), 'STEAM:P vs Q:all');
  });
});

// ============================================================
// 9. BETTING MATH
// ============================================================
describe('Betting Math — Vig removal', () => {
  function removeVig(outcomes) {
    const totalImplied = outcomes.reduce((sum, o) => sum + (1 / o.price), 0);
    return outcomes.map(o => ({
      name: o.name, price: o.price,
      impliedProb: (1 / o.price) / totalImplied,
      rawImplied: 1 / o.price,
    }));
  }

  it('probabilities sum to 1.0 after vig removal', () => {
    const result = removeVig([{ name: 'Home', price: 2.10 }, { name: 'Draw', price: 3.40 }, { name: 'Away', price: 3.50 }]);
    const sum = result.reduce((s, o) => s + o.impliedProb, 0);
    assert(Math.abs(sum - 1.0) < 0.001, `Sum should be ~1.0, got ${sum}`);
  });

  it('raw implied probabilities sum to more than 1.0 (overround)', () => {
    const result = removeVig([{ name: 'Home', price: 2.10 }, { name: 'Draw', price: 3.40 }, { name: 'Away', price: 3.50 }]);
    const rawSum = result.reduce((s, o) => s + o.rawImplied, 0);
    assert(rawSum > 1.0, `Raw sum should be >1.0 (overround), got ${rawSum}`);
  });

  it('favorite has highest probability', () => {
    const result = removeVig([{ name: 'Fav', price: 1.50 }, { name: 'Dog', price: 2.80 }]);
    assert(result[0].impliedProb > result[1].impliedProb, 'Favorite should have higher prob');
  });
});

describe('Betting Math — Arbitrage detection', () => {
  function checkArb(prices) {
    const totalImplied = prices.reduce((sum, p) => sum + (1 / p), 0);
    if (totalImplied < 1.0) return { profit: ((1 / totalImplied) - 1) * 100, totalImplied };
    return null;
  }

  it('detects arb when total implied < 1.0', () => {
    // Odds: 2.15 and 2.05 → 1/2.15 + 1/2.05 = 0.465 + 0.488 = 0.953 < 1.0
    const arb = checkArb([2.15, 2.05]);
    assert(arb !== null, 'Should detect arb');
    assert(arb.profit > 0, 'Profit should be positive');
  });

  it('no arb when total implied >= 1.0', () => {
    // Typical odds: 1.80 and 2.00 → 1/1.80 + 1/2.00 = 0.556 + 0.500 = 1.056
    const arb = checkArb([1.80, 2.00]);
    assertEqual(arb, null);
  });

  it('3-way arb detection', () => {
    // Very generous odds: 3.10, 3.50, 3.20
    const arb = checkArb([3.10, 3.50, 3.20]);
    // 1/3.10 + 1/3.50 + 1/3.20 = 0.323 + 0.286 + 0.3125 = 0.921 < 1.0
    assert(arb !== null, 'Should detect 3-way arb');
    assert(arb.profit > 5, 'Profit should be significant');
  });
});

describe('Betting Math — Kelly Criterion', () => {
  function kelly(prob, odds) {
    const q = 1 - prob;
    const b = odds - 1;
    const fraction = (prob * b - q) / b;
    return Math.max(0, fraction);
  }

  it('returns positive fraction for +EV bet', () => {
    // 55% chance at 2.0 odds → kelly = (0.55*1 - 0.45)/1 = 0.10
    const f = kelly(0.55, 2.0);
    assert(f > 0, 'Should be positive');
    assert(Math.abs(f - 0.10) < 0.01, `Expected ~0.10, got ${f}`);
  });

  it('returns 0 for -EV bet', () => {
    // 40% chance at 2.0 odds → kelly = (0.40*1 - 0.60)/1 = -0.20 → clamped to 0
    assertEqual(kelly(0.40, 2.0), 0);
  });

  it('returns 0 for fair bet', () => {
    // 50% chance at 2.0 odds → kelly = 0
    assertEqual(kelly(0.50, 2.0), 0);
  });

  it('higher edge = higher fraction', () => {
    const k1 = kelly(0.55, 2.0);
    const k2 = kelly(0.65, 2.0);
    assert(k2 > k1, 'Higher prob should mean higher Kelly fraction');
  });
});

// ============================================================
// CLEANUP & RESULTS
// ============================================================
fs.rmSync(TEMP_DIR, { recursive: true });

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'─'.repeat(50)}`);

if (failed > 0) { console.log('\n  ❌ Some tests failed!\n'); process.exit(1); }
else { console.log('\n  ✅ All tests passed!\n'); process.exit(0); }
