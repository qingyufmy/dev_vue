import { verifySettingsProof, readSettingsUpgradeRows, verifySettingsUpgradeRows } from './lib/inplace-settings-proof.mjs'
import { loadSettingsCoordinator } from './lib/inplace-settings-schema.mjs'
import { verifyWalletAddressProof, readWalletAddressRows } from './lib/inplace-wallet-address-proof.mjs'
import { verifyReferralRuleAuditProof, readReferralRuleAuditRows } from './lib/inplace-referral-rule-audit-proof.mjs'
import { verifyOriginalSchemaWithReferralRules } from './lib/inplace-referral-rule-schema.mjs'
import { verifyReferralRuleProof, readReferralRuleRevisions } from './lib/inplace-referral-rule-proof.mjs'
import { verifyMembershipProof } from './lib/inplace-membership-proof.mjs'
import { readMembershipUpgradeRows, verifyMembershipUpgradeRows } from './lib/inplace-membership-row-guard.mjs'
import { verifyPaymentMatchProof } from './lib/inplace-payment-match-proof.mjs'
import { verifyPaymentOrderProof } from './lib/inplace-payment-order-proof.mjs'
import { verifyReferralLedgerProof } from './lib/inplace-referral-ledger-proof.mjs'
import { verifyReferralSchemaProof } from './lib/inplace-referral-schema-proof.mjs'
import { verifyUserDefaultsProof } from './lib/inplace-user-defaults-proof.mjs'
import { verifyMacroCoordinatorProof } from './lib/inplace-macro-coordinator-proof.mjs'
import { readFile, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyCoordinatorProof } from './lib/inplace-coordinator-proof.mjs'
import { verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnEvidence, readOriginalRows } from './lib/inplace-column-evidence.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection, receipt
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--plan', '--apply'].includes(mode), 'inplace_coordinator_arguments')
  const apply = mode === '--apply'
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const columns = await json('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json')
  validateColumnEvidence(backup, columns)
  const plan = await loadSettingsCoordinator(root)
  const ruleProof = await verifyReferralRuleProof(root)
  const ruleAuditProof = await verifyReferralRuleAuditProof(root)
  const settingsProof = await verifySettingsProof(root)
  const walletProof = await verifyWalletAddressProof(root)
  const baseProof = await verifyCoordinatorProof(root, await json('docs/migration/dev-vue-schema-coordinator-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 29) })
  const macroProof = await verifyMacroCoordinatorProof(root, await json('docs/migration/dev-vue-macro-schema-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 40) })
  const defaultsProof = await verifyUserDefaultsProof(root, await json('docs/migration/dev-vue-user-defaults-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 45) })
  const referralProof = await verifyReferralSchemaProof(root, await json('docs/migration/dev-vue-referral-schema-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 46) })
  const ledgerProof = await verifyReferralLedgerProof(root, await json('docs/migration/dev-vue-referral-ledger-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 47) })
  const paymentOrderProof = await verifyPaymentOrderProof(root, await json('docs/migration/dev-vue-payment-order-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 48) })
  const paymentMatchProof = await verifyPaymentMatchProof(root, await json('docs/migration/dev-vue-payment-match-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 50) })
  const membershipProof = await verifyMembershipProof(root, await json('docs/migration/dev-vue-membership-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 51) })
  const proof = { settings: settingsProof, walletAddresses: walletProof, referralRuleAudit: ruleAuditProof, referralRules: ruleProof, base: baseProof, macro: macroProof, userDefaults: defaultsProof, referral: referralProof, ledger: ledgerProof, paymentOrders: paymentOrderProof, paymentMatches: paymentMatchProof, memberships: membershipProof }
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'inplace_coordinator_database')
  // Reserve an exclusive receipt before any database mutation. Failed attempts remain inspectable.
  const receiptPath = `docs/migration/dev-vue-schema-upgrade-${randomUUID()}.json`
  if (apply) receipt = await open(new URL(receiptPath, root), 'wx', 0o600)
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', timezone: 'Z', dateStrings: true, jsonStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'inplace_coordinator_instance')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET SESSION lock_wait_timeout=10')
  let ddlExecutions = 0, journalWrites = 0
  const result = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    check(await verifyInplaceJournal(connection), 'inplace_coordinator_journal_required')
    const excluded = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
    const readReferrals = async () => { const [[table]] = await connection.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_referral_accounts'"); if (Number(table.n) === 0) return null; const [rows] = await connection.query('SELECT user_id,referral_code,referred_by_code,referral_credit,revision,updated_at_utc FROM user_referral_accounts ORDER BY user_id'); return sha256(JSON.stringify(rows)) }
    const referralHash = await readReferrals()
    const readLedger = async () => { const [[table]] = await connection.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='referral_credit_ledger'"); if (Number(table.n) === 0) return null; const [rows] = await connection.query('SELECT user_id,account_revision,event_kind,source_key,previous_balance,delta,resulting_balance,migration_run_id,source_sha256,recorded_at_utc FROM referral_credit_ledger ORDER BY user_id,account_revision'); return sha256(JSON.stringify(rows)) }
    const ledgerHash = await readLedger()
    const readOrders = async () => { const [[table]] = await connection.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_orders'"); if (Number(table.n) === 0) return null; const [rows] = await connection.query('SELECT id,user_id,order_number,external_order_id,product_code,product_label,billing_period_code,billing_period_label,order_amount,legacy_amount_confirmed,referral_credit_applied,currency_code,status,status_label,payment_method_code,created_at_utc,paid_at_utc,revision,origin,legacy_order_id,migration_run_id,source_sha256,imported_at_utc FROM payment_orders ORDER BY id'); return sha256(JSON.stringify(rows)) }
    const orderHash = await readOrders()
    const protectedRows = await readMembershipUpgradeRows(connection)
    const ruleRevisions = await readReferralRuleRevisions(connection)
    const ruleAuditRows = await readReferralRuleAuditRows(connection)
    const settingsRows = await readSettingsUpgradeRows(connection)
    const walletRows = await readWalletAddressRows(connection)
    const verifyOriginal = async () => {
      verifySettingsUpgradeRows(settingsRows, await readSettingsUpgradeRows(connection))
      verifyMembershipUpgradeRows(protectedRows, await readMembershipUpgradeRows(connection))
      if (orderHash !== null) check(await readOrders() === orderHash, 'inplace_coordinator_orders_changed')
      if (ledgerHash !== null) check(await readLedger() === ledgerHash, 'inplace_coordinator_ledger_changed')
      if (referralHash !== null) check(await readReferrals() === referralHash, 'inplace_coordinator_referrals_changed')
      await verifyOriginalSchemaWithReferralRules(connection, backup.schemaSha256, excluded, plan.referralRuleReference)
      const currentWallets = await readWalletAddressRows(connection)
      if (walletRows !== null) check(JSON.stringify(currentWallets) === JSON.stringify(walletRows), 'inplace_wallet_rows_changed')
      else if (currentWallets !== null) check(currentWallets.rows === 0, 'inplace_wallet_not_empty')
      const auditRows = await readReferralRuleAuditRows(connection)
      if (ruleAuditRows !== null) check(JSON.stringify(auditRows) === JSON.stringify(ruleAuditRows), 'inplace_rule_audit_rows_changed')
      else if (auditRows !== null) check(auditRows.rows === 0, 'inplace_rule_audit_not_empty')
      const revisions = await readReferralRuleRevisions(connection)
      if (ruleRevisions !== null) check(JSON.stringify(revisions) === JSON.stringify(ruleRevisions), 'inplace_rule_revisions_changed')
      else if (revisions !== null) check(revisions.length === 4 && revisions.every(row => row.revision === '1'), 'inplace_rule_revision_initialization')
      check(JSON.stringify(await readOriginalRows(connection, columns.originalColumns)) === JSON.stringify(columns.parity), 'inplace_coordinator_original_changed')
    }
    const store = plan.store(connection)
    for (const method of ['execute', 'begin', 'complete']) {
      const original = store[method]
      store[method] = async (...args) => {
        check(apply, 'inplace_coordinator_read_only')
        await original(...args)
        if (method === 'execute') ddlExecutions++; else journalWrites++
      }
    }
    await verifyOriginal()
    const preview = await coordinateInplaceSchema(store, plan)
    if (!apply) return preview
    const applied = await coordinateInplaceSchema(store, plan, { apply: true })
    const repeated = await coordinateInplaceSchema(store, plan, { apply: true })
    check(repeated.steps.every(row => row.status === 'completed'), 'inplace_coordinator_repeat_failed')
    await verifyOriginal()
    return applied
  })
  const report = { kind: 'dev-vue-schema-upgrade/v12', status: apply ? 'verified' : 'planned', identity, proof,
    completedAtUtc: new Date().toISOString(), result, ddlExecutions, journalWrites, originalTables: columns.parity.length,
    originalRows: backup.parity.rows, originalParityHash: sha256(JSON.stringify(columns.parity)),
    repeatNoop: apply, businessRowsWritten: false, fullNormalizationComplete: false }
  if (receipt) { await receipt.writeFile(JSON.stringify(report, null, 2) + '\n'); await receipt.sync() }
  console.log(JSON.stringify({ ...report, ...(apply ? { receiptPath } : {}) }))
} catch (error) {
  const failure = { status: 'failed', code: /^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_coordinator_upgrade_failed' }
  if (receipt) await receipt.writeFile(JSON.stringify(failure) + '\n').catch(() => {})
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { await receipt?.close(); if (connection) await connection.end().catch(() => {}) }
