/**
 * Entry Context Builder
 * Captures structural GEX nodes at entry time for NODE_SUPPORT_BREAK exit evaluation.
 * Stored as JSON in the trades.entry_context column.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('EntryCtx');

/**
 * Build entry context based on the triggering pattern and current GEX state.
 * @param {object} trigger - Pattern object from detectAllPatterns()
 * @param {object} scored - Scored GEX state from scoreSpxGex()
 * @param {object} multiAnalysis - Multi-ticker analysis
 * @returns {object} Context with support_node, ceiling_node, target_node
 */
export function buildEntryContext(trigger, scored, multiAnalysis) {
  if (!trigger || !scored) return null;

  const spotPrice = scored.spotPrice;
  const isBullish = trigger.direction === 'BULLISH';

  const context = {
    pattern: trigger.pattern,
    direction: trigger.direction,
    entry_spot: spotPrice,
    entry_time: Date.now(),
    gex_score_at_entry: scored.score,
    alignment_at_entry: multiAnalysis?.alignment?.count || 0,
    support_node: null,
    ceiling_node: null,
    target_node: { strike: trigger.target_strike, source: trigger.pattern },
  };

  switch (trigger.pattern) {
    case 'REVERSE_RUG':
      // Support = nearest positive wall below (launch pad floor)
      // Ceiling = nearest positive wall above (target area)
      context.support_node = findWall(scored.wallsBelow, 'positive', spotPrice);
      context.ceiling_node = findWall(scored.wallsAbove, 'positive', spotPrice);
      break;

    case 'RUG_PULL':
      // Ceiling = positive wall at/above spot (the rug)
      // Target = negative wall below (the trapdoor)
      context.ceiling_node = findWall(scored.wallsAbove, 'positive', spotPrice)
        || findWall(scored.wallsBelow, 'positive', spotPrice); // might be at spot
      context.support_node = findWall(scored.wallsBelow, 'negative', spotPrice);
      break;

    case 'PIKA_PILLOW':
      // Support = the pillow itself (large positive below)
      context.support_node = findWall(scored.wallsBelow, 'positive', spotPrice);
      context.ceiling_node = findWall(scored.wallsAbove, 'positive', spotPrice);
      break;

    case 'KING_NODE_BOUNCE': {
      // Use the king node strike as the key structural level
      const kingStrike = trigger.walls?.king;
      if (kingStrike) {
        const kingNode = { strike: kingStrike, gexValue: trigger.walls?.king_value || 0, distance: Math.abs(kingStrike - spotPrice) };
        if (isBullish) {
          context.support_node = kingNode;
          context.ceiling_node = findWall(scored.wallsAbove, 'positive', spotPrice);
        } else {
          context.ceiling_node = kingNode;
          context.support_node = findWall(scored.wallsBelow, 'positive', spotPrice);
        }
      }
      break;
    }

    case 'TRIPLE_CEILING':
      // Ceiling = lowest of the 3 stacked ceiling nodes
      if (trigger.walls?.start) {
        context.ceiling_node = { strike: trigger.walls.start, gexValue: 0, distance: Math.abs(trigger.walls.start - spotPrice) };
      } else {
        context.ceiling_node = findWall(scored.wallsAbove, 'positive', spotPrice);
      }
      context.support_node = findWall(scored.wallsBelow, 'positive', spotPrice);
      break;

    case 'TRIPLE_FLOOR':
      // Support = highest of the 3 stacked floor nodes
      if (trigger.walls?.start) {
        context.support_node = { strike: trigger.walls.start, gexValue: 0, distance: Math.abs(trigger.walls.start - spotPrice) };
      } else {
        context.support_node = findWall(scored.wallsBelow, 'positive', spotPrice);
      }
      context.ceiling_node = findWall(scored.wallsAbove, 'positive', spotPrice);
      break;

    case 'AIR_POCKET':
      // Support = entry price with small buffer
      context.support_node = { strike: spotPrice - 5, gexValue: 0, distance: 5 };
      context.ceiling_node = { strike: spotPrice + 5, gexValue: 0, distance: 5 };
      break;

    case 'RANGE_EDGE_FADE':
      // Support/ceiling = the gatekeeper walls defining the range
      context.support_node = findWall(scored.wallsBelow, 'positive', spotPrice);
      context.ceiling_node = findWall(scored.wallsAbove, 'positive', spotPrice);
      break;

    case 'TREND_PULLBACK':
      // Support = nearest positive wall below (trend floor), ceiling = nearest positive above
      context.support_node = findWall(scored.wallsBelow, 'positive', spotPrice);
      context.ceiling_node = findWall(scored.wallsAbove, 'positive', spotPrice);
      break;

    default:
      // Generic: use nearest positive walls above/below
      context.support_node = findWall(scored.wallsBelow, 'positive', spotPrice);
      context.ceiling_node = findWall(scored.wallsAbove, 'positive', spotPrice);
      break;
  }

  log.debug(`Built context for ${trigger.pattern} ${trigger.direction}: support=${context.support_node?.strike || 'none'}, ceiling=${context.ceiling_node?.strike || 'none'}, target=${context.target_node?.strike || 'none'}`);
  return context;
}

/**
 * Find the nearest wall of a given type from a walls array.
 */
function findWall(walls, type, spotPrice) {
  if (!walls || walls.length === 0) return null;
  const match = walls.find(w => w.type === type);
  if (!match) return null;
  return {
    strike: match.strike,
    gexValue: match.gexValue || match.absGexValue || 0,
    distance: Math.abs(match.strike - spotPrice),
  };
}
