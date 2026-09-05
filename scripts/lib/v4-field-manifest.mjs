const nonNegativeDecimal = /^(?:0|[1-9][0-9]*)$/

const dispositions = new Set(['active', 'history', 'rebuild', 'blocked'])
const timeKinds = new Set([
  'not_time',
  'utc_epoch_ms',
  'utc_datetime',
  'beijing_wall_clock',
  'terminal_wall_clock',
  'business_date',
  'unknown',
])
const reviewStatuses = new Set(['reviewed', 'blocked'])
const defaultKinds = new Set(['null', 'literal', 'expression'])
const zeroCounts = Object.freeze({ tables: 0, columns: 0, blockedColumns: 0 })

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function addError(errors, code, path) {
  errors.push({ code, path: path || '' })
}

function compareStrings(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function finish(errors, counts) {
  const unique = []
  const seen = new Set()
  for (const error of errors) {
    const code = typeof error?.code === 'string' ? error.code : 'field_manifest_unreadable'
    const path = typeof error?.path === 'string' ? error.path : ''
    const key = `${code}\u0000${path}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ code, path })
  }
  unique.sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.code, right.code))
  return {
    ok: unique.length === 0,
    errors: unique,
    counts: {
      tables: Number.isInteger(counts?.tables) && counts.tables >= 0 ? counts.tables : 0,
      columns: Number.isInteger(counts?.columns) && counts.columns >= 0 ? counts.columns : 0,
      blockedColumns: Number.isInteger(counts?.blockedColumns) && counts.blockedColumns >= 0 ? counts.blockedColumns : 0,
    },
  }
}

function countManifest(manifest) {
  if (!isRecord(manifest)) return { ...zeroCounts }
  const tables = Array.isArray(manifest.tables) ? manifest.tables : []
  let columns = 0
  let blockedColumns = 0
  for (const table of tables) {
    if (!isRecord(table) || !Array.isArray(table.fields)) continue
    columns += table.fields.length
    for (const field of table.fields) {
      if (isRecord(field) && field.reviewStatus === 'blocked') blockedColumns += 1
    }
  }
  return { tables: tables.length, columns, blockedColumns }
}

function isTransformVersion(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string' && value.trim().length > 0)
}

function inspectInventory(inventory, errors) {
  const tableByName = new Map()
  if (!isRecord(inventory)) {
    addError(errors, 'field_manifest_inventory_invalid', 'inventory')
    return tableByName
  }

  const sourceTables = inventory.source_tables
  if (!Array.isArray(sourceTables) || sourceTables.length === 0) {
    addError(errors, 'field_manifest_inventory_tables_invalid', 'inventory.source_tables')
    return tableByName
  }

  for (let tableIndex = 0; tableIndex < sourceTables.length; tableIndex += 1) {
    const table = sourceTables[tableIndex]
    const tablePath = `inventory.source_tables[${tableIndex}]`
    if (!isRecord(table)) {
      addError(errors, 'field_manifest_inventory_table_invalid', tablePath)
      continue
    }

    const name = table.name
    const nameValid = isNonEmptyString(name)
    if (!nameValid) addError(errors, 'field_manifest_inventory_table_name_invalid', `${tablePath}.name`)
    if (nameValid && tableByName.has(name)) {
      addError(errors, 'field_manifest_inventory_table_duplicate', `${tablePath}.name`)
      continue
    }

    let columns = []
    let columnsValid = Array.isArray(table.columns)
    if (!columnsValid || table.columns.length === 0) {
      addError(errors, 'field_manifest_inventory_columns_invalid', `${tablePath}.columns`)
      columnsValid = false
    } else {
      const seenColumns = new Set()
      for (let columnIndex = 0; columnIndex < table.columns.length; columnIndex += 1) {
        const column = table.columns[columnIndex]
        const columnPath = `${tablePath}.columns[${columnIndex}]`
        if (!isNonEmptyString(column)) {
          addError(errors, 'field_manifest_inventory_column_invalid', columnPath)
          continue
        }
        if (seenColumns.has(column)) addError(errors, 'field_manifest_inventory_column_duplicate', columnPath)
        seenColumns.add(column)
        columns.push(column)
      }
      if (columns.length !== table.columns.length) columnsValid = false
    }

    let primaryKey = []
    let primaryKeyValid = Array.isArray(table.primary_key)
    if (!primaryKeyValid) {
      addError(errors, 'field_manifest_inventory_primary_key_invalid', `${tablePath}.primary_key`)
    } else {
      const seenPrimaryKey = new Set()
      for (let keyIndex = 0; keyIndex < table.primary_key.length; keyIndex += 1) {
        const keyPart = table.primary_key[keyIndex]
        const keyPath = `${tablePath}.primary_key[${keyIndex}]`
        if (!Array.isArray(keyPart) || keyPart.length !== 2
          || !isNonEmptyString(keyPart[0]) || !isNonEmptyString(keyPart[1])) {
          addError(errors, 'field_manifest_inventory_primary_key_part_invalid', keyPath)
          primaryKeyValid = false
          continue
        }
        if (seenPrimaryKey.has(keyPart[0])) {
          addError(errors, 'field_manifest_inventory_primary_key_duplicate', keyPath)
          primaryKeyValid = false
        }
        if (columnsValid && !columns.includes(keyPart[0])) {
          addError(errors, 'field_manifest_inventory_primary_key_column_unknown', keyPath)
          primaryKeyValid = false
        }
        seenPrimaryKey.add(keyPart[0])
        primaryKey.push(keyPart[0])
      }
    }

    const rowCountValid = typeof table.row_count === 'number'
      && Number.isSafeInteger(table.row_count) && table.row_count >= 0
    if (!rowCountValid) addError(errors, 'field_manifest_inventory_row_count_invalid', `${tablePath}.row_count`)

    if (nameValid) {
      tableByName.set(name, {
        columns,
        columnSet: new Set(columns),
        columnsValid,
        primaryKey,
        primaryKeyValid,
        rowCount: rowCountValid ? table.row_count : null,
        rowCountValid,
      })
    }
  }
  return tableByName
}

function validateDefaultValue(defaultValue, path, errors) {
  if (!isRecord(defaultValue)) {
    addError(errors, 'field_manifest_default_invalid', path)
    return
  }
  const kindValid = defaultKinds.has(defaultValue.kind)
  if (!kindValid) addError(errors, 'field_manifest_default_kind_invalid', `${path}.kind`)

  const valuePresent = hasOwn(defaultValue, 'value')
  if (valuePresent && typeof defaultValue.value !== 'string') {
    addError(errors, 'field_manifest_default_value_invalid', `${path}.value`)
  }
  if (kindValid && defaultValue.kind === 'null' && valuePresent) {
    addError(errors, 'field_manifest_default_value_forbidden', `${path}.value`)
  }
  if (kindValid && defaultValue.kind === 'literal' && !valuePresent) {
    addError(errors, 'field_manifest_default_value_required', `${path}.value`)
  }
  if (kindValid && defaultValue.kind === 'expression'
    && (!valuePresent || (typeof defaultValue.value === 'string' && !isNonEmptyString(defaultValue.value)))) {
    addError(errors, 'field_manifest_default_value_required', `${path}.value`)
  }
}

function validateStringArray(value, path, code, errors, { requiredNonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    addError(errors, code, path)
    return false
  }
  let valid = true
  if (requiredNonEmpty && value.length === 0) {
    addError(errors, code, path)
    valid = false
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!isNonEmptyString(value[index])) {
      addError(errors, code, `${path}[${index}]`)
      valid = false
    }
  }
  return valid
}

function validateField(field, path, errors) {
  if (!isRecord(field)) {
    addError(errors, 'field_manifest_field_invalid', path)
    return {
      path,
      sourceColumn: null,
      sourceColumnValid: false,
      transformId: null,
      transformIdValid: false,
      blockers: [],
      blockersValid: false,
    }
  }

  const sourceColumnValid = isNonEmptyString(field.sourceColumn)
  if (!sourceColumnValid) addError(errors, 'field_manifest_source_column_invalid', `${path}.sourceColumn`)

  if (!isNonEmptyString(field.sourceType)) addError(errors, 'field_manifest_source_type_invalid', `${path}.sourceType`)
  if (field.sourceCollation !== null && typeof field.sourceCollation !== 'string') {
    addError(errors, 'field_manifest_source_collation_invalid', `${path}.sourceCollation`)
  }
  if (typeof field.sourceNullable !== 'boolean') addError(errors, 'field_manifest_source_nullable_invalid', `${path}.sourceNullable`)
  validateDefaultValue(field.sourceDefault, `${path}.sourceDefault`, errors)

  const dispositionValid = dispositions.has(field.disposition)
  if (!dispositionValid) addError(errors, 'field_manifest_disposition_invalid', `${path}.disposition`)
  const targetValid = field.target === null || typeof field.target === 'string'
  if (!targetValid) addError(errors, 'field_manifest_target_invalid', `${path}.target`)
  if (field.disposition === 'active' && !isNonEmptyString(field.target)) {
    addError(errors, 'field_manifest_active_target_missing', `${path}.target`)
  }

  const transformIdValid = isNonEmptyString(field.transformId)
  if (!transformIdValid) addError(errors, 'field_manifest_transform_id_invalid', `${path}.transformId`)

  const timeKindValid = timeKinds.has(field.timeKind)
  if (!timeKindValid) addError(errors, 'field_manifest_time_kind_invalid', `${path}.timeKind`)

  if (!isNonEmptyString(field.nullRule)) addError(errors, 'field_manifest_null_rule_invalid', `${path}.nullRule`)
  if (!isNonEmptyString(field.relationRule)) addError(errors, 'field_manifest_relation_rule_invalid', `${path}.relationRule`)
  const checksValid = validateStringArray(field.checks, `${path}.checks`, 'field_manifest_checks_invalid', errors, { requiredNonEmpty: true })
  const blockersValid = validateStringArray(field.blockers, `${path}.blockers`, 'field_manifest_blockers_invalid', errors)
  validateStringArray(field.evidence, `${path}.evidence`, 'field_manifest_evidence_invalid', errors, { requiredNonEmpty: true })

  const reviewStatusValid = reviewStatuses.has(field.reviewStatus)
  if (!reviewStatusValid) addError(errors, 'field_manifest_review_status_invalid', `${path}.reviewStatus`)

  if (reviewStatusValid && blockersValid && field.reviewStatus === 'reviewed' && field.blockers.length > 0) {
    addError(errors, 'field_manifest_reviewed_has_blockers', `${path}.reviewStatus`)
  }
  if (reviewStatusValid && blockersValid && field.reviewStatus === 'blocked' && field.blockers.length === 0) {
    addError(errors, 'field_manifest_blocked_without_blockers', `${path}.blockers`)
  }
  if (timeKindValid && field.timeKind === 'unknown'
    && (field.reviewStatus !== 'blocked' || !blockersValid || field.blockers.length === 0)) {
    addError(errors, 'field_manifest_unknown_time_unblocked', `${path}.timeKind`)
  }
  if (dispositionValid && field.disposition === 'blocked' && field.reviewStatus !== 'blocked') {
    addError(errors, 'field_manifest_blocked_disposition_unreviewed', `${path}.disposition`)
  }

  return {
    path,
    sourceColumn: sourceColumnValid ? field.sourceColumn : null,
    sourceColumnValid,
    transformId: transformIdValid ? field.transformId : null,
    transformIdValid,
    blockers: blockersValid ? field.blockers : [],
    blockersValid,
    checksValid,
  }
}

function validateManifestTable(table, tableIndex, errors, fieldStates) {
  const path = `tables[${tableIndex}]`
  if (!isRecord(table)) {
    addError(errors, 'field_manifest_table_invalid', path)
    return { sourceTable: null, sourceTableValid: false, sourcePrimaryKey: null, rowCount: null, fields: null }
  }

  const sourceTableValid = isNonEmptyString(table.sourceTable)
  if (!sourceTableValid) addError(errors, 'field_manifest_source_table_invalid', `${path}.sourceTable`)

  let sourcePrimaryKey = null
  if (!Array.isArray(table.sourcePrimaryKey)) {
    addError(errors, 'field_manifest_source_primary_key_invalid', `${path}.sourcePrimaryKey`)
  } else {
    sourcePrimaryKey = []
    const seen = new Set()
    for (let keyIndex = 0; keyIndex < table.sourcePrimaryKey.length; keyIndex += 1) {
      const keyPart = table.sourcePrimaryKey[keyIndex]
      const keyPath = `${path}.sourcePrimaryKey[${keyIndex}]`
      if (!isNonEmptyString(keyPart)) {
        addError(errors, 'field_manifest_source_primary_key_part_invalid', keyPath)
        continue
      }
      if (seen.has(keyPart)) addError(errors, 'field_manifest_source_primary_key_duplicate', keyPath)
      seen.add(keyPart)
      sourcePrimaryKey.push(keyPart)
    }
  }

  const rowCountValid = typeof table.rowCount === 'string' && nonNegativeDecimal.test(table.rowCount)
  if (!rowCountValid) addError(errors, 'field_manifest_row_count_invalid', `${path}.rowCount`)

  let fields = null
  if (!Array.isArray(table.fields)) {
    addError(errors, 'field_manifest_fields_invalid', `${path}.fields`)
  } else {
    fields = []
    for (let fieldIndex = 0; fieldIndex < table.fields.length; fieldIndex += 1) {
      const fieldPath = `${path}.fields[${fieldIndex}]`
      const fieldState = validateField(table.fields[fieldIndex], fieldPath, errors)
      fields.push(fieldState)
      fieldStates.push(fieldState)
    }
  }

  return {
    sourceTable: sourceTableValid ? table.sourceTable : null,
    sourceTableValid,
    sourcePrimaryKey,
    rowCount: rowCountValid ? table.rowCount : null,
    fields,
  }
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function validateFieldCoverage(tableState, tableMeta, tableIndex, errors) {
  if (!tableMeta || !tableMeta.columnsValid || !Array.isArray(tableState.fields)) return
  const tablePath = `tables[${tableIndex}]`
  const seenColumns = new Set()
  for (let fieldIndex = 0; fieldIndex < tableState.fields.length; fieldIndex += 1) {
    const fieldState = tableState.fields[fieldIndex]
    if (!fieldState.sourceColumnValid) continue
    const fieldPath = `${tablePath}.fields[${fieldIndex}]`
    if (seenColumns.has(fieldState.sourceColumn)) {
      addError(errors, 'field_manifest_column_duplicate', `${fieldPath}.sourceColumn`)
    } else {
      seenColumns.add(fieldState.sourceColumn)
    }
    if (!tableMeta.columnSet.has(fieldState.sourceColumn)) {
      addError(errors, 'field_manifest_column_out_of_inventory', `${fieldPath}.sourceColumn`)
    }
  }
  if (tableMeta.columns.some(column => !seenColumns.has(column))) {
    addError(errors, 'field_manifest_column_missing', `${tablePath}.fields`)
  }
}

/**
 * Validate the offline B2 field manifest against a source metadata inventory.
 * This checks shape, coverage, identity and explicit blocking relationships only;
 * it does not prove transform semantics, data correctness or migration readiness.
 */
export function validateFieldManifest(manifest, inventory) {
  let counts = { ...zeroCounts }
  const errors = []
  try {
    counts = countManifest(manifest)
    if (!isRecord(manifest)) {
      addError(errors, 'field_manifest_root_invalid', '')
      return finish(errors, counts)
    }

    if (manifest.schemaVersion !== 1) addError(errors, 'field_manifest_schema_version_invalid', 'schemaVersion')
    if (manifest.stage !== 'B2') addError(errors, 'field_manifest_stage_invalid', 'stage')
    if (manifest.executable === true) addError(errors, 'field_manifest_executable_forbidden', 'executable')
    else if (manifest.executable !== false) addError(errors, 'field_manifest_executable_invalid', 'executable')

    if (!isRecord(manifest.source)) {
      addError(errors, 'field_manifest_source_invalid', 'source')
    } else {
      for (const key of ['logicalSourceId', 'snapshotId', 'mirrorDatabase', 'serverUuid']) {
        if (!isNonEmptyString(manifest.source[key])) addError(errors, 'field_manifest_source_field_invalid', `source.${key}`)
      }
    }

    const scopeTableSet = new Set()
    let scopeTablesValid = Array.isArray(manifest.scopeTables)
    if (!scopeTablesValid || manifest.scopeTables.length === 0) {
      addError(errors, 'field_manifest_scope_tables_invalid', 'scopeTables')
      scopeTablesValid = false
    } else {
      for (let scopeIndex = 0; scopeIndex < manifest.scopeTables.length; scopeIndex += 1) {
        const tableName = manifest.scopeTables[scopeIndex]
        const scopePath = `scopeTables[${scopeIndex}]`
        if (!isNonEmptyString(tableName)) {
          addError(errors, 'field_manifest_scope_table_invalid', scopePath)
          continue
        }
        if (scopeTableSet.has(tableName)) addError(errors, 'field_manifest_scope_table_duplicate', scopePath)
        scopeTableSet.add(tableName)
      }
    }

    const fieldStates = []
    const tableStates = []
    const manifestTableOccurrences = new Map()
    if (!Array.isArray(manifest.tables)) {
      addError(errors, 'field_manifest_tables_invalid', 'tables')
    } else {
      for (let tableIndex = 0; tableIndex < manifest.tables.length; tableIndex += 1) {
        const tableState = validateManifestTable(manifest.tables[tableIndex], tableIndex, errors, fieldStates)
        tableStates.push(tableState)
        if (tableState.sourceTableValid) {
          const previous = manifestTableOccurrences.get(tableState.sourceTable) || []
          previous.push(tableIndex)
          manifestTableOccurrences.set(tableState.sourceTable, previous)
          if (scopeTablesValid && !scopeTableSet.has(tableState.sourceTable)) {
            addError(errors, 'field_manifest_table_out_of_scope', `tables[${tableIndex}].sourceTable`)
          }
        }
      }
    }

    const transformIds = new Set()
    let transformsValid = Array.isArray(manifest.transforms)
    if (!transformsValid) {
      addError(errors, 'field_manifest_transforms_invalid', 'transforms')
    } else {
      for (let transformIndex = 0; transformIndex < manifest.transforms.length; transformIndex += 1) {
        const transform = manifest.transforms[transformIndex]
        const transformPath = `transforms[${transformIndex}]`
        if (!isRecord(transform)) {
          addError(errors, 'field_manifest_transform_invalid', transformPath)
          continue
        }
        const idValid = isNonEmptyString(transform.id)
        if (!idValid) addError(errors, 'field_manifest_transform_id_invalid', `${transformPath}.id`)
        else if (transformIds.has(transform.id)) addError(errors, 'field_manifest_transform_duplicate', `${transformPath}.id`)
        else transformIds.add(transform.id)
        if (!isTransformVersion(transform.version)) addError(errors, 'field_manifest_transform_version_invalid', `${transformPath}.version`)
        if (!isNonEmptyString(transform.rule)) addError(errors, 'field_manifest_transform_rule_invalid', `${transformPath}.rule`)
      }
    }

    const gapIds = new Set()
    if (!Array.isArray(manifest.gaps)) {
      addError(errors, 'field_manifest_gaps_invalid', 'gaps')
    } else {
      for (let gapIndex = 0; gapIndex < manifest.gaps.length; gapIndex += 1) {
        const gap = manifest.gaps[gapIndex]
        const gapPath = `gaps[${gapIndex}]`
        if (!isRecord(gap)) {
          addError(errors, 'field_manifest_gap_invalid', gapPath)
          continue
        }
        const idValid = isNonEmptyString(gap.id)
        if (!idValid) addError(errors, 'field_manifest_gap_id_invalid', `${gapPath}.id`)
        else if (gapIds.has(gap.id)) addError(errors, 'field_manifest_gap_duplicate', `${gapPath}.id`)
        else gapIds.add(gap.id)
        if (!isNonEmptyString(gap.summary)) addError(errors, 'field_manifest_gap_summary_invalid', `${gapPath}.summary`)
      }
    }

    const inventoryTables = inspectInventory(inventory, errors)
    const tableNamesSeen = new Set()
    for (let tableIndex = 0; tableIndex < tableStates.length; tableIndex += 1) {
      const tableState = tableStates[tableIndex]
      if (!tableState.sourceTableValid) continue
      const tablePath = `tables[${tableIndex}]`
      if (tableNamesSeen.has(tableState.sourceTable)) addError(errors, 'field_manifest_table_duplicate', `${tablePath}.sourceTable`)
      tableNamesSeen.add(tableState.sourceTable)

      const tableMeta = inventoryTables.get(tableState.sourceTable)
      if (!tableMeta) {
        addError(errors, 'field_manifest_table_out_of_inventory', `${tablePath}.sourceTable`)
        continue
      }
      if (Array.isArray(tableState.sourcePrimaryKey) && tableMeta.primaryKeyValid
        && !arraysEqual(tableState.sourcePrimaryKey, tableMeta.primaryKey)) {
        addError(errors, 'field_manifest_primary_key_mismatch', `${tablePath}.sourcePrimaryKey`)
      }
      if (typeof tableState.rowCount === 'string' && tableMeta.rowCountValid) {
        try {
          if (BigInt(tableState.rowCount) !== BigInt(tableMeta.rowCount)) {
            addError(errors, 'field_manifest_row_count_mismatch', `${tablePath}.rowCount`)
          }
        } catch {
          addError(errors, 'field_manifest_row_count_invalid', `${tablePath}.rowCount`)
        }
      }
      validateFieldCoverage(tableState, tableMeta, tableIndex, errors)
    }

    if (scopeTablesValid) {
      for (let scopeIndex = 0; scopeIndex < manifest.scopeTables.length; scopeIndex += 1) {
        const tableName = manifest.scopeTables[scopeIndex]
        if (!isNonEmptyString(tableName)) continue
        const tablePath = `scopeTables[${scopeIndex}]`
        if (!inventoryTables.has(tableName)) addError(errors, 'field_manifest_scope_table_out_of_inventory', tablePath)
        const occurrences = manifestTableOccurrences.get(tableName) || []
        if (occurrences.length === 0) addError(errors, 'field_manifest_scope_table_missing', tablePath)
        else if (occurrences.length !== 1) addError(errors, 'field_manifest_scope_table_occurrence_invalid', tablePath)
      }
    }

    for (const fieldState of fieldStates) {
      if (fieldState.transformIdValid && !transformIds.has(fieldState.transformId)) {
        addError(errors, 'field_manifest_transform_unknown', `${fieldState.path || 'tables'}.transformId`)
      }
      if (fieldState.blockersValid) {
        for (let blockerIndex = 0; blockerIndex < fieldState.blockers.length; blockerIndex += 1) {
          if (!gapIds.has(fieldState.blockers[blockerIndex])) {
            addError(errors, 'field_manifest_blocker_gap_unknown', `${fieldState.path || 'tables'}.blockers[${blockerIndex}]`)
          }
        }
      }
    }

    return finish(errors, counts)
  } catch {
    addError(errors, 'field_manifest_unreadable', '')
    return finish(errors, counts)
  }
}
