export const createAdvancingClock = (epoch) => {
  const startedAt = performance.now();
  const read = () => epoch + Math.floor(performance.now() - startedAt);
  return {
    read,
    resume: () => jest.spyOn(Date, 'now').mockImplementation(read),
  };
};
