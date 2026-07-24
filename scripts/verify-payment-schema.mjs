import { getDB, queryAll } from '../server/db.js'

const requiredMigrations = [
  '138_payment_money_and_referral_precision',
  '139_durable_payment_side_effects',
]

const requiredColumns = new Map([
  ['notifications.dedupe_key', 'varchar(191)'],
  ['orders.amount', 'decimal(20,8)'],
  ['orders.amount_confirmed', 'decimal(20,8)'],
  ['orders.referral_credit_applied', 'decimal(20,8)'],
  ['referrals.cash_amount', 'decimal(20,8)'],
  ['referrals.commission', 'decimal(20,8)'],
  ['referrals.order_id', 'varchar(100)'],
  ['users.referral_credit', 'decimal(20,8)'],
])

try {
  const migrations = await queryAll(
    'SELECT id FROM schema_migrations WHERE id IN (?, ?) ORDER BY id',
    requiredMigrations
  )
  const columns = await queryAll(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN ('notifications', 'orders', 'referrals', 'users')`)
  const tables = await queryAll(`SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_side_effects'`)

  const applied = new Set(migrations.map(row => row.id))
  const actualColumns = new Map(columns.map(row => [
    `${row.TABLE_NAME}.${row.COLUMN_NAME}`,
    String(row.COLUMN_TYPE || '').toLowerCase(),
  ]))
  const missingMigrations = requiredMigrations.filter(id => !applied.has(id))
  const invalidColumns = [...requiredColumns].filter(([name, type]) => actualColumns.get(name) !== type)
  const paymentSideEffectsPresent = tables.length === 1
  const ok = missingMigrations.length === 0 && invalidColumns.length === 0 && paymentSideEffectsPresent

  console.log(JSON.stringify({
    ok,
    applied_migrations:[...applied],
    payment_side_effects_table:paymentSideEffectsPresent,
    verified_columns:Object.fromEntries([...requiredColumns].map(([name]) => [name, actualColumns.get(name) || null])),
    missing_migrations:missingMigrations,
    invalid_columns:invalidColumns.map(([name, expected]) => ({ name, expected, actual:actualColumns.get(name) || null })),
  }, null, 2))
  if (!ok) process.exitCode = 1
} finally {
  await getDB().end()
}
