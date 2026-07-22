import { describe, expect, it } from 'vitest';

import { isPositive } from './mutation_target';

describe('mutation fixture weak test', () => {
  it('only checks return types', () => {
    expect(typeof isPositive(1)).toBe('boolean');
  });
});
