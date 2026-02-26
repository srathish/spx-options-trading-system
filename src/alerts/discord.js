/**
 * Discord Webhook Integration for GexClaw SPX GEX Scanner.
 * Sends formatted embeds and text alerts to Discord.
 */

import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { formatDollar } from '../gex/gex-parser.js';
import { nowET, formatET } from '../utils/market-hours.js';

const log = createLogger('Discord');

/**
 * Send a raw message to the Discord webhook with rate-limit retry.
 */
async function sendWebhook(payload) {
  if (!config.discordWebhookUrl) {
    log.warn('No Discord webhook URL configured');
    return false;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = typeof payload === 'string' ? { content: payload } : payload;

      const resp = await fetch(config.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (resp.status === 204 || resp.status === 200) return true;

      if (resp.status === 429) {
        const data = await resp.json();
        const retryAfter = (data.retry_after || 2) * 1000;
        log.warn(`Rate limited, waiting ${retryAfter}ms (attempt ${attempt + 1})`);
        await sleep(retryAfter);
        continue;
      }

      log.error(`Webhook returned ${resp.status}`);
      return false;
    } catch (err) {
      log.error(`Webhook error (attempt ${attempt + 1}):`, err.message);
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Send a Discord embed.
 */
async function sendEmbed(embed) {
  return sendWebhook({ embeds: [embed] });
}

// Color constants
const COLORS = {
  BULLISH: 0x00D26A,
  BEARISH: 0xE94560,
  CHOP: 0xFBBF24,
  WARNING: 0xFBBF24,
  SYSTEM: 0x6B7280,
  INFO: 0x3B82F6,
};

/**
 * Get strike suggestion based on GEX walls.
 */
function getStrikeSuggestion(result) {
  const { direction, spotPrice, targetWall, floorWall } = result;
  if (direction === 'CHOP') return null;

  const atm = Math.round(spotPrice / 5) * 5;

  if (direction === 'BULLISH') {
    const entry = floorWall ? `near $${floorWall.strike} floor` : `at $${spotPrice.toFixed(0)}`;
    const target = targetWall ? `$${targetWall.strike}` : 'open upside';
    const stop = floorWall ? `below $${floorWall.strike}` : 'below support';
    return [
      `Entry: Buy 0DTE calls ${entry}`,
      `Strike: $${atm} ATM or $${atm + 5} OTM`,
      `Target: ${target} | Stop: ${stop}`,
    ];
  }

  if (direction === 'BEARISH') {
    const ceiling = floorWall;
    const entry = ceiling ? `near $${ceiling.strike} ceiling` : `at $${spotPrice.toFixed(0)}`;
    const target = targetWall ? `$${targetWall.strike}` : 'open downside';
    const stop = ceiling ? `above $${ceiling.strike}` : 'above resistance';
    return [
      `Entry: Buy 0DTE puts ${entry}`,
      `Strike: $${atm} ATM or $${atm - 5} OTM`,
      `Target: ${target} | Stop: ${stop}`,
    ];
  }

  return null;
}

/**
 * Send the full SPX GEX analysis to Discord (3-part embed).
 */
export async function sendSpxAnalysis(result) {
  const now = formatET(nowET());

  const dirColor = result.direction === 'BULLISH' ? COLORS.BULLISH
    : result.direction === 'BEARISH' ? COLORS.BEARISH
    : COLORS.CHOP;

  const confEmoji = result.confidence === 'HIGH' ? '\u2705'
    : result.confidence === 'MEDIUM' ? '\u26A0\uFE0F'
    : '\u26D4';

  // Walls above
  let wallsAboveStr = '';
  if (result.wallsAbove.length > 0) {
    wallsAboveStr = result.wallsAbove.slice(0, 4).map(w => {
      const tag = w.type === 'positive' ? 'SUPPORT' : 'MAGNET';
      return `${w.strike} ${formatDollar(w.gexValue).padEnd(10)} ${tag} (${w.distancePct.toFixed(1)}% away)`;
    }).join('\n');
  } else {
    wallsAboveStr = 'No significant walls above';
  }

  // Walls below
  let wallsBelowStr = '';
  if (result.wallsBelow.length > 0) {
    wallsBelowStr = result.wallsBelow.slice(0, 4).map(w => {
      const tag = w.type === 'positive' ? 'FLOOR' : 'MAGNET';
      return `${w.strike} ${formatDollar(w.gexValue).padEnd(10)} ${tag} (${w.distancePct.toFixed(1)}% away)`;
    }).join('\n');
  } else {
    wallsBelowStr = 'No significant walls below';
  }

  // Score breakdown
  const breakdownStr = result.breakdown.join('\n');

  // Strike suggestion
  const suggestion = getStrikeSuggestion(result);
  const tradeIdeaStr = suggestion ? `\`\`\`\nTRADE IDEA:\n${suggestion.map(l => `  ${l}`).join('\n')}\n\`\`\`` : '';

  const embed = {
    title: `\uD83D\uDCC8 SPX GEX ENVIRONMENT`,
    description: `**${result.direction}** | Score: **${result.score}/100** | ${confEmoji} ${result.confidence} confidence`,
    color: dirColor,
    fields: [
      {
        name: 'Market Data',
        value: `\`\`\`\nSpot Price:    $${result.spotPrice.toFixed(2)}\nGEX at Spot:   ${formatDollar(result.gexAtSpot)}\nEnvironment:   ${result.environment}\n               ${result.envDetail}\n\`\`\``,
        inline: false,
      },
      {
        name: 'Walls Above Spot',
        value: `\`\`\`\n${wallsAboveStr}\n\`\`\``,
        inline: true,
      },
      {
        name: 'Walls Below Spot',
        value: `\`\`\`\n${wallsBelowStr}\n\`\`\``,
        inline: true,
      },
      {
        name: 'Score Breakdown',
        value: `\`\`\`\n${breakdownStr}\n\`\`\``,
        inline: false,
      },
      {
        name: 'Levels',
        value: `**Target:** ${result.targetWall ? `$${result.targetWall.strike} (${formatDollar(result.targetWall.gexValue)})` : 'Open (expansion)'}\n**Floor:** ${result.floorWall ? `$${result.floorWall.strike} (${formatDollar(result.floorWall.gexValue)})` : 'None'}\n**Distance:** ${result.distanceToTarget}`,
        inline: false,
      },
    ],
    footer: { text: `GexClaw | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  if (tradeIdeaStr) {
    embed.fields.push({ name: 'Trade Idea', value: tradeIdeaStr, inline: false });
  }

  embed.fields.push({
    name: 'Recommendation',
    value: `> **${result.recommendation}**`,
    inline: false,
  });

  await sendEmbed(embed);
  log.info('Full SPX analysis sent to Discord');
  return true;
}

/**
 * Send the opening summary at 9:15 AM.
 */
export async function sendOpeningSummary(result) {
  const now = formatET(nowET());

  const embed = {
    title: '\uD83C\uDF05 MARKET OPEN SUMMARY',
    description: `**SPX ${result.direction} ${result.score}/100** | $${result.spotPrice.toFixed(2)} | ${result.environment}`,
    color: result.direction === 'BULLISH' ? COLORS.BULLISH
      : result.direction === 'BEARISH' ? COLORS.BEARISH
      : COLORS.CHOP,
    fields: [
      {
        name: 'Key Levels',
        value: `Floor: ${result.floorWall ? `$${result.floorWall.strike}` : 'None'} | Target: ${result.targetWall ? `$${result.targetWall.strike}` : 'Open'}`,
        inline: false,
      },
      {
        name: 'Recommendation',
        value: result.recommendation,
        inline: false,
      },
    ],
    footer: { text: `GexClaw | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  await sendEmbed(embed);
  log.info('Opening summary sent to Discord');
}

/**
 * Send a live monitoring alert to Discord.
 */
export async function sendLiveAlert(alertType, details) {
  const colorMap = {
    WALL_GROWTH: COLORS.BULLISH,
    WALL_SHRINK: COLORS.BEARISH,
    PRICE_NEAR_TARGET: COLORS.WARNING,
    NEW_WALL: COLORS.INFO,
    ENVIRONMENT_CHANGE: COLORS.WARNING,
    DIRECTION_CHANGE: COLORS.WARNING,
  };

  const emojiMap = {
    WALL_GROWTH: '\u2B06\uFE0F',
    WALL_SHRINK: '\u2B07\uFE0F',
    PRICE_NEAR_TARGET: '\uD83C\uDFAF',
    NEW_WALL: '\uD83C\uDD95',
    ENVIRONMENT_CHANGE: '\uD83D\uDEA8',
    DIRECTION_CHANGE: '\uD83D\uDD04',
  };

  const embed = {
    title: `${emojiMap[alertType] || '\uD83D\uDD14'} SPX GEX ALERT — ${alertType.replace(/_/g, ' ')}`,
    description: details,
    color: colorMap[alertType] || COLORS.SYSTEM,
    footer: { text: `GexClaw | ${formatET(nowET())} ET` },
    timestamp: new Date().toISOString(),
  };

  await sendEmbed(embed);
  log.info(`Live alert sent: ${alertType}`);
}

/**
 * Send EOD recap to Discord.
 */
export async function sendEodRecap(predictions) {
  const checked = predictions.filter(p => p.checked || p.result_win !== null);

  const wins = checked.filter(p => p.result_win);
  const losses = checked.filter(p => !p.result_win);
  const winRate = checked.length > 0 ? ((wins.length / checked.length) * 100).toFixed(0) : '0';

  let recapStr = `**${checked.length} predictions** | **${wins.length} correct** | **${losses.length} wrong** | **${winRate}% win rate**\n\n`;

  if (checked.length > 0) {
    recapStr += '```\n';
    recapStr += 'TIME       DIR      SCORE  ENTRY      RESULT     MOVE     W/L\n';
    recapStr += '-'.repeat(65) + '\n';

    for (const p of checked) {
      const time = p.timestamp.slice(11, 16);
      const wl = p.result_win ? 'WIN' : 'LOSS';
      const move = p.result_pct_move
        ? `${p.result_pct_move > 0 ? '+' : ''}${p.result_pct_move.toFixed(2)}%`
        : 'N/A';
      const resultPrice = p.result_price ? `$${p.result_price.toFixed(0)}` : 'N/A';
      recapStr += `${time.padEnd(10)} ${p.direction.padEnd(8)} ${String(p.score).padEnd(6)} $${p.spot_price.toFixed(0).padEnd(9)} ${resultPrice.padEnd(10)} ${move.padEnd(8)} ${wl}\n`;
    }
    recapStr += '```';
  } else {
    recapStr += '_No predictions were checked today._';
  }

  const embed = {
    title: '\uD83D\uDCCA SPX GEX — END OF DAY RECAP',
    description: recapStr,
    color: COLORS.INFO,
    footer: { text: `GexClaw | ${formatET(nowET())} ET` },
    timestamp: new Date().toISOString(),
  };

  await sendEmbed(embed);
  log.info(`EOD recap sent: ${wins.length}/${checked.length} wins`);
}

/**
 * Send combined GEX + TV signal decision alert to Discord.
 * Only fires on action change or confidence change.
 */
export async function sendCombinedSignalAlert(decision) {
  const actionColors = {
    ENTER_CALLS: COLORS.BULLISH,
    ENTER_PUTS: COLORS.BEARISH,
    EXIT_CALLS: COLORS.WARNING,
    EXIT_PUTS: COLORS.WARNING,
    WAIT: COLORS.SYSTEM,
  };

  const actionEmojis = {
    ENTER_CALLS: '\uD83D\uDFE2',
    ENTER_PUTS: '\uD83D\uDD34',
    EXIT_CALLS: '\u26A0\uFE0F',
    EXIT_PUTS: '\u26A0\uFE0F',
    WAIT: '\u23F8',
  };

  const color = actionColors[decision.action] || COLORS.SYSTEM;
  const emoji = actionEmojis[decision.action] || '\uD83D\uDD14';

  // Build per-ticker TV confirmation grid (multi-indicator + multi-timeframe)
  const tvDetails = decision.tvDetailedState || [];
  let tvGrid = '';

  // Group by ticker, then by indicator
  const byTicker = {};
  for (const sig of tvDetails) {
    const tkr = sig.ticker || 'spx';
    if (!byTicker[tkr]) byTicker[tkr] = [];
    byTicker[tkr].push(sig);
  }

  // Per-ticker lines with timeframe columns
  for (const tkr of ['spx', 'spy', 'qqq']) {
    const sigs = byTicker[tkr];
    if (!sigs) continue;

    // Group by indicator name
    const byInd = {};
    for (const sig of sigs) {
      const ind = sig.indicatorName || sig.key?.split('_')[1] || 'unknown';
      if (!byInd[ind]) byInd[ind] = {};
      byInd[ind][sig.timeframe || '3'] = sig;
    }

    const lines = [];
    for (const ind of ['echo', 'bravo', 'tango']) {
      if (!byInd[ind]) continue;
      const parts = [];
      for (const tf of ['1', '3']) {
        const sig = byInd[ind]?.[tf];
        if (!sig || sig.state === 'NONE') {
          parts.push(`${tf}m:—`);
        } else {
          const icon = sig.classification === 'BULLISH' ? '\u2705'
            : sig.classification === 'BEARISH' ? '\u274C'
            : '\u2796';
          const staleTag = sig.isStale ? '*' : '';
          parts.push(`${tf}m:${icon}${sig.state}${staleTag}`);
        }
      }
      lines.push(`  ${ind.charAt(0).toUpperCase() + ind.slice(1)}: ${parts.join(' ')}`);
    }
    tvGrid += `${tkr.toUpperCase()}:\n${lines.join('\n')}\n`;
  }

  // TV weighted scores + confidence
  const tvState = decision.tvState || {};
  const tvConf = decision.tv_confidence || tvState.confidence || 'NONE';
  const spxWeighted = tvState.spx?.weighted_score || {};
  tvGrid += `\nTV: ${tvConf} | SPX wt: ${(spxWeighted.bullish || 0).toFixed(1)}B/${(spxWeighted.bearish || 0).toFixed(1)}R`;

  const confirmBullish = tvState.confirmations?.bullish || 0;
  const confirmBearish = tvState.confirmations?.bearish || 0;
  const confirmTotal = tvState.confirmations?.total || 6;

  // Cross-market count
  const crossMarket = tvState.cross_market || {};
  const crossBull = crossMarket.bullish_tickers || 0;
  const crossBear = crossMarket.bearish_tickers || 0;
  const crossTotal = crossMarket.total || 3;

  // Determine confirm display
  const maxConfirm = Math.max(confirmBullish, confirmBearish);
  const tvConfidenceLabel = tvConf !== 'NONE' ? ` [${tvConf}]` : '';

  // Build multi-ticker summary line
  let multiLine = `SPX: **$${(decision.spotPrice || 0).toFixed(2)}** (${decision.gexScore || '--'}/100 ${decision.gexDirection || '--'})`;
  if (decision.spySpot && decision.spyScore != null) {
    multiLine += ` | SPY: **$${decision.spySpot.toFixed(2)}** (${decision.spyScore} ${decision.spyDirection || '--'})`;
  }
  if (decision.qqqSpot && decision.qqqScore != null) {
    multiLine += ` | QQQ: **$${decision.qqqSpot.toFixed(2)}** (${decision.qqqScore} ${decision.qqqDirection || '--'})`;
  }

  // Driver + alignment line
  const mt = decision.multiTicker;
  let trinityLine = '';
  if (mt) {
    if (mt.driver) trinityLine += `Driver: **${mt.driver.ticker}** \u2014 ${mt.driver.reason}\n`;
    if (mt.alignment) trinityLine += `Alignment: **${mt.alignment.count}/3 ${mt.alignment.direction}**`;
    if (mt.multiSignal?.confidence) trinityLine += ` (${mt.multiSignal.confidence} conviction)`;
  }

  const embed = {
    title: `${emoji} ${decision.action.replace(/_/g, ' ')} \u2014 ${decision.confidence} Confidence`,
    description: multiLine,
    color,
    fields: [],
    footer: {
      text: `GexClaw | Agent: ${decision.responseTimeMs || decision.response_time_ms || '--'}ms | Tokens: ${decision.inputTokens || decision.input_tokens || '--'} in / ${decision.outputTokens || decision.output_tokens || '--'} out`,
    },
    timestamp: new Date().toISOString(),
  };

  // Multi-ticker trinity field
  if (trinityLine) {
    embed.fields.push({ name: 'Cross-Market', value: trinityLine, inline: false });
  }

  // GEX environment field
  if (decision.target_wall || decision.stop_level) {
    let gexField = '';
    if (decision.target_wall) {
      gexField += `Target Wall: ${decision.target_wall.strike} (${formatDollar(decision.target_wall.value)}) \u2014 magnet\n`;
    }
    if (decision.stop_level) {
      gexField += `Stop: ${decision.stop_level.strike} \u2014 ${decision.stop_level.reason}\n`;
    }
    gexField += `Environment: ${decision.gexConfidence || '--'}`;
    embed.fields.push({ name: 'GEX Levels', value: gexField, inline: false });
  }

  // TV confirmations field (per-ticker + cross-market)
  const crossLabel = crossBull + crossBear > 0
    ? ` | Cross: ${crossBull}/${crossTotal} BULL`
    : '';
  embed.fields.push({
    name: `TV${tvConfidenceLabel}: SPX ${maxConfirm}/${confirmTotal}${crossLabel}`,
    value: `\`\`\`\n${tvGrid}\`\`\``,
    inline: false,
  });

  // Reasoning
  if (decision.reason) {
    embed.fields.push({
      name: 'Reasoning',
      value: decision.reason,
      inline: false,
    });
  }

  // Risk
  if (decision.key_risk) {
    embed.fields.push({
      name: 'Key Risk',
      value: decision.key_risk,
      inline: false,
    });
  }

  // Previous action (for context on changes)
  if (decision.previousAction && decision.previousAction !== decision.action) {
    embed.fields.push({
      name: 'Action Change',
      value: `${decision.previousAction} \u2192 ${decision.action}`,
      inline: true,
    });
  }

  await sendEmbed(embed);
  log.info(`Combined signal alert sent: ${decision.action} (${decision.confidence})`);
}

/**
 * Send system health heartbeat.
 */
export async function sendHealthHeartbeat(status) {
  const msg = `\u2764\uFE0F **GexClaw** | ${status.phase} | Cycles: ${status.cycleCount} | Last: ${status.lastScore || '--'}/100 ${status.lastDirection || '--'} | Spot: $${status.lastSpot?.toFixed(2) || '--'}`;
  await sendWebhook(msg);
  log.debug('Health heartbeat sent');
}

// ---- Phase 3: Trade Alerts ----

/**
 * Send a trade card when entering a position.
 * Green embed for calls, red for puts.
 */
export async function sendTradeCard(trade) {
  const isCalls = trade.direction === 'BULLISH';
  const color = isCalls ? 0x00D26A : 0xE94560;
  const typeLabel = isCalls ? 'CALLS' : 'PUTS';
  const now = formatET(nowET());

  // Lane tag: [GEX-ONLY] for Lane A, [GEX+TV PHANTOM] for Lane B
  const laneTag = trade.strategyLane === 'B' ? '[GEX+TV]' : '[GEX-ONLY]';
  const triggerTag = trade.entryTrigger ? ` | ${trade.entryTrigger.replace(/_/g, ' ')}` : '';

  const embed = {
    title: `${isCalls ? '\uD83D\uDFE2' : '\uD83D\uDD34'} ENTER ${typeLabel} ${laneTag}${triggerTag}`,
    color,
    fields: [
      {
        name: 'Trade',
        value: `**SPX ${typeLabel} ${trade.strike}** | Lane ${trade.strategyLane || '?'}`,
        inline: false,
      },
      {
        name: 'SPX Entry',
        value: `$${trade.entrySpx?.toFixed(2) || '?'}`,
        inline: true,
      },
      {
        name: 'Target SPX',
        value: `$${trade.targetSpx || '?'}`,
        inline: true,
      },
      {
        name: 'Stop SPX',
        value: `$${trade.stopSpx || '?'}`,
        inline: true,
      },
    ],
    footer: { text: `GexClaw v3.0 | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  if (trade.entryTrigger) {
    embed.fields.push({
      name: 'Entry Trigger',
      value: trade.entryTrigger.replace(/_/g, ' '),
      inline: true,
    });
  }

  if (trade.agentReasoning) {
    embed.fields.push({
      name: 'Reasoning',
      value: trade.agentReasoning.slice(0, 200),
      inline: false,
    });
  }

  await sendEmbed(embed);
  log.info(`Trade card sent: ${trade.contract}`);
}

/**
 * Send position update (P&L) every 5 minutes while in a position.
 */
export async function sendPositionUpdate(update) {
  const pnlColor = update.pnlPct >= 0 ? 0x00D26A : 0xE94560;
  const pnlSign = update.pnlPct >= 0 ? '+' : '';

  const spxPts = update.currentSpx - update.entrySpx;
  const spxSign = spxPts >= 0 ? '+' : '';

  const embed = {
    title: '\uD83D\uDCCA Position Update',
    color: 0x6366F1, // indigo
    description: `**${update.contract}** | ${update.direction}`,
    fields: [
      {
        name: 'SPX Movement',
        value: `**${spxSign}${spxPts.toFixed(1)} pts**`,
        inline: true,
      },
      {
        name: 'SPX',
        value: `$${update.currentSpx.toFixed(2)} (entry: $${update.entrySpx.toFixed(2)})`,
        inline: true,
      },
    ],
    footer: { text: `GexClaw | ${formatET(nowET())} ET` },
    timestamp: new Date().toISOString(),
  };

  await sendEmbed(embed);
  log.debug('Position update sent');
}

/**
 * Send trade closed notification.
 * Bright green for win, red for loss.
 */
export async function sendTradeClosed(result) {
  const isWin = result.isWin;
  const color = isWin ? 0x22C55E : 0xEF4444;
  const sign = result.spxChange >= 0 ? '+' : '';

  const exitReasonLabels = {
    TARGET_HIT: 'Target Hit',
    NODE_SUPPORT_BREAK: 'Node Support Break',
    STOP_HIT: 'Stop Hit',
    PROFIT_TARGET: 'Profit Target',
    TV_COUNTER_FLIP: 'TV Counter Flip',
    STOP_LOSS: 'Stop Loss',
    OPPOSING_WALL: 'Opposing Wall',
    MOMENTUM_TIMEOUT: 'Momentum Timeout',
    TV_FLIP: 'TV Signal Flip',
    MAP_RESHUFFLE: 'Map Reshuffle',
    TRAILING_STOP: 'Trailing Stop',
    AGENT_EXIT: 'Agent Exit Signal',
    THETA_DEATH: 'Theta Death (3:30 PM)',
    GEX_FLIP: 'GEX Direction Flip',
  };

  const laneLabel = result.strategyLane ? ` | Lane ${result.strategyLane}` : '';
  const triggerLabel = result.entryTrigger ? ` | ${result.entryTrigger.replace(/_/g, ' ')}` : '';

  const embed = {
    title: `${isWin ? '\uD83C\uDFC6' : '\uD83D\uDCB8'} TRADE CLOSED \u2014 ${isWin ? 'WIN' : 'LOSS'}`,
    color,
    fields: [
      {
        name: 'Contract',
        value: `\`${result.contract}\` | ${result.direction}${laneLabel}${triggerLabel}`,
        inline: false,
      },
      {
        name: 'SPX Movement',
        value: `**${sign}${result.spxChange} pts** (${sign}${result.pnlPct}%)`,
        inline: true,
      },
      {
        name: 'Exit Reason',
        value: exitReasonLabels[result.exitReason] || result.exitReason,
        inline: true,
      },
      {
        name: 'SPX',
        value: `Entry: $${result.entrySpx.toFixed(2)} → Exit: $${result.exitSpx.toFixed(2)}`,
        inline: false,
      },
    ],
    footer: { text: `GexClaw v3.0 | ${formatET(nowET())} ET` },
    timestamp: new Date().toISOString(),
  };

  await sendEmbed(embed);
  log.info(`Trade closed: ${isWin ? 'WIN' : 'LOSS'} ${sign}${result.spxChange} pts`);
}

// ---- Phase 5: Strategy Alerts ----

/**
 * Send strategy change alert (after nightly/weekly review creates a new version).
 * Purple embed with version number, changes list, analysis summary.
 */
export async function sendStrategyChange(reviewResult) {
  const changes = reviewResult.changes || [];
  const changeLines = changes.map(c =>
    `**${c.parameter}**: ${c.old_value} → ${c.new_value}\n> ${c.reason}`
  ).join('\n\n');

  const embed = {
    title: `\uD83E\uDDE0 Strategy Updated — v${reviewResult.newVersion}`,
    description: reviewResult.analysis?.analysis_summary || 'Strategy parameters adjusted.',
    color: 0x7C3AED, // purple
    fields: [
      {
        name: `${changes.length} Change${changes.length === 1 ? '' : 's'}`,
        value: changeLines || 'No changes',
        inline: false,
      },
    ],
    footer: { text: `GexClaw | v${reviewResult.previousVersion} → v${reviewResult.newVersion} | ${formatET(nowET())} ET` },
    timestamp: new Date().toISOString(),
  };

  if (reviewResult.tokenUsage) {
    embed.fields.push({
      name: 'Review Cost',
      value: `${reviewResult.tokenUsage.inputTokens}+${reviewResult.tokenUsage.outputTokens} tokens | ${reviewResult.tokenUsage.responseTimeMs}ms`,
      inline: true,
    });
  }

  await sendEmbed(embed);
  log.info(`Strategy change alert sent: v${reviewResult.newVersion}`);
}

/**
 * Send strategy rollback alert.
 * Red embed with trigger type, from→to versions, details.
 */
export async function sendStrategyRollback(rollback) {
  const embed = {
    title: `\u26A0\uFE0F Strategy Rollback — ${rollback.trigger}`,
    description: rollback.details?.reason || 'Performance threshold breached.',
    color: 0xEF4444, // red
    fields: [
      {
        name: 'Version Change',
        value: `v${rollback.fromVersion} → v${rollback.toVersion}`,
        inline: true,
      },
      {
        name: 'Trigger',
        value: rollback.trigger.replace(/_/g, ' '),
        inline: true,
      },
    ],
    footer: { text: `GexClaw | ${formatET(nowET())} ET` },
    timestamp: new Date().toISOString(),
  };

  await sendEmbed(embed);
  log.info(`Strategy rollback alert sent: ${rollback.trigger}`);
}

/**
 * Send no-change alert (review ran but made no adjustments).
 * Gray embed with reason.
 */
export async function sendNoChange(reviewResult) {
  const embed = {
    title: '\u2705 Nightly Review — No Changes',
    description: reviewResult.analysis?.analysis_summary || reviewResult.reason || 'Strategy performing within expectations.',
    color: 0x6B7280, // gray
    fields: [],
    footer: { text: `GexClaw | ${formatET(nowET())} ET` },
    timestamp: new Date().toISOString(),
  };

  if (reviewResult.analysis?.market_notes) {
    embed.fields.push({
      name: 'Market Notes',
      value: reviewResult.analysis.market_notes,
      inline: false,
    });
  }

  await sendEmbed(embed);
  log.info('No-change review alert sent');
}

/**
 * Send a GEX map reshuffle alert.
 * Yellow warning embed — all previous wall analysis may be invalidated.
 */
export async function sendMapReshuffleAlert(reshuffle) {
  const embed = {
    title: '\uD83D\uDD00 GEX MAP RESHUFFLE',
    description: `**${reshuffle.ticker}**: ${reshuffle.new_count} new wall${reshuffle.new_count === 1 ? '' : 's'}, ${reshuffle.disappeared_count} disappeared`,
    color: 0xFBBF24, // warning yellow
    fields: [{
      name: 'Action',
      value: 'Previous wall analysis invalidated. Wait for new map to stabilize.',
      inline: false,
    }],
    footer: { text: `GexClaw | ${formatET(nowET())} ET` },
    timestamp: new Date().toISOString(),
  };

  if (reshuffle.description) {
    embed.fields.push({
      name: 'Details',
      value: reshuffle.description,
      inline: false,
    });
  }

  await sendEmbed(embed);
  log.info(`Map reshuffle alert sent: ${reshuffle.ticker}`);
}

/**
 * Send comprehensive end-of-day summary at 4:05 PM ET.
 * 4 Discord embeds: Performance, Breakdown, Trade Log, Phantoms & System.
 */
export async function sendEodSummary({ trades, phantoms, decisions, tvSignalLog, gexSnapshots, alerts, predictions, strategy, cycleCount }) {
  const now = formatET(nowET());
  const todayStr = now.slice(0, 10);

  // ---- Compute stats ----
  const closedTrades = trades.filter(t => t.closed_at);
  const wins = closedTrades.filter(t => t.pnl_pct > 0);
  const losses = closedTrades.filter(t => t.pnl_pct <= 0);
  const winRate = closedTrades.length > 0 ? ((wins.length / closedTrades.length) * 100).toFixed(0) : '0';

  const totalPnlPts = closedTrades.reduce((sum, t) => {
    const pts = (t.exit_spx || 0) - (t.entry_spx || 0);
    return sum + (t.direction === 'BEARISH' ? -pts : pts);
  }, 0);
  const avgPnlPts = closedTrades.length > 0 ? (totalPnlPts / closedTrades.length) : 0;

  const bestTrade = closedTrades.reduce((best, t) => {
    const pts = t.direction === 'BEARISH' ? (t.entry_spx - t.exit_spx) : (t.exit_spx - t.entry_spx);
    return (!best || pts > best.pts) ? { ...t, pts } : best;
  }, null);

  const worstTrade = closedTrades.reduce((worst, t) => {
    const pts = t.direction === 'BEARISH' ? (t.entry_spx - t.exit_spx) : (t.exit_spx - t.entry_spx);
    return (!worst || pts < worst.pts) ? { ...t, pts } : worst;
  }, null);

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of closedTrades) {
    const reason = t.exit_reason || 'UNKNOWN';
    exitReasons[reason] = (exitReasons[reason] || 0) + 1;
  }

  // Entry block breakdown
  const blockedAlerts = alerts.filter(a => a.type === 'ENTRY_BLOCKED');
  const blockReasons = {};
  for (const a of blockedAlerts) {
    try {
      const parsed = JSON.parse(a.content);
      const reason = parsed.details?.reason?.split(' — ')[0] || parsed.message?.split(' — ')[1]?.split(',')[0] || 'Unknown';
      blockReasons[reason] = (blockReasons[reason] || 0) + 1;
    } catch { blockReasons['Unknown'] = (blockReasons['Unknown'] || 0) + 1; }
  }

  // Agent decision stats
  const agentCalls = decisions.filter(d => !d.skipped);
  const skippedCalls = decisions.filter(d => d.skipped);
  const totalTokensIn = agentCalls.reduce((s, d) => s + (d.input_tokens || 0), 0);
  const totalTokensOut = agentCalls.reduce((s, d) => s + (d.output_tokens || 0), 0);
  const avgResponseMs = agentCalls.length > 0
    ? Math.round(agentCalls.reduce((s, d) => s + (d.response_time_ms || 0), 0) / agentCalls.length)
    : 0;

  // GEX stats
  const gexScores = gexSnapshots.map(s => s.score).filter(s => s != null);
  const avgGexScore = gexScores.length > 0 ? Math.round(gexScores.reduce((a, b) => a + b, 0) / gexScores.length) : 0;
  const minGexScore = gexScores.length > 0 ? Math.min(...gexScores) : 0;
  const maxGexScore = gexScores.length > 0 ? Math.max(...gexScores) : 0;

  // Spot price range
  const spots = gexSnapshots.map(s => s.spot_price).filter(s => s != null);
  const spotHigh = spots.length > 0 ? Math.max(...spots) : 0;
  const spotLow = spots.length > 0 ? Math.min(...spots) : 0;
  const spotRange = spotHigh - spotLow;

  // Prediction accuracy
  const checkedPreds = predictions.filter(p => p.checked);
  const predWins = checkedPreds.filter(p => p.result_win);
  const predWinRate = checkedPreds.length > 0 ? ((predWins.length / checkedPreds.length) * 100).toFixed(0) : '0';

  // ---- EMBED 1: Performance Summary ----
  const perfColor = totalPnlPts >= 0 ? COLORS.BULLISH : COLORS.BEARISH;
  const pnlSign = totalPnlPts >= 0 ? '+' : '';

  const embed1 = {
    title: '\uD83D\uDCCA END OF DAY SUMMARY',
    description: `**${todayStr}** | Strategy: ${strategy || 'v1'}`,
    color: perfColor,
    fields: [
      {
        name: 'Performance',
        value: [
          `Trades: **${closedTrades.length}** (${wins.length}W / ${losses.length}L)`,
          `Win Rate: **${winRate}%**`,
          `Total P&L: **${pnlSign}${totalPnlPts.toFixed(1)} pts**`,
          `Avg P&L: **${avgPnlPts >= 0 ? '+' : ''}${avgPnlPts.toFixed(1)} pts/trade**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Market',
        value: [
          `SPX Range: $${spotLow.toFixed(0)}-$${spotHigh.toFixed(0)} ($${spotRange.toFixed(0)})`,
          `GEX Score: ${avgGexScore} avg (${minGexScore}-${maxGexScore})`,
          `Predictions: ${predWins.length}/${checkedPreds.length} (${predWinRate}%)`,
        ].join('\n'),
        inline: true,
      },
    ],
    footer: { text: `GexClaw | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  if (bestTrade) {
    embed1.fields.push({
      name: 'Best / Worst',
      value: `Best: **${bestTrade.contract}** ${bestTrade.pts >= 0 ? '+' : ''}${bestTrade.pts.toFixed(1)} pts\nWorst: **${worstTrade?.contract || '—'}** ${worstTrade ? `${worstTrade.pts >= 0 ? '+' : ''}${worstTrade.pts.toFixed(1)} pts` : '—'}`,
      inline: false,
    });
  }

  // ---- EMBED 2: Detailed Breakdown ----
  const exitReasonsStr = Object.entries(exitReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}: ${count}`)
    .join('\n') || 'No trades closed';

  const blockReasonsStr = Object.entries(blockReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join('\n') || 'None blocked';

  // Hold time stats
  const holdTimes = closedTrades.map(t => {
    if (!t.opened_at || !t.closed_at) return null;
    const opened = new Date(t.opened_at.replace(' ', 'T'));
    const closed = new Date(t.closed_at.replace(' ', 'T'));
    return (closed - opened) / 60000; // minutes
  }).filter(h => h != null && h > 0);
  const avgHoldMin = holdTimes.length > 0 ? (holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length).toFixed(1) : '0';
  const maxHoldMin = holdTimes.length > 0 ? Math.max(...holdTimes).toFixed(1) : '0';

  const embed2 = {
    title: '\uD83D\uDD0D DETAILED BREAKDOWN',
    color: COLORS.INFO,
    fields: [
      {
        name: 'Exit Reasons',
        value: `\`\`\`\n${exitReasonsStr}\n\`\`\``,
        inline: true,
      },
      {
        name: `Entries Blocked (${blockedAlerts.length})`,
        value: `\`\`\`\n${blockReasonsStr}\n\`\`\``,
        inline: true,
      },
      {
        name: 'Timing',
        value: `Avg Hold: ${avgHoldMin} min | Max: ${maxHoldMin} min`,
        inline: false,
      },
      {
        name: 'TV Signals',
        value: `${tvSignalLog.length} signal changes today`,
        inline: true,
      },
      {
        name: 'GEX Snapshots',
        value: `${gexSnapshots.length} readings`,
        inline: true,
      },
    ],
    footer: { text: `GexClaw | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  // ---- EMBED 3: Trade Log ----
  let tradeLogStr = '';
  if (closedTrades.length > 0) {
    tradeLogStr += 'CONTRACT              DIR   ENTRY    EXIT     PTS    EXIT REASON\n';
    tradeLogStr += '-'.repeat(72) + '\n';
    for (const t of closedTrades) {
      const dir = t.direction === 'BULLISH' ? 'CALL' : 'PUT ';
      const pts = t.direction === 'BEARISH'
        ? (t.entry_spx - t.exit_spx)
        : (t.exit_spx - t.entry_spx);
      const ptsStr = `${pts >= 0 ? '+' : ''}${pts.toFixed(1)}`;
      const contractShort = t.contract?.slice(-8) || t.contract || '?';
      const exitReason = (t.exit_reason || '?').slice(0, 14);
      tradeLogStr += `${contractShort.padEnd(22)}${dir.padEnd(6)}$${(t.entry_spx || 0).toFixed(0).padEnd(8)}$${(t.exit_spx || 0).toFixed(0).padEnd(8)}${ptsStr.padEnd(7)}${exitReason}\n`;
    }
  } else {
    tradeLogStr = 'No trades today.';
  }

  const embed3 = {
    title: '\uD83D\uDCDD TRADE LOG',
    description: `\`\`\`\n${tradeLogStr}\`\`\``,
    color: closedTrades.length > 0 ? (totalPnlPts >= 0 ? COLORS.BULLISH : COLORS.BEARISH) : COLORS.SYSTEM,
    footer: { text: `GexClaw | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  // ---- EMBED 4: Phantoms & System ----
  let phantomStr = '';
  const closedPhantoms = phantoms.filter(p => p.closed_at);
  if (closedPhantoms.length > 0) {
    const phantomPts = closedPhantoms.reduce((sum, p) => {
      const pts = p.direction === 'BEARISH' ? (p.entry_spx - p.exit_spx) : (p.exit_spx - p.entry_spx);
      return sum + pts;
    }, 0);
    const phantomWins = closedPhantoms.filter(p => {
      const pts = p.direction === 'BEARISH' ? (p.entry_spx - p.exit_spx) : (p.exit_spx - p.entry_spx);
      return pts > 0;
    });
    phantomStr = `${closedPhantoms.length} phantom(s): ${phantomWins.length}W / ${closedPhantoms.length - phantomWins.length}L | ${phantomPts >= 0 ? '+' : ''}${phantomPts.toFixed(1)} pts`;
  } else {
    phantomStr = 'No phantom trades today';
  }

  const embed4 = {
    title: '\uD83D\uDC7B PHANTOMS & SYSTEM',
    color: COLORS.SYSTEM,
    fields: [
      {
        name: 'Phantom Trades',
        value: phantomStr,
        inline: false,
      },
      {
        name: 'Agent Stats',
        value: [
          `Calls: ${agentCalls.length} (${skippedCalls.length} skipped)`,
          `Tokens: ${totalTokensIn.toLocaleString()} in / ${totalTokensOut.toLocaleString()} out`,
          `Avg Response: ${avgResponseMs}ms`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'System',
        value: [
          `Cycles: ${cycleCount || '—'}`,
          `Strategy: ${strategy || 'v1'}`,
          `Alerts: ${alerts.length} total`,
        ].join('\n'),
        inline: true,
      },
    ],
    footer: { text: `GexClaw | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  // Send all 4 embeds (Discord allows max 10 embeds per message)
  const sent = await sendWebhook({ embeds: [embed1, embed2, embed3, embed4] });
  if (sent) {
    log.info(`EOD summary sent: ${closedTrades.length} trades, ${pnlSign}${totalPnlPts.toFixed(1)} pts`);
  } else {
    log.error('Failed to send EOD summary');
  }
  return sent;
}

/**
 * Send comprehensive review report to Discord (after nightly/weekly review).
 * 4 embeds: Performance Summary, Pattern Analysis, Proposed Changes, Narrative.
 */
export async function sendReviewReport(reviewResult) {
  const now = formatET(nowET());
  const analysis = reviewResult.analysis || {};
  const inputData = analysis._inputData || {};
  const metrics = inputData.analysis?.overall_metrics || {};
  const enrichment = inputData.enrichment || {};
  const isWeekly = inputData.review_type === 'WEEKLY';
  const reviewType = isWeekly ? 'Weekly' : 'Nightly';

  // Determine performance color
  const winRate = parseFloat(metrics.win_rate || '0');
  const perfColor = winRate >= 60 ? COLORS.BULLISH : winRate < 40 ? COLORS.BEARISH : COLORS.WARNING;

  // ---- EMBED 1: Performance Summary ----
  const versionInfo = reviewResult.newVersion
    ? `v${reviewResult.previousVersion} \u2192 v${reviewResult.newVersion}`
    : `v${inputData.current_version || '?'} (no changes)`;

  const embed1 = {
    title: `\uD83E\uDDE0 ${reviewType} Review Report`,
    description: analysis.analysis_summary || 'Review completed.',
    color: perfColor,
    fields: [
      {
        name: 'Performance',
        value: [
          `Trades: **${metrics.total_trades || 0}** (${metrics.wins || 0}W / ${metrics.losses || 0}L)`,
          `Win Rate: **${metrics.win_rate || '0'}%**`,
          `Total P&L: **$${metrics.total_pnl_dollars || 0}**`,
          `Avg P&L: **${metrics.avg_pnl_pct || 0}%**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Strategy',
        value: [
          `Version: **${versionInfo}**`,
          `Days Analyzed: **${inputData.days_analyzed || '?'}**`,
          `Blocked Entries: **${enrichment.blocked_entries_summary?.total_blocked || 0}**`,
        ].join('\n'),
        inline: true,
      },
    ],
    footer: { text: `GexClaw | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  // Add best/worst if available
  if (metrics.best_trade_pnl_pct || metrics.worst_trade_pnl_pct) {
    embed1.fields.push({
      name: 'Range',
      value: `Best: **${metrics.best_trade_pnl_pct > 0 ? '+' : ''}${metrics.best_trade_pnl_pct || 0}%** | Worst: **${metrics.worst_trade_pnl_pct || 0}%**`,
      inline: false,
    });
  }

  // ---- EMBED 2: Pattern Analysis ----
  const patterns = analysis.pattern_analysis || {};
  const patternFields = [];

  if (patterns.winning_setups) {
    patternFields.push({ name: '\u2705 Winning Setups', value: truncate(patterns.winning_setups, 1024), inline: false });
  }
  if (patterns.losing_setups) {
    patternFields.push({ name: '\u274C Losing Setups', value: truncate(patterns.losing_setups, 1024), inline: false });
  }
  if (patterns.blocked_entry_review) {
    patternFields.push({ name: '\uD83D\uDEAB Blocked Entries', value: truncate(patterns.blocked_entry_review, 1024), inline: false });
  }
  if (patterns.exit_effectiveness) {
    patternFields.push({ name: '\uD83D\uDEAA Exit Analysis', value: truncate(patterns.exit_effectiveness, 1024), inline: false });
  }
  if (patterns.tv_signal_value) {
    patternFields.push({ name: '\uD83D\uDCFA TV Signal Value', value: truncate(patterns.tv_signal_value, 512), inline: true });
  }
  if (patterns.time_patterns) {
    patternFields.push({ name: '\u23F0 Time Patterns', value: truncate(patterns.time_patterns, 512), inline: true });
  }

  // Weekly-specific patterns
  if (patterns.version_evolution) {
    patternFields.push({ name: '\uD83D\uDCC8 Version Evolution', value: truncate(patterns.version_evolution, 1024), inline: false });
  }

  const embed2 = {
    title: '\uD83D\uDD0D Pattern Analysis',
    color: COLORS.INFO,
    fields: patternFields.length > 0 ? patternFields : [{ name: 'Analysis', value: 'No patterns detected yet — need more data.', inline: false }],
    footer: { text: `GexClaw | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  // ---- EMBED 3: Proposed Changes ----
  const changes = reviewResult.changes || [];
  const hasChanges = changes.length > 0;

  let changesDescription;
  if (hasChanges) {
    changesDescription = changes.map(c =>
      `**${c.parameter}**: \`${c.old_value}\` \u2192 \`${c.new_value}\`\n> ${c.reason}${c.expected_impact ? `\n> _Impact: ${c.expected_impact}_` : ''}`
    ).join('\n\n');
  } else {
    changesDescription = analysis.should_adjust === false
      ? 'No changes recommended — strategy performing within expectations.'
      : reviewResult.reason || 'No adjustments warranted.';
  }

  const isProposed = reviewResult.proposed === true;

  const embed3 = {
    title: hasChanges
      ? `\uD83D\uDD27 ${changes.length} Proposed Change${changes.length === 1 ? '' : 's'} — Awaiting Approval`
      : '\u2705 No Changes',
    description: truncate(changesDescription, 2048),
    color: hasChanges ? 0x7C3AED : COLORS.SYSTEM, // purple if changes, gray if not
    fields: [],
    footer: { text: `GexClaw | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  // Add token cost
  if (reviewResult.tokenUsage) {
    embed3.fields.push({
      name: 'Review Cost',
      value: `${reviewResult.tokenUsage.inputTokens?.toLocaleString() || 0} + ${reviewResult.tokenUsage.outputTokens?.toLocaleString() || 0} tokens | ${reviewResult.tokenUsage.responseTimeMs || 0}ms`,
      inline: true,
    });
  }

  // ---- EMBED 4: Narrative & Memory ----
  const narrative = analysis.narrative || {};
  const narrativeFields = [];

  const storyKey = isWeekly ? 'week_story' : 'today_story';
  const compKey = isWeekly ? 'evolution' : 'comparison_to_previous';

  if (narrative[storyKey]) {
    narrativeFields.push({ name: isWeekly ? '\uD83D\uDCD6 Week Story' : '\uD83D\uDCD6 Today\'s Story', value: truncate(narrative[storyKey], 1024), inline: false });
  }
  if (narrative[compKey]) {
    narrativeFields.push({ name: isWeekly ? '\uD83D\uDCC8 Evolution' : '\uD83D\uDD04 Comparison', value: truncate(narrative[compKey], 1024), inline: false });
  }
  if (narrative.cumulative_learnings) {
    narrativeFields.push({ name: '\uD83E\uDDE0 Cumulative Learnings', value: truncate(narrative.cumulative_learnings, 1024), inline: false });
  }
  if (analysis.market_notes) {
    narrativeFields.push({ name: '\uD83C\uDF0E Market Notes', value: truncate(analysis.market_notes, 512), inline: false });
  }

  // Weekly patterns
  if (analysis.weekly_patterns) {
    narrativeFields.push({ name: '\uD83D\uDCC5 Weekly Patterns', value: truncate(analysis.weekly_patterns, 512), inline: false });
  }

  const embed4 = {
    title: '\uD83D\uDCDD Narrative & Memory',
    color: 0x1E3A5F, // dark blue
    fields: narrativeFields.length > 0 ? narrativeFields : [{ name: 'Narrative', value: 'Building narrative — more data needed.', inline: false }],
    footer: { text: `GexClaw | ${reviewType} Review | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  // Send all 4 embeds
  const sent = await sendWebhook({ embeds: [embed1, embed2, embed3, embed4] });
  if (sent) {
    log.info(`${reviewType} review report sent to Discord: ${changes.length} change(s)`);
  } else {
    log.error(`Failed to send ${reviewType} review report`);
  }
  return sent;
}

/** Truncate text to Discord field limit */
function truncate(text, maxLen = 1024) {
  if (!text) return 'N/A';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Send a test message to verify webhook works.
 */
export async function sendTest() {
  const embed = {
    title: '\uD83D\uDD27 GexClaw Test Message',
    description: 'If you see this, the Discord webhook is working correctly.',
    color: COLORS.SYSTEM,
    fields: [
      { name: 'Status', value: 'Connected', inline: true },
      { name: 'Time', value: formatET(nowET()) + ' ET', inline: true },
    ],
    footer: { text: 'GexClaw SPX Trading System' },
    timestamp: new Date().toISOString(),
  };

  const sent = await sendEmbed(embed);
  if (sent) {
    log.info('Test message sent successfully');
  } else {
    log.error('Failed to send test message');
  }
  return sent;
}
