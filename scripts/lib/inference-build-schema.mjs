import assert from 'node:assert/strict'
import { sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
export const inferenceBuildNames=Object.freeze(['inference_snapshots','inference_snapshot_payloads','ai_model_tasks','ai_model_attempts',
  'ai_analysis_runs','market_analyses','market_analysis_payloads','ai_trader_runs','trade_decisions','trade_decision_payloads',
  'risk_decisions_v4','risk_decision_payloads_v4'])
export const inferenceBuildMapping=Object.freeze(Object.fromEntries(inferenceBuildNames.map(name=>[name,`${name.endsWith('_v4')?name:name+'_v4'}_build`]).concat([
  ['strategy_subscriptions','strategy_subscriptions_v4_build']])))
const external=new Set(['users','trading_accounts','strategies','strategy_versions','risk_policy_versions_v4'])
/** Only structural identifiers are rewritten; literals, comments and index/column names remain byte-identical. */
export function inferenceBuildDefinition(name,ddl){
  assert.ok(inferenceBuildNames.includes(name) && ddl.startsWith('CREATE TABLE `'+name+'` ('))
  return ddl.replace(/'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|\/\*[\s\S]*?\*\/|--[^\r\n]*|#[^\r\n]*|(CREATE TABLE |REFERENCES |CONSTRAINT )`([a-z][a-z0-9_]*)`|`(?:``|[^`])*`/g,
    (full,prefix,identifier)=>{
      if(!prefix)return full
      if(prefix==='CONSTRAINT ')return `CONSTRAINT \`build_inf_${sha256(identifier).slice(0,24)}\``
      if(prefix==='REFERENCES ')assert.ok(Object.hasOwn(inferenceBuildMapping,identifier)||external.has(identifier),'inference_build_parent_unreviewed')
      return Object.hasOwn(inferenceBuildMapping,identifier)?`${prefix}\`${inferenceBuildMapping[identifier]}\``:full
    })
}
/** MySQL sorts renamed constraints. Compare their full definitions in planned order. */
export function inferenceBuildObservedHash(actual,planned){
  const names=[...planned.matchAll(/^  CONSTRAINT `([^`]+)`/gm)].map(m=>m[1])
  const lines=actual.split('\n'),constraints=lines.filter(line=>/^  CONSTRAINT `/.test(line))
  const found=constraints.map(line=>/^  CONSTRAINT `([^`]+)`/.exec(line)[1])
  assert.ok(new Set(found).size===found.length && found.length===names.length && found.every(name=>names.includes(name)))
  const ordered=constraints.sort((a,b)=>names.indexOf(/^  CONSTRAINT `([^`]+)`/.exec(a)[1])-names.indexOf(/^  CONSTRAINT `([^`]+)`/.exec(b)[1]))
  let index=0
  return tableDefinitionHash(lines.map(line=>/^  CONSTRAINT `/.test(line)?ordered[index++].replace(/,$/,'')+(line.endsWith(',')?',':''):line).join('\n'))
}

/** Defer only forward foreign keys, restoring every original constraint after all tables exist. */
export function inferenceBuildPhases(definitions){
  assert.deepEqual(definitions.map(row=>row.name),inferenceBuildNames)
  const created=new Set(),creates=[],deferred=[]
  for(const {name,sql}of definitions){
    const buildName=inferenceBuildMapping[name]
    const lines=sql.split('\n'),kept=[]
    for(const line of lines){
      const fk=/^  (CONSTRAINT `[^`]+` FOREIGN KEY .* REFERENCES `([^`]+)`.*?)(,?)$/.exec(line)
      if(fk && Object.values(inferenceBuildMapping).includes(fk[2]) && fk[2]!=='strategy_subscriptions_v4_build' && fk[2]!==buildName && !created.has(fk[2])){
        deferred.push({table:buildName,sql:`ALTER TABLE \`${buildName}\` ADD ${fk[1]}`})
      }else kept.push(line)
    }
    creates.push({table:buildName,sql:kept.join('\n').replace(/,\n\)/g,'\n)')});created.add(buildName)
  }
  return {creates,deferred}
}

export function assertInferenceBuildParents(inventory,requirements){
  assert.ok(inventory?.passed && inventory.writes===0 && inventory.target==='dev_vue' && inventory.completedSteps===191 && inventory.startedSteps.length===0)
  assert.ok(Array.isArray(requirements) && requirements.length>0)
  for(const requirement of requirements){
    const table=inventory.tables[requirement.table],column=table?.columns?.find(c=>c.name===requirement.column)
    assert.ok(table?.exists && column,'inference_build_parent_missing')
    assert.ok(column.type===requirement.type && column.collation===requirement.collation && column.nullable===requirement.nullable,'inference_build_parent_incompatible')
  }
  for(const name of inferenceBuildNames)assert.equal(inventory.tables[inferenceBuildMapping[name]]?.exists,false,'inference_build_target_not_empty_namespace')
}
