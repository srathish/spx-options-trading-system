// Heatseeker API
export const HEATSEEKER_BASE = 'https://app.skylit.ai';
// Old endpoint (deprecated): /api/data?symbol=X
// New endpoint: /api/stream?symbol=X&token=JWT&max_strikes=200&max_expirations=1
export const DATA_API = (symbol, token) =>
  `${HEATSEEKER_BASE}/api/stream?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}&max_strikes=200&max_expirations=1`;

// GEX scoring thresholds (per-expiration values, NOT aggregated)
export const WALL_MIN_INDIVIDUAL = 500_000;   // $500K for individual stocks
export const WALL_MIN_INDEX = 500_000;         // $500K for SPX (0DTE single-expiration values)
export const WALL_MIN_QQQ = 100_000;           // $100K for QQQ (smaller 0DTE GEX values)
export const INDEX_SYMBOLS = ['SPXW', 'SPX', 'SPY', 'QQQ', 'IWM', 'NDX'];
export const TRINITY_TICKERS = ['SPXW', 'SPY', 'QQQ'];

// Scoring weights
export const SCORE = {
  NEGATIVE_GEX_AT_SPOT: 30,
  LARGE_WALL_TARGET: 25,
  UNOBSTRUCTED_EXPANSION: 25,
  FLOOR_OR_CEILING: 25,
  OPEN_AIR: 20,
  CONFLICTING_WALL_PENALTY: -20,
};

// Confidence tiers
export const CONFIDENCE = {
  HIGH: 80,
  MEDIUM: 60,
};

// Minimum score to label a direction (below this → NEUTRAL)
export const NEUTRAL_THRESHOLD = 35;

// Momentum scoring — price trend over recent reads
export const MOMENTUM = {
  LOOKBACK: 60,              // number of spot reads to track (~5 min at 5s cycles)
  STRONG_MOVE_PTS: 15,       // $15+ move in lookback window = strong momentum
  MODERATE_MOVE_PTS: 8,      // $8+ move = moderate momentum
  STRONG_BONUS: 25,          // +25 to aligned direction for strong momentum
  MODERATE_BONUS: 15,        // +15 for moderate momentum
  CONTRARY_PENALTY: -20,     // -20 from the direction fighting momentum
  // Drift detection — catches slow grinds that evade the 5-min window
  DRIFT_LOOKBACK: 180,       // 180 reads ≈ 15 min at 5s cycles
  DRIFT_MODERATE_PTS: 6,     // $6+ cumulative drift = MODERATE momentum
  DRIFT_STRONG_PTS: 12,      // $12+ cumulative drift = STRONG momentum
};

// Live monitoring
export const WALL_GROWTH_ALERT_PCT = 0.20;    // 20% growth triggers alert
export const WALL_SHRINK_ALERT_PCT = 0.30;    // 30% shrinkage triggers alert
export const PRICE_PROXIMITY_STRIKES = 1;     // within 1 strike of target

// Alert cooldowns
export const ALERT_DEDUP_MINUTES = 15;
export const FULL_ANALYSIS_COOLDOWN_MS = 15 * 60 * 1000;
export const HEALTH_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

// Multi-ticker analysis thresholds
export const MULTI_TICKER = {
  STAGGER_MS: 50,               // ms between API requests
  KING_NODE_PROXIMITY_PCT: 0.15, // within 0.15% of spot (~10pts) = "at king node"
  STACKED_MIN_STRIKES: 3,       // min consecutive same-sign strikes for "stacked"
  STACKED_MIN_VALUE: 0.05,      // each strike must be ≥5% of largest wall
  NODE_SLIDE_GROWTH_PCT: 1.0,   // 100% growth = "node slide"
  RUG_MAX_STRIKE_GAP: 4,        // neg wall within 4 strikes ($20) of pos wall = rug
  ALIGNMENT_BONUS: { 0: 0, 1: 5, 2: 10, 3: 15 },
  DRIVER_BONUS: 5,              // extra +5 when driver aligns with SPX direction
};

// Strike step sizes per ticker (for proximity calculations)
export const STRIKE_STEPS = { SPXW: 5, SPY: 1, QQQ: 1 };

// Gatekeeper / Wall classification
export const GATEKEEPER = {
  MIN_SIZE_PCT: 0.30,          // wall must be >=30% of largest wall to be gatekeeper
  PROXIMITY_PCT: 0.5,          // within 0.5% of spot = "at gatekeeper"
  CONSECUTIVE_MIN: 2,          // 2+ consecutive same-sign = gatekeeper zone
};

// Midpoint detection
export const MIDPOINT = {
  DANGER_ZONE_PCT: 0.15,       // within 0.15% of midpoint = danger zone
};

// Node touch tracking
export const NODE_TOUCH = {
  PROXIMITY_PCT: 0.10,         // within 0.10% = "touching" the node
  BREAK_CONFIRMATION_PCT: 0.15, // must move 0.15% past node to confirm break
};

// Rolling walls
export const ROLLING_WALL = {
  MIN_SHIFT_STRIKES: 1,        // wall must shift >=1 strike to count
  MIN_SIZE_PCT: 0.20,          // wall must be >=20% of largest to track
};

// Map reshuffle
export const RESHUFFLE = {
  MIN_NEW_WALLS: 2,            // 2+ new walls in one read = reshuffle
  MIN_DISAPPEARED: 2,          // 2+ walls gone in one read = reshuffle
  COMBINED_MIN: 3,             // OR 3+ total changes (new + gone)
};

// Air pocket quality
export const AIR_POCKET = {
  MIN_STRIKES: 3,              // at least 3 empty strikes to qualify
  QUALITY_HIGH_STRIKES: 6,     // 6+ empty = high quality
  NOISE_PCT: 0.05,             // values < 5% of target wall = noise (empty)
};

// Power hour
export const POWER_HOUR = {
  START_MINS: 930,             // 3:30 PM ET = 15*60+30
  END_MINS: 960,               // 4:00 PM ET
};

// OPEX
export const OPEX = {
  WEEK_MAGNIFICATION: 1.25,    // walls 25% more powerful during OPEX week
  DAY_MAGNIFICATION: 1.50,     // walls 50% more powerful on OPEX day
};

// Hedge node detection
export const HEDGE_NODE = {
  ALL_EXP_RATIO: 3.0,          // allExp/0DTE ratio >=3.0 = hedge node
  MIN_SIZE_PCT: 0.15,          // must be >=15% of largest wall
};

// VEX (Vanna Exposure)
export const VEX = {
  CONFLUENCE_RADIUS_PCT: 0.3,  // VEX within 0.3% of GEX wall = confluence
  MIN_RATIO: 0.20,             // VEX must be >=20% of GEX at same strike
  STRONG_RATIO: 0.50,          // VEX >=50% of GEX = strong vanna pressure
};

// Discord rate limiting
export const MAX_MSG_LEN = 1900;
