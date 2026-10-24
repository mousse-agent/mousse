import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestNightlyTag, nightlyDecision, nightlyVersion, previousStableTag } from './release-version.mjs';

test('nightly versions carry the next stable version, the UTC date and the run number', () => {
  assert.equal(nightlyVersion('0.1.2', new Date('2026-10-21T23:30:00-05:00'), 17), '0.1.2-nightly.20261022.17');
  assert.throws(() => nightlyVersion('0.1.2-nightly.20261022.1', new Date(), 1), /not a plain/);
  assert.throws(() => nightlyVersion('0.1.2', new Date(), undefined), /not a number/);
});

test('the latest nightly is the newest by creation time, ignoring stable releases', () => {
  const releases = [
    { tagName: 'v0.1.3-nightly.20261101.40', createdAt: '2026-11-01T21:00:00Z' },
    { tagName: 'v0.1.2', createdAt: '2026-11-02T10:00:00Z' },
    { tagName: 'v0.1.2-nightly.20261031.39', createdAt: '2026-10-31T21:00:00Z' }
  ];
  assert.equal(latestNightlyTag(releases), 'v0.1.3-nightly.20261101.40');
  assert.equal(latestNightlyTag([{ tagName: 'v0.1.1', createdAt: '2026-08-18T00:00:00Z' }]), undefined);
});

test('a nightly builds only when forced, first, or behind master', () => {
  assert.deepEqual(nightlyDecision({ previous: 'v0.1.2-nightly.20261021.3', aheadBy: 0, force: false }),
    { build: false, reason: 'no new commits since v0.1.2-nightly.20261021.3' });
  assert.equal(nightlyDecision({ previous: 'v0.1.2-nightly.20261021.3', aheadBy: 2, force: false }).build, true);
  assert.equal(nightlyDecision({ previous: 'v0.1.2-nightly.20261021.3', aheadBy: 0, force: true }).build, true);
  assert.equal(nightlyDecision({ previous: undefined, aheadBy: undefined, force: false }).build, true);
});

test('stable notes start at the highest earlier stable tag, by version not by name', () => {
  const tags = ['v0.1.10', 'v0.1.9', 'v0.1.2-nightly.20261022.17', 'v0.2.0', 'v0.1.11'];
  assert.equal(previousStableTag(tags, 'v0.1.11'), 'v0.1.10');
  assert.equal(previousStableTag(tags, 'v0.2.0'), 'v0.1.11');
  assert.equal(previousStableTag(tags, 'v0.1.0'), undefined);
});
