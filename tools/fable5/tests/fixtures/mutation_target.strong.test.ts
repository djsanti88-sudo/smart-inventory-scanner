import { describe, expect, it } from 'vitest';

import { isPositive } from './mutation_target';

// STRONG_MUTATION_CHECK tells the offline stub to model these exact assertions.
describe('mutation fixture strong test', () => {
  it('checks behavior on both branches', () => {
    expect(isPositive(1)).toBe(true);
    expect(isPositive(0)).toBe(false);
  });
});
