/** Invalid, conflicting and future observations never become index history or settlement data. */
export const getBenchmarkReadings = (benchmark, now) => {
  const readings = new Map();
  const conflicts = new Set();
  const samples = Array.isArray(benchmark?.samples) ? benchmark.samples : [];
  for (const sample of [...samples, benchmark?.current]) {
    if (
      !sample ||
      !Number.isSafeInteger(sample.time) ||
      sample.time < 0 ||
      sample.time > now ||
      typeof sample.price !== 'number' ||
      !Number.isFinite(sample.price) ||
      sample.price <= 0
    )
      continue;
    const previous = readings.get(sample.time);
    if (previous && previous.price !== sample.price) conflicts.add(sample.time);
    readings.set(sample.time, { time: sample.time, price: sample.price });
  }
  return [...readings.values()]
    .filter((sample) => !conflicts.has(sample.time))
    .sort((left, right) => left.time - right.time);
};
