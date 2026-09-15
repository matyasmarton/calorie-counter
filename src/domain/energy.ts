/**
 * Energy balance — intake minus burn. Kept as its own module so the sign
 * convention (positive net = surplus, negative = deficit) is defined once
 * and shared by every aggregation path and screen.
 */

/** Calorie totals are non-negative whole numbers by construction. */
function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} calories must be a finite, non-negative number (got ${value})`);
  }
}

export interface EnergyBalance {
  /** Calories burned (activity + workouts). */
  burn: number;
  /** intake − burn: positive = surplus, negative = deficit. */
  net: number;
}

/** Validated `intake − burn`. Rejects non-finite or negative totals. */
export function netEnergy(intakeCalories: number, burnCalories: number): EnergyBalance {
  assertNonNegative(intakeCalories, 'intake');
  assertNonNegative(burnCalories, 'burn');
  return { burn: burnCalories, net: intakeCalories - burnCalories };
}
