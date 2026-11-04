export const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
export const isPositiveNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
export const isProbability = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export const isIdentifier = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128;

export const FORECAST_DURATION_MS = 15 * 60 * 1000;

export const hasOwnField = (value, field) => Object.prototype.hasOwnProperty.call(value, field);

export function hasExactFields(value, fields) {
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => hasOwnField(value, field))
  );
}
