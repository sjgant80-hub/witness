// case/witnesscase.mjs — the cost case on the witness page: what checking that tests really guard the code costs a
// team in staff time today, what an AI model reviewing every change through a cloud API adds, and what a mutation gate
// on the team's own machine costs to run. Every external figure is read from the vendored, sourced basis
// (vendor/sovereign-enterprise/basis.json): the wage, inflation, electricity, the laptop's extra draw, the model's
// token price and the exchange rate. The hours, the share, the counts and the token sizes are the reader's own.
//
// Floors, never top ends: staff time at the UK median hourly wage with on-costs left out; CPI applied to every later
// year. Like for like: the cloud-model route is credited with the SAME share of the checking as the gate, so the two
// differ only in their running bill. CI runner minutes are not priced, because the basis has no sourced figure for
// them; on a public repository GitHub's runners cost nothing, on a private one they come out of the plan you already
// pay for. No price of ours appears here: these are the buyer's own costs.
//
// Pure, total, deterministic: garbage in gives { ok: false, why }, never a throw.

export const DEFAULTS = Object.freeze({ reviewHoursPerWeek: 10, share: 0.5, changesPerWeek: 50, tokensIn: 20000, tokensOut: 2000, gateHoursPerWeek: 10, years: 3 });
export const BASIS_KEYS = Object.freeze(['wageMedianHourly', 'cpi', 'electricityPencePerKwh', 'laptopExtraWatts', 'frontier', 'fxGbpPerUsd']);

const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const r2 = (x) => Math.round(x * 100) / 100;

/** the basis entries the case reads, each a sourced number; null when one is missing or unreadable */
function figures(basis) {
  const b = basis || {};
  const f = (k) => b[k] || {};
  const out = {
    wage: f('wageMedianHourly').value, cpi: f('cpi').value, pence: f('electricityPencePerKwh').value,
    watts: f('laptopExtraWatts').value, apiIn: f('frontier').inPerM, apiOut: f('frontier').outPerM, fx: f('fxGbpPerUsd').value,
  };
  return Object.values(out).every(isNum) ? out : null;
}

/** where each figure came from, for the page to list beside the numbers */
export function sourcesOf(basis) {
  try {
    return BASIS_KEYS.map((k) => ({ key: k, what: basis[k].what || basis[k].product, source: basis[k].source }));
  } catch { return []; }
}

/** a yearly cost carried over `years`, rising by CPI each year after the first */
export function over(perYear, cpi, years) {
  let total = 0;
  let factor = 1;
  for (let y = 0; y < years; y++) { total += perYear * factor; factor *= 1 + cpi; }
  return r2(total);
}

/** the case. input (all optional, defaults above): reviewHoursPerWeek, share (0 to 1), changesPerWeek, tokensIn,
 *  tokensOut, gateHoursPerWeek, years */
export function witnessCase(basis, input) {
  try {
    const f = figures(basis);
    if (!f) return { ok: false, why: 'a sourced basis with every figure the case reads' };
    const i = { ...DEFAULTS, ...(input || {}) };
    if (!isNum(i.reviewHoursPerWeek) || i.reviewHoursPerWeek > 168) return { ok: false, why: 'review hours a week: 0 to 168' };
    if (!isNum(i.share) || i.share > 1) return { ok: false, why: 'the share of the checking the gate takes over: 0 to 1' };
    if (!isNum(i.changesPerWeek) || !isNum(i.tokensIn) || !isNum(i.tokensOut)) return { ok: false, why: 'changes and tokens: numbers, 0 or more' };
    if (!isNum(i.gateHoursPerWeek) || i.gateHoursPerWeek > 168) return { ok: false, why: 'gate hours a week: 0 to 168' };
    if (!Number.isInteger(i.years) || i.years < 1 || i.years > 10) return { ok: false, why: 'years: 1 to 10' };
    const staff = r2(i.reviewHoursPerWeek * 52 * f.wage);                                                  // the checking, in staff time, a year
    const takenOff = r2(staff * i.share);                                                                  // the share the gate (or a model) does
    const api = r2(i.changesPerWeek * 52 * (i.tokensIn * f.apiIn + i.tokensOut * f.apiOut) / 1e6 * f.fx); // a cloud model on every change
    const power = r2(i.gateHoursPerWeek * 52 * f.watts / 1000 * f.pence / 100);                            // the gate on a machine already in use
    const perYear = { today: staff, cloudModel: r2(staff - takenOff + api), witness: r2(staff - takenOff + power) };
    const total = { today: over(perYear.today, f.cpi, i.years), cloudModel: over(perYear.cloudModel, f.cpi, i.years), witness: over(perYear.witness, f.cpi, i.years) };
    return {
      ok: true, inputs: i, lines: { staff, takenOff, api, power }, perYear, over: total,
      savingPerYear: r2(perYear.today - perYear.witness), savingOver: r2(total.today - total.witness),
      versusCloudPerYear: r2(perYear.cloudModel - perYear.witness), versusCloudOver: r2(total.cloudModel - total.witness),
    };
  } catch { return { ok: false, why: 'the inputs could not be read' }; }
}

export default { DEFAULTS, BASIS_KEYS, sourcesOf, over, witnessCase };
