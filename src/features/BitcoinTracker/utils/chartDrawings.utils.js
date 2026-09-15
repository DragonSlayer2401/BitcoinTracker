export const CHART_DRAWINGS_STORAGE_KEY = 'bitcoin-tracker:chart-drawings:cf-brti:v1';
export const MAXIMUM_CHART_DRAWINGS = 50;
export const MAXIMUM_DRAWING_LABEL_LENGTH = 40;
export const CHART_DRAWING_COLORS = Object.freeze([
  { value: '#31d0aa', label: 'Green' },
  { value: '#f47385', label: 'Red' },
  { value: '#6ea8fe', label: 'Blue' },
  { value: '#f4c56a', label: 'Amber' },
]);
export const DEFAULT_DRAWING_COLOR = '#6ea8fe';

const FIRST_BITCOIN_YEAR = Date.UTC(2009, 0, 1);
const MAXIMUM_FUTURE_DISTANCE = 366 * 24 * 60 * 60 * 1000;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactFields = (value, fields) =>
  isRecord(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const isPrice = (price) => Number.isFinite(price) && price > 0 && price <= 1e9;
const isTime = (time, now) =>
  Number.isSafeInteger(time) &&
  Number.isSafeInteger(now) &&
  time >= FIRST_BITCOIN_YEAR &&
  time <= now + MAXIMUM_FUTURE_DISTANCE;
const isPoint = (point, now) =>
  hasExactFields(point, ['time', 'price']) && isTime(point.time, now) && isPrice(point.price);

/** Only plain annotation coordinates are stored; they never enter forecast calculations. */
export function getValidatedChartDrawing(value, now = Date.now()) {
  if (!isRecord(value)) return null;
  const coordinates = {
    horizontal: ['price'],
    vertical: ['time'],
    trend: ['start', 'end'],
  }[value.type];
  if (
    !Array.isArray(coordinates) ||
    !hasExactFields(value, ['id', 'type', 'label', 'color', ...coordinates]) ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9:_-]{1,100}$/.test(value.id) ||
    typeof value.label !== 'string' ||
    value.label.length > MAXIMUM_DRAWING_LABEL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value.label) ||
    !CHART_DRAWING_COLORS.some((color) => color.value === value.color) ||
    (value.type === 'horizontal' && !isPrice(value.price)) ||
    (value.type === 'vertical' && !isTime(value.time, now)) ||
    (value.type === 'trend' &&
      (!isPoint(value.start, now) ||
        !isPoint(value.end, now) ||
        (value.start.time === value.end.time && value.start.price === value.end.price)))
  )
    return null;
  const drawing = { id: value.id, type: value.type, label: value.label, color: value.color };
  for (const coordinate of coordinates) {
    drawing[coordinate] = isRecord(value[coordinate])
      ? { time: value[coordinate].time, price: value[coordinate].price }
      : value[coordinate];
  }
  return drawing;
}

export function getValidatedChartDrawings(value, now = Date.now()) {
  if (!Array.isArray(value) || value.length > MAXIMUM_CHART_DRAWINGS) return null;
  const drawings = value.map((drawing) => getValidatedChartDrawing(drawing, now));
  if (
    drawings.some((drawing) => drawing === null) ||
    new Set(drawings.map((drawing) => drawing.id)).size !== drawings.length
  )
    return null;
  return drawings;
}

export function readChartDrawings(storage, now = Date.now()) {
  try {
    const serialized = (storage ?? globalThis.localStorage).getItem(CHART_DRAWINGS_STORAGE_KEY);
    if (serialized === null) return { drawings: [], warning: null };
    const record = JSON.parse(serialized);
    const drawings =
      hasExactFields(record, ['version', 'symbol', 'drawings']) &&
      record.version === 1 &&
      record.symbol === 'CF-BRTI'
        ? getValidatedChartDrawings(record.drawings, now)
        : null;
    if (drawings === null) throw new Error('Invalid saved drawings.');
    return { drawings, warning: null };
  } catch {
    return {
      drawings: [],
      warning: 'Saved chart drawings could not be read. They were preserved; changes are paused.',
    };
  }
}

export function writeChartDrawings(value, storage, now = Date.now()) {
  const drawings = getValidatedChartDrawings(value, now);
  if (drawings === null) return 'Chart drawings contain invalid coordinates or exceed 50 lines.';
  // An unreadable saved set is never treated as empty, even when explicitly saving an empty set.
  const saved = readChartDrawings(storage, now);
  if (saved.warning) return saved.warning;
  try {
    (storage ?? globalThis.localStorage).setItem(
      CHART_DRAWINGS_STORAGE_KEY,
      JSON.stringify({ version: 1, symbol: 'CF-BRTI', drawings }),
    );
    return null;
  } catch {
    return 'Chart drawings could not be saved. The previous drawings were retained.';
  }
}
