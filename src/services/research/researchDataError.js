export class ResearchDataError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ResearchDataError';
    this.status = status;
  }
}
