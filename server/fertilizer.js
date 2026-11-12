/**
 * Fertilizer calculator engine (pure functions, unit-testable).
 *
 * Gujarat land units:
 *   1 Acre        = 43,560 sq ft
 *   1 Gujarat Vigha = 17,424 sq ft  (=> 1 Acre = 2.5 Vigha, 1 Vigha = 0.4 Acre)
 */

export const SQFT_PER_ACRE = 43560;
export const SQFT_PER_VIGHA = 17424;
export const ACRES_PER_VIGHA = SQFT_PER_VIGHA / SQFT_PER_ACRE; // 0.4
export const VIGHA_PER_ACRE = SQFT_PER_ACRE / SQFT_PER_VIGHA; // 2.5

export class FertilizerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FertilizerError';
    this.status = 400;
    this.code = 'invalid_fertilizer_input';
  }
}

/** Standard nutrient composition of common Indian fertilizers (% by weight). */
export const FERTILIZERS = [
  { key: 'urea', label: 'યુરિયા', labelEn: 'Urea', n: 46, p: 0, k: 0, s: 0, note: 'નાઈટ્રોજનનું મુખ્ય ખાતર' },
  { key: 'dap', label: 'ડીએપી (DAP)', labelEn: 'DAP 18:46:0', n: 18, p: 46, k: 0, s: 0, note: 'નાઈટ્રોજન + ફોસ્ફરસ' },
  { key: 'mop', label: 'પોટાશ (MOP)', labelEn: 'Muriate of Potash', n: 0, p: 0, k: 60, s: 0, note: 'પોટેશિયમ' },
  { key: 'ssp', label: 'એસએસપી (SSP)', labelEn: 'Single Super Phosphate', n: 0, p: 16, k: 0, s: 11, note: 'ફોસ્ફરસ + ગંધક' },
  { key: 'npk_19_19_19', label: 'એનપીકે ૧૯:૧૯:૧૯', labelEn: 'NPK 19:19:19', n: 19, p: 19, k: 19, s: 0, note: 'સંતુલિત ખાતર' },
  { key: 'npk_10_26_26', label: 'એનપીકે ૧૦:૨૬:૨૬', labelEn: 'NPK 10:26:26', n: 10, p: 26, k: 26, s: 0, note: 'વાવણી સમયે' },
  { key: 'npk_20_20_0_13', label: 'એનપીકે ૨૦:૨૦:૦:૧૩', labelEn: 'NPK 20:20:0:13', n: 20, p: 20, k: 0, s: 13, note: 'ગંધક સાથે' },
  { key: 'ammonium_sulphate', label: 'એમોનિયમ સલ્ફેટ', labelEn: 'Ammonium Sulphate', n: 21, p: 0, k: 0, s: 24, note: 'નાઈટ્રોજન + ગંધક' },
  { key: 'custom', label: 'કસ્ટમ (જાતે ભરો)', labelEn: 'Custom / other', n: 0, p: 0, k: 0, s: 0, note: 'તમારા ખાતરનું N-P-K ટકાવારી ભરો', custom: true }
];

export const UNITS = [
  { key: 'vigha', label: 'ગુજરાત વીઘા', labelEn: 'Gujarat Vigha' },
  { key: 'acre', label: 'એકર', labelEn: 'Acre' }
];

export const UNIT_CONSTANTS = {
  sqftPerAcre: SQFT_PER_ACRE,
  sqftPerVigha: SQFT_PER_VIGHA,
  vighaPerAcre: VIGHA_PER_ACRE,
  acresPerVigha: ACRES_PER_VIGHA
};

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

export function toAcres(area, unit) {
  if (unit === 'vigha') return area * ACRES_PER_VIGHA;
  if (unit === 'acre') return area;
  throw new FertilizerError('જમીનનું એકમ ખોટું છે (વીઘા કે એકર પસંદ કરો).');
}

export function toVigha(area, unit) {
  if (unit === 'vigha') return area;
  if (unit === 'acre') return area * VIGHA_PER_ACRE;
  throw new FertilizerError('જમીનનું એકમ ખોટું છે (વીઘા કે એકર પસંદ કરો).');
}

/** Converts an amount expressed per `fromUnit` into the same rate per `toUnit`. */
export function convertRate(rate, fromUnit, toUnit) {
  if (fromUnit === toUnit) return rate;
  if (fromUnit === 'acre' && toUnit === 'vigha') return rate * ACRES_PER_VIGHA;
  if (fromUnit === 'vigha' && toUnit === 'acre') return rate * VIGHA_PER_ACRE;
  throw new FertilizerError('એકમ રૂપાંતર શક્ય નથી.');
}

const numberOrThrow = (value, fieldName) => {
  const num = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(num) || num <= 0) {
    throw new FertilizerError(`${fieldName} શૂન્યથી મોટું અંક આપો.`);
  }
  return num;
};

/**
 * @param {object} input
 * @param {number} input.area               land area in `areaUnit`
 * @param {'vigha'|'acre'} input.areaUnit
 * @param {number} input.dosePerUnit        fertilizer dose per `doseUnit`
 * @param {'vigha'|'acre'} input.doseUnit
 * @param {string} input.fertilizerKey
 * @param {number} [input.customN] percent N for custom fertilizer
 * @param {number} [input.customP] percent P2O5
 * @param {number} [input.customK] percent K2O
 * @param {number} [input.bagSizeKg]
 */
export function calculateFertilizer(input = {}) {
  const area = numberOrThrow(input.area, 'જમીનનું ક્ષેત્રફળ');
  const dosePerUnit = numberOrThrow(input.dosePerUnit, 'ખાતરનો ડોઝ');
  const areaUnit = input.areaUnit === 'acre' ? 'acre' : 'vigha';
  const doseUnit = input.doseUnit === 'acre' ? 'acre' : 'vigha';

  if (area > 100000) throw new FertilizerError('ક્ષેત્રફળ ખૂબ મોટું છે. ૧,૦૦,૦૦૦ થી ઓછું આપો.');
  if (dosePerUnit > 100000) throw new FertilizerError('ડોઝ ખૂબ મોટો છે. ડોઝ ચકાસો.');

  const bagSizeKg = input.bagSizeKg ? numberOrThrow(input.bagSizeKg, 'થેલીનું વજન') : 50;

  let fertilizer = FERTILIZERS.find((item) => item.key === input.fertilizerKey);
  if (!fertilizer) fertilizer = FERTILIZERS[0];

  let composition = { n: fertilizer.n, p: fertilizer.p, k: fertilizer.k, s: fertilizer.s };
  if (fertilizer.custom) {
    composition = {
      n: Math.min(Math.max(Number(input.customN) || 0, 0), 100),
      p: Math.min(Math.max(Number(input.customP) || 0, 0), 100),
      k: Math.min(Math.max(Number(input.customK) || 0, 0), 100),
      s: 0
    };
    if (composition.n + composition.p + composition.k === 0) {
      throw new FertilizerError('કસ્ટમ ખાતર માટે ઓછામાં ઓછું એક પોષક તત્વ (N/P/K) ની ટકાવારી ભરો.');
    }
  }

  const acres = toAcres(area, areaUnit);
  const vigha = toVigha(area, areaUnit);

  // Dose is given per doseUnit; convert the land into that unit first.
  const areaInDoseUnit = doseUnit === 'acre' ? acres : vigha;
  const totalKg = areaInDoseUnit * dosePerUnit;
  const bags = totalKg / bagSizeKg;

  const perAcreKg = totalKg / acres;
  const perVighaKg = totalKg / vigha;

  return {
    fertilizer: {
      key: fertilizer.key,
      label: fertilizer.label,
      labelEn: fertilizer.labelEn,
      composition
    },
    area: {
      value: round(area),
      unit: areaUnit,
      acres: round(acres, 3),
      vigha: round(vigha, 3)
    },
    dose: { value: round(dosePerUnit), unit: doseUnit },
    totalKg: round(totalKg),
    bags: { sizeKg: round(bagSizeKg), count: round(bags), buyCount: Math.ceil(bags) },
    rates: { perAcreKg: round(perAcreKg), perVighaKg: round(perVighaKg) },
    nutrients: {
      n: round((totalKg * composition.n) / 100),
      p2o5: round((totalKg * composition.p) / 100),
      k2o: round((totalKg * composition.k) / 100),
      s: round((totalKg * composition.s) / 100)
    },
    conversion: {
      acresPerVigha: ACRES_PER_VIGHA,
      vighaPerAcre: VIGHA_PER_ACRE,
      sqftPerVigha: SQFT_PER_VIGHA,
      sqftPerAcre: SQFT_PER_ACRE
    },
    note: 'આ ગણતરી ગાણિતિક છે. ખાતરની ભલામણ માટે જમીન પરીક્ષણ કાર્ડ અને સ્થાનિક કૃષિ અધિકારીની સલાહ લો.'
  };
}
