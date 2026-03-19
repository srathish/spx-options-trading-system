import { readFileSync } from 'fs';

const f = JSON.parse(readFileSync('data/gex-replay-2025-12-15.json', 'utf8'));

const frame0 = f.frames[0];
const spxw = frame0.tickers?.SPXW;

// What type are gammaValues elements?
console.log('gammaValues[0] type:', typeof spxw.gammaValues[0]);
console.log('gammaValues[0] value:', JSON.stringify(spxw.gammaValues[0]));
console.log('gammaValues[1] value:', JSON.stringify(spxw.gammaValues[1]));

// Find spot index and show nearby data
const spotIdx = spxw.strikes.findIndex(s => s >= spxw.spotPrice);
console.log('\nSpot:', spxw.spotPrice, '| spotIdx:', spotIdx);
for (let i = Math.max(0, spotIdx - 3); i < Math.min(spxw.strikes.length, spotIdx + 3); i++) {
  const gv = spxw.gammaValues[i];
  console.log(`  Strike ${spxw.strikes[i]}: gamma =`, JSON.stringify(gv));
}

// Check expirations structure
console.log('\nExpirations:', JSON.stringify(spxw.expirations));

// Check vannaValues type
console.log('\nvannaValues[0]:', JSON.stringify(spxw.vannaValues[0]));

// Total gamma calculation: sum all gammaValues
let totalGamma = 0;
let positiveGamma = 0;
let negativeGamma = 0;
for (const gv of spxw.gammaValues) {
  const val = typeof gv === 'number' ? gv : (gv?.value || gv?.total || 0);
  totalGamma += val;
  if (val > 0) positiveGamma += val;
  else negativeGamma += val;
}
console.log('\nSPXW Total gamma (sum):', totalGamma.toFixed(0));
console.log('SPXW Positive gamma:', positiveGamma.toFixed(0));
console.log('SPXW Negative gamma:', negativeGamma.toFixed(0));
console.log('SPXW gammaMaxValue:', spxw.gammaMaxValue);
console.log('SPXW gammaMinValue:', spxw.gammaMinValue);

// Same for SPY
const spy = frame0.tickers?.SPY;
let spyTotal = 0;
for (const gv of spy.gammaValues) {
  spyTotal += typeof gv === 'number' ? gv : (gv?.value || gv?.total || 0);
}
console.log('\nSPY Total gamma:', spyTotal.toFixed(0));
console.log('SPY spot:', spy.spotPrice);

// QQQ
const qqq = frame0.tickers?.QQQ;
let qqqTotal = 0;
for (const gv of qqq.gammaValues) {
  qqqTotal += typeof gv === 'number' ? gv : (gv?.value || gv?.total || 0);
}
console.log('\nQQQ Total gamma:', qqqTotal.toFixed(0));
console.log('QQQ spot:', qqq.spotPrice);
