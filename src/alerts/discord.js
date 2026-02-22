/**
 * Discord Webhook Integration for OpenClaw SPX GEX Scanner.
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
    footer: { text: `OpenClaw | ${now} ET` },
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
    footer: { text: `OpenClaw | ${now} ET` },
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
    footer: { text: `OpenClaw | ${formatET(nowET())} ET` },
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
    footer: { text: `OpenClaw | ${formatET(nowET())} ET` },
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

  // Build TV confirmation grid
  const tvDetails = decision.tvDetailedState || [];
  let tvGrid = '';
  for (const sig of tvDetails) {
    const icon = sig.classification === 'BULLISH' ? '\u2705'
      : sig.classification === 'BEARISH' ? '\u274C'
      : '\u2796';
    const staleTag = sig.isStale ? ' (STALE)' : '';
    tvGrid += `${icon} ${sig.indicator.charAt(0).toUpperCase() + sig.indicator.slice(1)}: ${sig.state}${staleTag}\n`;
  }

  const tvState = decision.tvState || {};
  const confirmBullish = tvState.confirmations?.bullish || 0;
  const confirmBearish = tvState.confirmations?.bearish || 0;
  const confirmTotal = tvState.confirmations?.total || 2;

  // Determine confirm display
  const maxConfirm = Math.max(confirmBullish, confirmBearish);
  const confirmDir = confirmBullish >= confirmBearish ? 'bullish' : 'bearish';

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
      text: `OpenClaw | Agent: ${decision.responseTimeMs || decision.response_time_ms || '--'}ms | Tokens: ${decision.inputTokens || decision.input_tokens || '--'} in / ${decision.outputTokens || decision.output_tokens || '--'} out`,
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

  // TV confirmations field
  embed.fields.push({
    name: `TV Confirmations: ${maxConfirm}/${confirmTotal}`,
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
  const msg = `\u2764\uFE0F **OpenClaw** | ${status.phase} | Cycles: ${status.cycleCount} | Last: ${status.lastScore || '--'}/100 ${status.lastDirection || '--'} | Spot: $${status.lastSpot?.toFixed(2) || '--'}`;
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

  const embed = {
    title: `${isCalls ? '\uD83D\uDFE2' : '\uD83D\uDD34'} ENTER ${typeLabel} \u2014 Trade Card`,
    color,
    fields: [
      {
        name: 'Contract',
        value: `\`${trade.contract}\`\nStrike: **$${trade.strike}** | Entry: **$${trade.entryPrice.toFixed(2)}**`,
        inline: false,
      },
      {
        name: 'Target',
        value: `$${trade.targetPrice.toFixed(2)} (**+${trade.targetPnlPct}%**)`,
        inline: true,
      },
      {
        name: 'Stop',
        value: `$${trade.stopPrice.toFixed(2)} (**${trade.stopPnlPct}%**)`,
        inline: true,
      },
      {
        name: 'R:R',
        value: `**${trade.rewardRiskRatio}:1**`,
        inline: true,
      },
      {
        name: 'SPX Levels',
        value: `Spot: $${trade.entrySpx.toFixed(2)}\nTarget: $${trade.targetSpx} | Stop: $${trade.stopSpx}`,
        inline: false,
      },
      {
        name: 'Greeks',
        value: `\`\`\`\nDelta: ${trade.greeks.delta?.toFixed(3) || '?'}  Gamma: ${trade.greeks.gamma?.toFixed(4) || '?'}\nTheta: ${trade.greeks.theta?.toFixed(2) || '?'}  IV: ${((trade.greeks.iv || 0) * 100).toFixed(1)}%\n\`\`\``,
        inline: false,
      },
    ],
    footer: { text: `OpenClaw v3.0 | ${now} ET` },
    timestamp: new Date().toISOString(),
  };

  if (trade.agentReasoning) {
    embed.fields.push({
      name: 'Agent Reasoning',
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

  const embed = {
    title: '\uD83D\uDCCA Position Update',
    color: 0x6366F1, // indigo
    description: `**${update.contract}** | ${update.direction}`,
    fields: [
      {
        name: 'P&L',
        value: `**${pnlSign}${update.pnlPct}%** ($${pnlSign}${update.pnlDollars.toFixed(2)})`,
        inline: true,
      },
      {
        name: 'SPX',
        value: `$${update.currentSpx.toFixed(2)} (entry: $${update.entrySpx.toFixed(2)})`,
        inline: true,
      },
      {
        name: 'Est. Price',
        value: `$${update.estimatedPrice.toFixed(2)} (entry: $${update.entryPrice.toFixed(2)})`,
        inline: true,
      },
    ],
    footer: { text: `OpenClaw | ${formatET(nowET())} ET` },
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
  const isWin = result.pnlDollars > 0;
  const color = isWin ? 0x22C55E : 0xEF4444;
  const pnlSign = result.pnlPct >= 0 ? '+' : '';

  const exitReasonLabels = {
    TARGET_HIT: 'Target Hit',
    STOP_HIT: 'Stop Hit',
    AGENT_EXIT: 'Agent Exit Signal',
    THETA_DEATH: 'Theta Death (3:30 PM)',
    GEX_FLIP: 'GEX Direction Flip',
  };

  const embed = {
    title: `${isWin ? '\uD83C\uDFC6' : '\uD83D\uDCB8'} TRADE CLOSED \u2014 ${isWin ? 'WIN' : 'LOSS'}`,
    color,
    fields: [
      {
        name: 'Contract',
        value: `\`${result.contract}\` | ${result.direction}`,
        inline: false,
      },
      {
        name: 'P&L',
        value: `**${pnlSign}$${result.pnlDollars.toFixed(2)}** (${pnlSign}${result.pnlPct}%)`,
        inline: true,
      },
      {
        name: 'Exit Reason',
        value: exitReasonLabels[result.exitReason] || result.exitReason,
        inline: true,
      },
      {
        name: 'Prices',
        value: `Entry: $${result.entryPrice.toFixed(2)} \u2192 Exit: $${result.exitPrice.toFixed(2)}`,
        inline: false,
      },
      {
        name: 'SPX',
        value: `$${result.entrySpx.toFixed(2)} \u2192 $${result.exitSpx.toFixed(2)} (${((result.exitSpx - result.entrySpx) / result.entrySpx * 100).toFixed(2)}%)`,
        inline: false,
      },
    ],
    footer: { text: `OpenClaw v3.0 | ${formatET(nowET())} ET` },
    timestamp: new Date().toISOString(),
  };

  await sendEmbed(embed);
  log.info(`Trade closed alert: ${isWin ? 'WIN' : 'LOSS'} ${pnlSign}${result.pnlPct}%`);
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
    footer: { text: `OpenClaw | v${reviewResult.previousVersion} → v${reviewResult.newVersion} | ${formatET(nowET())} ET` },
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
    footer: { text: `OpenClaw | ${formatET(nowET())} ET` },
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
    footer: { text: `OpenClaw | ${formatET(nowET())} ET` },
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
    footer: { text: `OpenClaw | ${formatET(nowET())} ET` },
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
 * Send a test message to verify webhook works.
 */
export async function sendTest() {
  const embed = {
    title: '\uD83D\uDD27 OpenClaw Test Message',
    description: 'If you see this, the Discord webhook is working correctly.',
    color: COLORS.SYSTEM,
    fields: [
      { name: 'Status', value: 'Connected', inline: true },
      { name: 'Time', value: formatET(nowET()) + ' ET', inline: true },
    ],
    footer: { text: 'OpenClaw SPX Trading System' },
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
