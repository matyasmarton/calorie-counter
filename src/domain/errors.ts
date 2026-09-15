/**
 * Error types shared by the domain math and the repository boundary.
 *
 * They live in the domain layer so pure functions (`estimateWorkoutCalories`,
 * …) can reject bad input with the same types the repository throws, without
 * the domain importing the storage layer.
 */

/** Input is well-formed but semantically invalid (bad date, missing field, …). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** The referenced row does not exist (or is tombstoned). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
