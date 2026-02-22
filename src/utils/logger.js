import { DateTime } from 'luxon';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function timestamp() {
  return DateTime.now().setZone('America/New_York').toFormat('yyyy-MM-dd HH:mm:ss');
}

function log(level, tag, ...args) {
  if (LEVELS[level] < currentLevel) return;
  const prefix = `[${timestamp()}] [${tag}]`;
  switch (level) {
    case 'error': console.error(prefix, ...args); break;
    case 'warn':  console.warn(prefix, ...args);  break;
    case 'debug': console.debug(prefix, ...args); break;
    default:      console.log(prefix, ...args);
  }
}

export function createLogger(tag) {
  return {
    debug: (...args) => log('debug', tag, ...args),
    info:  (...args) => log('info', tag, ...args),
    warn:  (...args) => log('warn', tag, ...args),
    error: (...args) => log('error', tag, ...args),
  };
}
