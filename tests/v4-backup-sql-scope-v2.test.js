import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BackupSqlScopeError, inspectBackupSql } from '../scripts/lib/v4-backup-sql-scope-v2.mjs'

const tables = [
  { name: 'users', columns: [{ name: 'id' }, { name: 'display_name' }, { name: 'payload' }] },
  { name: 'user_notes', columns: [{ name: 'id' }, { name: 'user_id' }, { name: 'note' }] },
]

const literalShapeTables = [
  { name: 'users', columns: [{ name: 'id' }, { name: 'display_name' }, { name: 'payload' }, { name: 'created_at' }] },
  { name: 'user_notes', columns: [{ name: 'id' }, { name: 'user_id' }, { name: 'note' }] },
]

function dump({ users = [], notes = [], header = true, footer = true } = {}) {
  const statements = []
  if (header) statements.push(
    '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
    '/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;',
    '/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;',
    '/*!50503 SET NAMES utf8mb4 */;',
    '/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;',
    "/*!40103 SET TIME_ZONE='+00:00' */;",
    '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;',
    '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
    "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
    '/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;',
    'SET autocommit=0;',
  )
  statements.push(
    'CREATE TABLE `users` (`id` bigint NOT NULL, `display_name` varchar(100), `payload` blob, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
    'CREATE TABLE `user_notes` (`id` bigint NOT NULL, `user_id` bigint, `note` text, CONSTRAINT `fk_note_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)) ENGINE=InnoDB;',
  )
  for (const [id, name, payload] of users) {
    statements.push(`INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (${id},'${name}',${payload});`)
  }
  for (const [id, userId, note] of notes) {
    statements.push(`INSERT INTO \`user_notes\` (\`id\`,\`user_id\`,\`note\`) VALUES (${id},${userId},'${note}');`)
  }
  if (footer) statements.push(
    'COMMIT;',
    '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;',
    '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;',
    '/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;',
    '/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;',
    '/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;',
    '/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;',
    '/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;',
    '/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;',
  )
  return `${statements.join('\n')}\n`
}

async function *chunks(value, size = 7) {
  const source = Buffer.from(value, 'utf8')
  for (let index = 0; index < source.length; index += size) yield source.subarray(index, Math.min(index + size, source.length))
}

async function review(sql, options = {}) {
  return inspectBackupSql(chunks(sql), { tables, ...options })
}

async function reviewWithTables(sql, tableMetadata, options = {}) {
  return inspectBackupSql(chunks(sql), { tables: tableMetadata, ...options })
}

async function expectCode(sql, code, options = {}) {
  await expect(review(sql, options)).rejects.toSatisfy(error => error instanceof BackupSqlScopeError && error.code === code)
}

async function expectCodeWithTables(sql, tableMetadata, code, options = {}) {
  await expect(reviewWithTables(sql, tableMetadata, options)).rejects.toSatisfy(
    error => error instanceof BackupSqlScopeError && error.code === code,
  )
}

describe('bounded mysqldump SQL scope review', () => {
  it('accepts a common dump header/footer and returns exact row counts and hashes', async () => {
    const sql = dump({ users: [[1, 'Alice', '0x00ff'], [2, 'Bob', '0x1234']], notes: [[1, 1, 'hello']] })
    const result = await review(sql)
    const userInsert = 'INSERT INTO `users` (`id`,`display_name`,`payload`) VALUES (1,\'Alice\',0x00ff);\n'
      + 'INSERT INTO `users` (`id`,`display_name`,`payload`) VALUES (2,\'Bob\',0x1234);\n'
    const noteInsert = 'INSERT INTO `user_notes` (`id`,`user_id`,`note`) VALUES (1,1,\'hello\');\n'
    expect(result.kind).toBe('v4_backup_sql_review/v2')
    expect(result.tables).toEqual([
      { name: 'users', rows: '2', dataSha256: createHash('sha256').update(userInsert).digest('hex') },
      { name: 'user_notes', rows: '1', dataSha256: createHash('sha256').update(noteInsert).digest('hex') },
    ])
    expect(result.statementCount).toBe(25)
    expect(JSON.stringify(result)).not.toContain('Alice')
  })

  it('handles quotes, escaped delimiters, newlines, comments, and chunk boundaries lexically', async () => {
    const sql = [
      'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;',
      'CREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;',
      "INSERT INTO `users` (`id`, `display_name`, `payload`) VALUES (1, 'semi; -- not SQL /* no */', _binary 'line\\nnext'); /* trailing ; DROP TABLE users */",
      "INSERT INTO `user_notes` (`id`, `user_id`, `note`) VALUES (1, 1, 'double '' quote; and \\\\'); -- comment;\n",
    ].join('\n')
    const result = await review(sql, { maxStatementBytes: 4096 })
    expect(result.tables.map(table => table.rows)).toEqual(['1', '1'])
  })

  it.each([
    ['USE `dev_vue`;', 'backup_sql_statement_forbidden'],
    ['CREATE DATABASE `evil`;', 'backup_sql_object_forbidden'],
    ['DROP TABLE `users`;', 'backup_sql_statement_forbidden'],
    ['SET GLOBAL sql_mode = \'\';', 'backup_sql_global_scope_forbidden'],
    ['GRANT ALL ON *.* TO \'x\';', 'backup_sql_statement_forbidden'],
    ['LOAD DATA INFILE \'x\' INTO TABLE `users`;', 'backup_sql_statement_forbidden'],
    ['CALL dangerous();', 'backup_sql_statement_forbidden'],
    ['DELIMITER $$;', 'backup_sql_client_command'],
    ['\\. other.sql;', 'backup_sql_client_command'],
    ['CREATE TRIGGER `t` BEFORE INSERT ON `users` FOR EACH ROW SET @x=1;', 'backup_sql_object_forbidden'],
    ['CREATE PROCEDURE `p`() SELECT 1;', 'backup_sql_object_forbidden'],
    ['CREATE EVENT `e` ON SCHEDULE EVERY 1 DAY DO SELECT 1;', 'backup_sql_object_forbidden'],
  ])('rejects forbidden statement %s', async (statement, code) => {
    const sql = `${statement}\nCREATE TABLE \`users\` (\`id\` int, \`display_name\` text, \`payload\` blob) ENGINE=InnoDB;\nCREATE TABLE \`user_notes\` (\`id\` int, \`user_id\` int, \`note\` text) ENGINE=InnoDB;`
    await expectCode(sql, code)
  })

  it('rejects hidden executable-comment injection and qualified schema names', async () => {
    await expectCode('/*!40101 SET NAMES utf8mb4; DROP TABLE `users` */;', 'backup_sql_statement_forbidden')
    await expectCode('CREATE TABLE `dev_vue`.`users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;', 'backup_sql_cross_schema_identifier')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\nINSERT INTO `dev_vue`.`users` (`id`,`display_name`,`payload`) VALUES (1,\'x\',0x00);', 'backup_sql_cross_schema_identifier')
  })

  it('rejects multi-row inserts, suffix expressions, functions, and unsafe DDL', async () => {
    const prefix = 'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\n'
    await expectCode(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',0x00),(2,'y',0x01);`, 'backup_sql_multirow_insert')
    await expectCode(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',0x00) ON DUPLICATE KEY UPDATE \`id\`=2;`, 'backup_sql_insert_suffix_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int DEFAULT uuid(), `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;', 'backup_sql_function_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=MyISAM;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;', 'backup_sql_engine_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) DATA DIRECTORY=\'/tmp\' ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;', 'backup_sql_ddl_option_forbidden')
    await expectCode(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',X'abc');`, 'backup_sql_insert_values_invalid')
    await expectCode(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',0X00);`, 'backup_sql_insert_values_invalid')
    const emptyHex = await review(`${prefix}INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'x',X'');`)
    expect(emptyHex.tables[0].rows).toBe('1')
  })

  it('accepts mysqldump character-set save/restore and common DDL literal shapes', async () => {
    const sql = [
      '/*!40101 SET @saved_cs_client     = @@character_set_client */;',
      '/*!50503 SET character_set_client = utf8mb4 */;',
      'CREATE TABLE `users` (`id` bigint, `display_name` varchar(100), `payload` blob, `created_at` datetime(3), KEY `idx_name` (`display_name`(12)), CONSTRAINT `fk_self` FOREIGN KEY (`id`) REFERENCES `users` (`id`), CHECK (json_valid(`payload`))) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT=\'safe ) comment\';',
      'CREATE TABLE `user_notes` (`id` bigint, `user_id` bigint, `note` text, KEY `idx_user` (`user_id`(4))) ENGINE=InnoDB;',
      '/*!40101 SET character_set_client = @saved_cs_client */;',
    ].join('\n')
    const result = await inspectBackupSql(chunks(sql), { tables: literalShapeTables })
    expect(result.tables.every(table => table.rows === '0')).toBe(true)
  })

  it('derives generated-column omissions from frozen DDL, including nested CASE expressions', async () => {
    const generatedTables = [
      { name: 'ai_model_profiles', columns: ['id', 'is_default', 'status', 'deleted_at', 'owner_user_id', 'active_default_owner_key'].map(name => ({ name })) },
      { name: 'strategy_subscriptions', columns: ['id', 'execution_enabled', 'is_deleted', 'user_id', 'active_execution_user_key'].map(name => ({ name })) },
    ]
    const sql = [
      'CREATE TABLE `ai_model_profiles` (`id` int, `is_default` int, `status` varchar(32), `deleted_at` datetime(3), `owner_user_id` int, `active_default_owner_key` int GENERATED ALWAYS AS ((case when ((`is_default` = 1) and (`status` = _utf8mb4\'active\') and (`deleted_at` is null)) then `owner_user_id` else NULL end)) STORED /*!80023 INVISIBLE */) ENGINE=InnoDB;',
      'CREATE TABLE `strategy_subscriptions` (`id` int, `execution_enabled` int, `is_deleted` int, `user_id` int, `active_execution_user_key` int GENERATED ALWAYS AS ((case when ((`execution_enabled` = 1) and (`is_deleted` = 0)) then `user_id` else NULL end)) STORED /*!80023 INVISIBLE */) ENGINE=InnoDB;',
      'INSERT INTO `ai_model_profiles` (`id`,`is_default`,`status`,`deleted_at`,`owner_user_id`) VALUES (1,1,\'active\',NULL,7);',
      'INSERT INTO `strategy_subscriptions` (`id`,`execution_enabled`,`is_deleted`,`user_id`) VALUES (1,1,0,7);',
    ].join('\n')
    const result = await reviewWithTables(sql, generatedTables)
    expect(result.tables.map(table => table.rows)).toEqual(['1', '1'])
  })

  it('accepts a visible virtual generated column but requires ordinary invisible columns', async () => {
    const metadata = [{ name: 'virtual_demo', columns: ['id', 'status', 'hidden_value', 'virtual_key'].map(name => ({ name })) }]
    const ddl = 'CREATE TABLE `virtual_demo` (`id` int, `status` int, `hidden_value` int INVISIBLE, `virtual_key` int AS ((case when (`status` in (1,2)) then (`id`) else NULL end)) VIRTUAL VISIBLE) ENGINE=InnoDB;'
    const accepted = `${ddl}\nINSERT INTO \`virtual_demo\` (\`id\`,\`status\`,\`hidden_value\`) VALUES (1,1,9);`
    const result = await reviewWithTables(accepted, metadata)
    expect(result.tables[0].rows).toBe('1')
    await expectCodeWithTables(`${ddl}\nINSERT INTO \`virtual_demo\` (\`id\`,\`status\`) VALUES (1,1);`, metadata, 'backup_sql_insert_columns_invalid')
    await expectCodeWithTables(`${ddl}\nINSERT INTO \`virtual_demo\` (\`id\`,\`hidden_value\`,\`status\`) VALUES (1,9,1);`, metadata, 'backup_sql_insert_columns_invalid')
    await expectCodeWithTables(`${ddl}\nINSERT INTO \`virtual_demo\` (\`id\`,\`status\`,\`hidden_value\`,\`virtual_key\`) VALUES (1,1,9,1);`, metadata, 'backup_sql_insert_columns_invalid')
  })

  it('rejects CREATE DDL whose column names do not match frozen metadata', async () => {
    const metadata = [{ name: 'ddl_binding_demo', columns: [{ name: 'id' }, { name: 'payload' }] }]
    await expectCodeWithTables('CREATE TABLE `ddl_binding_demo` (`id` int, `payload` text, `extra` int) ENGINE=InnoDB;', metadata, 'backup_sql_create_columns_invalid')
    await expectCodeWithTables('CREATE TABLE `ddl_binding_demo` (`id` int) ENGINE=InnoDB;', metadata, 'backup_sql_create_columns_invalid')
    await expectCodeWithTables('CREATE TABLE `ddl_binding_demo` (`payload` text, `id` int) ENGINE=InnoDB;', metadata, 'backup_sql_create_columns_invalid')
  })

  it('does not treat parenthesized defaults as generated columns', async () => {
    const metadata = [{ name: 'default_demo', columns: [{ name: 'id' }, { name: 'defaulted' }, { name: 'hidden_value' }] }]
    const ddl = 'CREATE TABLE `default_demo` (`id` int, `defaulted` int DEFAULT (1 + 2), `hidden_value` int INVISIBLE) ENGINE=InnoDB;'
    const accepted = `${ddl}\nINSERT INTO \`default_demo\` (\`id\`,\`defaulted\`,\`hidden_value\`) VALUES (1,3,9);`
    const result = await reviewWithTables(accepted, metadata)
    expect(result.tables[0].rows).toBe('1')
    await expectCodeWithTables(`${ddl}\nINSERT INTO \`default_demo\` (\`id\`,\`hidden_value\`) VALUES (1,9);`, metadata, 'backup_sql_insert_columns_invalid')
  })

  it.each([
    ['nested unknown function', 'int AS ((CASE WHEN (`id` = evil((1))) THEN `id` ELSE NULL END)) VIRTUAL', 'backup_sql_function_forbidden'],
    ['quoted unknown function', 'int AS ((`evil`((1)))) VIRTUAL', 'backup_sql_function_forbidden'],
    ['qualified reference', 'int AS ((dev_vue.`evil`((1)))) VIRTUAL', 'backup_sql_cross_schema_identifier'],
    ['keyword-shaped function', 'int AS ((CASE WHEN (1) THEN WHEN(2) ELSE NULL END)) VIRTUAL', 'backup_sql_function_forbidden'],
  ])('rejects %s in generated/default expressions', async (_label, expression, code) => {
    const metadata = [{ name: 'expression_demo', columns: [{ name: 'id' }, { name: 'derived' }] }]
    const ddl = `CREATE TABLE \`expression_demo\` (\`id\` int, \`derived\` ${expression}) ENGINE=InnoDB;`
    await expectCodeWithTables(`${ddl}\nINSERT INTO \`expression_demo\` (\`id\`) VALUES (1);`, metadata, code)
  })

  it('rejects SELECT-shaped CREATE statements and quoted identifier calls', async () => {
    const prefix = 'CREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\n'
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB SELECT 1;\n' + prefix, 'backup_sql_create_as_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int DEFAULT (`evil`()), `display_name` text, `payload` blob) ENGINE=InnoDB;\n' + prefix, 'backup_sql_function_forbidden')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob, CHECK ((`id` > 0)), KEY `idx_name` ((`evil`())) ) ENGINE=InnoDB;\n' + prefix, 'backup_sql_function_forbidden')
    const nestedCheck = await review('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob, CHECK ((json_valid(`payload`)))) ENGINE=InnoDB;\n' + prefix)
    expect(nestedCheck.tables.every(table => table.rows === '0')).toBe(true)
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob);\n' + prefix, 'backup_sql_engine_invalid')
  })

  it('rejects unknown, duplicate, or missing tables and incorrect complete columns', async () => {
    await expectCode('CREATE TABLE `unknown` (`id` int);', 'backup_sql_unknown_table')
    const one = 'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\n'
    await expectCode(`${one}${one}CREATE TABLE \`user_notes\` (\`id\` int, \`user_id\` int, \`note\` text) ENGINE=InnoDB;`, 'backup_sql_duplicate_table')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;', 'backup_sql_missing_table')
    await expectCode('CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\nINSERT INTO `users` (`display_name`,`id`,`payload`) VALUES (\'x\',1,0x00);', 'backup_sql_insert_columns_invalid')
  })

  it('does not include table-name comments in the per-table INSERT digest', async () => {
    const prefix = 'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;\n'
    const insert = "INSERT INTO `users` (`id`,`display_name`,`payload`) VALUES (1,'x',0x00);"
    const first = await review(`${prefix}-- Dumping data for table \`source_name\`\n${insert}`)
    const second = await review(`${prefix}-- Dumping data for table \`restored_name\`\n${insert}`)
    expect(first.tables[0].dataSha256).toBe(second.tables[0].dataSha256)
  })

  it('enforces stream, statement, UTF-8, and termination bounds without SQL in errors', async () => {
    const valid = 'CREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB;\nCREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;'
    await expectCode(valid.slice(0, -1), 'backup_sql_truncated')
    await expectCode(`${valid}\nINSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'long value',0x00);`, 'backup_sql_too_large', { maxBytes: Buffer.byteLength(valid) })
    await expectCode(`${valid}\nINSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'this is too long',0x00);`, 'backup_sql_statement_too_large', { maxStatementBytes: 20 })
    await expectCode(Buffer.from([...Buffer.from(valid), 0xff]), 'backup_sql_invalid_utf8')
    const result = await inspectBackupSql(chunks(`${valid}\n`, 1), { tables, maxBytes: Buffer.byteLength(`${valid}\n`) })
    expect(result.tables.every(table => table.rows === '0')).toBe(true)
    await expectCode('DELIMITER $$\nCREATE TABLE `users` (`id` int, `display_name` text, `payload` blob) ENGINE=InnoDB$$', 'backup_sql_client_command')
  })

  it('streams a 10 MiB non-sensitive literal within the statement bound', async () => {
    const body = 'a'.repeat(10 * 1024 * 1024)
    const sql = [
      'CREATE TABLE `users` (`id` int, `display_name` longtext, `payload` blob) ENGINE=InnoDB;',
      'CREATE TABLE `user_notes` (`id` int, `user_id` int, `note` text) ENGINE=InnoDB;',
      `INSERT INTO \`users\` (\`id\`,\`display_name\`,\`payload\`) VALUES (1,'${body}',X'');`,
    ].join('\n')
    const started = Date.now()
    const result = await inspectBackupSql(chunks(sql, 64 * 1024), { tables, maxStatementBytes: 12 * 1024 * 1024 })
    expect(result.tables[0].rows).toBe('1')
    expect(result.tables[1].rows).toBe('0')
    expect(Date.now() - started).toBeLessThan(15000)
  })
})

// Same security regression corpus as the frozen v1, plus current CHECK grammar.
describe('current-schema deterministic expressions', () => {
  const schema = expression => 'CREATE TABLE `users` (`id` bigint, `display_name` varchar(100), `payload` blob, CHECK (' + expression + ')) ENGINE=InnoDB;\n'
    + 'CREATE TABLE `user_notes` (`id` bigint, `user_id` bigint, `note` text) ENGINE=InnoDB;'
  it.each([
    'char_length(`display_name`) > 0', 'cast(`id` AS CHAR) IS NOT NULL',
    "concat(`display_name`,'suffix') IS NOT NULL", 'convert(`display_name` USING utf8mb4) IS NOT NULL',
    "coalesce(`display_name`,'') IS NOT NULL", 'length(`payload`) >= 0',
    'trim(`display_name`) IS NOT NULL', "regexp_like(`display_name`,'^[a-z]+$','c')",
    "json_type(`payload`) = 'OBJECT'", "json_contains_path(`payload`,'one','$.field')",
    "(not(regexp_like(`display_name`,'[^a-z]','c')))",
  ])('accepts explicit expression %s', async expression => { await review(schema(expression)) })
  it.each([
    'sleep(1)', 'benchmark(1,md5(1))', "load_file('/etc/passwd')",
    "concat('safe',evil(1))", "regexp_like(`display_name`,evil(1))",
    '\`char_length\`(`display_name`)', 'evil.not(`id`)',
  ])('rejects dangerous or disguised expression %s', async expression => {
    await expect(review(schema(expression))).rejects.toBeInstanceOf(BackupSqlScopeError)
  })
})
