import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CQT_POSITIONS, cqtLabel, cqtToPositionIndex, positionIndexToCqt } from './cqt.js';

test('maps each of the five discrete positions to its CQT value and back', () => {
  for (let index = 0; index < CQT_POSITIONS.length; index += 1) {
    const cqt = positionIndexToCqt(index);
    assert.equal(cqt, CQT_POSITIONS[index]);
    assert.equal(cqtToPositionIndex(cqt), index);
  }
});

test('an undefined cqt value defaults to the Balanced middle position', () => {
  assert.equal(cqtToPositionIndex(undefined), 2);
  assert.equal(cqtLabel(undefined), 'Balanced');
});

test('an off-scale cqt value falls back to the middle position rather than throwing', () => {
  assert.equal(cqtToPositionIndex(4), 2);
});

test('positionIndexToCqt clamps out-of-range indices', () => {
  assert.equal(positionIndexToCqt(-1), CQT_POSITIONS[0]);
  assert.equal(positionIndexToCqt(99), CQT_POSITIONS[CQT_POSITIONS.length - 1]);
});
