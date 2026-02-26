import { DateTime } from 'luxon';

const ET = 'America/New_York';

/**
 * Get the current schedule phase based on Eastern Time.
 * Returns: { phase, pollIntervalMs, alertsActive, description }
 */
export function getSchedulePhase() {
  const now = DateTime.now().setZone(ET);
  const day = now.weekday; // 1=Monday, 7=Sunday
  const mins = now.hour * 60 + now.minute;

  // Weekends
  if (day === 6 || day === 7) {
    return { phase: 'SLEEP', pollIntervalMs: 0, alertsActive: false, description: 'Weekend — market closed' };
  }

  // 4:05 PM - 8:59 AM → SLEEP
  if (mins >= 965 || mins < 540) {
    return { phase: 'SLEEP', pollIntervalMs: 0, alertsActive: false, description: 'Off hours — sleeping' };
  }

  // 9:00 AM - 9:14 AM → PRE-MARKET GEX
  if (mins >= 540 && mins < 555) {
    return { phase: 'PRE_MARKET', pollIntervalMs: 30000, alertsActive: false, description: 'Pre-market GEX collection' };
  }

  // 9:15 AM → PRE-MARKET BRIEFING (1-minute window)
  if (mins >= 555 && mins < 556) {
    return { phase: 'PRE_MARKET_BRIEFING', pollIntervalMs: 30000, alertsActive: true, description: 'Pre-market briefing' };
  }

  // 9:16 AM - 9:24 AM → PRE-MARKET continued
  if (mins >= 556 && mins < 565) {
    return { phase: 'PRE_MARKET', pollIntervalMs: 30000, alertsActive: false, description: 'Pre-market GEX collection' };
  }

  // 9:25 AM - 9:29 AM → WARM-UP
  if (mins >= 565 && mins < 570) {
    return { phase: 'WARM_UP', pollIntervalMs: 5000, alertsActive: false, description: 'Warm-up — fast polling' };
  }

  // 9:30 AM - 9:35 AM → OPEN VOLATILITY
  if (mins >= 570 && mins < 575) {
    return { phase: 'OPEN_VOLATILITY', pollIntervalMs: 5000, alertsActive: true, description: 'Market open — fast polling' };
  }

  // 9:35 AM - 3:29 PM → NORMAL TRADING
  if (mins >= 575 && mins < 930) {
    return { phase: 'NORMAL_TRADING', pollIntervalMs: 5000, alertsActive: true, description: 'Normal trading hours' };
  }

  // 3:30 PM - 3:59 PM → THETA WARNING
  if (mins >= 930 && mins < 960) {
    return { phase: 'THETA_WARNING', pollIntervalMs: 5000, alertsActive: true, description: 'Theta warning — fast polling' };
  }

  // 4:00 PM - 4:01 PM → MARKET CLOSE
  if (mins >= 960 && mins < 961) {
    return { phase: 'MARKET_CLOSE', pollIntervalMs: 0, alertsActive: false, description: 'Market closed' };
  }

  // 4:01 PM - 4:04 PM → EOD RECAP window
  if (mins >= 961 && mins < 965) {
    return { phase: 'EOD_RECAP', pollIntervalMs: 0, alertsActive: true, description: 'End of day recap' };
  }

  return { phase: 'SLEEP', pollIntervalMs: 0, alertsActive: false, description: 'Off hours' };
}

/**
 * Check if we're in any active market phase (should be polling).
 */
export function isMarketActive() {
  const { phase } = getSchedulePhase();
  return !['SLEEP', 'MARKET_CLOSE'].includes(phase);
}

/**
 * Check if it's time for the opening summary (9:15 AM ET window).
 */
export function isOpeningSummaryTime() {
  const { phase } = getSchedulePhase();
  return phase === 'PRE_MARKET_BRIEFING';
}

/**
 * Check if it's time for the EOD recap (4:01 PM ET window).
 */
export function isEodRecapTime() {
  const { phase } = getSchedulePhase();
  return phase === 'EOD_RECAP';
}

/**
 * Get a human-readable current time in ET.
 */
export function nowET() {
  return DateTime.now().setZone(ET);
}

export function formatET(dt) {
  return dt.toFormat('yyyy-MM-dd HH:mm:ss');
}

/**
 * Check if we're in power hour (3:30 - 4:00 PM ET on weekdays).
 */
export function isPowerHour() {
  const now = DateTime.now().setZone(ET);
  const day = now.weekday;
  if (day === 6 || day === 7) return false;
  const mins = now.hour * 60 + now.minute;
  return mins >= 930 && mins < 960;
}

/**
 * Check if this week contains the third Friday of the month (standard monthly OPEX).
 */
export function isOpexWeek() {
  const now = DateTime.now().setZone(ET);
  const thirdFriday = getThirdFriday(now.year, now.month);
  return now.weekNumber === thirdFriday.weekNumber && now.weekYear === thirdFriday.weekYear;
}

/**
 * Check if today IS the third Friday of the current month (OPEX day).
 */
export function isOpexDay() {
  const now = DateTime.now().setZone(ET);
  const thirdFriday = getThirdFriday(now.year, now.month);
  return now.year === thirdFriday.year && now.month === thirdFriday.month && now.day === thirdFriday.day;
}

/**
 * Get the third Friday of a given year/month.
 */
function getThirdFriday(year, month) {
  let dt = DateTime.fromObject({ year, month, day: 1 }, { zone: ET });
  // Find the first Friday (weekday 5 in Luxon ISO)
  while (dt.weekday !== 5) {
    dt = dt.plus({ days: 1 });
  }
  // Add 14 days to get the third Friday
  return dt.plus({ days: 14 });
}
