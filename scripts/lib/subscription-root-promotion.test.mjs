import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { subscriptionRootRenames, subscriptionRootRenameSql, subscriptionRootSnapshot, classifySubscriptionPromotion } from './subscription-root-promotion.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const tables = () => subscriptionRootRenames.map(([name]) => ({ name, ddl: `CREATE TABLE \`${name}\` (id INT)`, rows: 1, rowsSha256: sha(name) }))

test('forward and reverse changes use one ordered rename statement and preserve the old name', () => {
  const forward = subscriptionRootRenameSql(), reverse = subscriptionRootRenameSql({ restore: true })
  assert.ok(forward.startsWith('RENAME TABLE `strategy_subscriptions` TO `strategy_subscriptions_legacy_v3`,'))
  assert.ok(reverse.endsWith('`strategy_subscriptions_legacy_v3` TO `strategy_subscriptions`'))
  assert.equal(forward.split(' TO ').length, 5)
  assert.equal(reverse.split(' TO ').length, 5)
})

test('schema prediction moves FK targets without changing constraint identifiers or comments', () => {
  const fixture = tables()
  fixture.push({ name: 'history', rows: 2, rowsSha256: sha('history'), ddl: "CREATE TABLE `history` (id INT, CONSTRAINT `strategy_subscriptions` FOREIGN KEY(id) REFERENCES `strategy_subscriptions`(id)) COMMENT='keep REFERENCES `strategy_subscriptions`'" })
  const moved = subscriptionRootSnapshot(fixture, { promote: true }).find(row => row.name === 'history')
  assert.equal(moved.ddlSha256, sha("CREATE TABLE `history` (id INT, CONSTRAINT `strategy_subscriptions` FOREIGN KEY(id) REFERENCES `strategy_subscriptions_legacy_v3`(id)) COMMENT='keep REFERENCES `strategy_subscriptions`'"))
  assert.equal(moved.rowsSha256, sha('history'))
})

test('missing source and colliding destination cannot produce a promotion proof', () => {
  assert.throws(() => subscriptionRootSnapshot(tables().slice(1), { promote: true }), { code: 'subscription_promotion_source_missing' })
  const fixture = tables(); fixture.push({ ...fixture[0], name: 'strategy_subscriptions_legacy_v3' })
  assert.throws(() => subscriptionRootSnapshot(fixture, { promote: true }), { code: 'subscription_promotion_name_collision' })
})

test('outcome classification rejects partial schema and row changes instead of requesting blind replay', () => {
  const fixture = tables(), proof = { before: subscriptionRootSnapshot(fixture), after: subscriptionRootSnapshot(fixture, { promote: true }) }
  assert.equal(classifySubscriptionPromotion(proof.before, proof), 'pending')
  assert.equal(classifySubscriptionPromotion(proof.after, proof), 'applied')
  assert.equal(classifySubscriptionPromotion(proof.after.slice(1), proof), 'conflict')
  const changed = structuredClone(proof.after); changed[0].rowsSha256 = sha('changed')
  assert.equal(classifySubscriptionPromotion(changed, proof), 'conflict')
})
