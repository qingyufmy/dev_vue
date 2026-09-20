import assert from 'node:assert/strict'
import {readFile,open} from 'node:fs/promises'
import {join,resolve,isAbsolute} from 'node:path'
import mysql from 'mysql2/promise'
import {parse} from 'dotenv'
import {buildStrategyRolePromptCandidate} from './lib/strategy-role-prompt-candidate.mjs'
import {legacyStrategyFields} from './lib/v4-strategy-source-review.mjs'
import {convertStrategyRoleConfig} from './lib/v4-strategy-role-config-conversion.mjs'
import {bindStrategyRoleCandidateConfig} from './lib/strategy-role-candidate-config.mjs'
import {compileStrategy} from '../server/dist-v4/modules/strategies/application/strategy-service.js'
import {runLocalBackupProcess,discardLocalBackupOutput} from './lib/local-backup-process.mjs'
import {hash} from './lib/v4-backfill-contract.mjs'

const [planPath,reportPath]=process.argv.slice(2)
assert.ok(process.argv.length===4&&isAbsolute(planPath??'')&&isAbsolute(reportPath??''))
const plan=JSON.parse(await readFile(planPath,'utf8'))
assert.ok(/^[1-9]\d*$/.test(plan.sourceId)&&/^[1-9]\d*$/.test(plan.sourceVersion))
assert.ok(Array.isArray(plan.runtimeBlockers)&&plan.runtimeBlockers.every(item=>typeof item==='string'))
const directory='D:/dev_codex/.backup-core-20260910-01'
await runLocalBackupProcess({command:join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
  args:['-NoProfile','-NonInteractive','-File',resolve('scripts/private-local-backup-directory.ps1'),'-Mode','Verify','-Path',directory],
  consume:discardLocalBackupOutput,timeoutMs:15000})
const env=parse(await readFile('server/.env'))
assert.equal(env.MYSQL_HOST,'192.168.1.254');assert.equal(env.MYSQL_DATABASE,'dev_vue')
const connection=await mysql.createConnection({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT||3306),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,
  database:env.MYSQL_DATABASE,timezone:'Z',dateStrings:true})
try{
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]]=await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db,'dev_vue');assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104')
  const [rows]=await connection.execute(`SELECT ${legacyStrategyFields.map(field=>`CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')} FROM auto_prompt_types WHERE id=? AND version=?`,[plan.sourceId,plan.sourceVersion])
  assert.equal(rows.length,1)
  const source={...rows[0]},candidate=buildStrategyRolePromptCandidate(source,plan)
  const config=bindStrategyRoleCandidateConfig(convertStrategyRoleConfig(source),plan.configAdditions)
  const compile=Object.fromEntries(['analysis','trader'].map(kind=>[kind,compileStrategy(kind,candidate.roles[kind].promptText,config[`${kind}Config`])]))
  assert.ok(Object.values(compile).every(result=>result.valid))
  await connection.rollback()
  const privatePath=join(directory,`strategy-${plan.sourceId}-v${plan.sourceVersion}-role-candidate-${hash(plan).slice(0,12)}.json`)
  const privateOutput=await open(privatePath,'wx',0o600)
  try{await privateOutput.writeFile(JSON.stringify({...candidate,config,runtimeBlockers:plan.runtimeBlockers},null,2)+'\n')}finally{await privateOutput.close()}
  const report={kind:candidate.kind,observedAt:new Date().toISOString(),sourceId:source.id,sourceVersion:source.version,sourceHash:candidate.sourceHash,
    sourcePromptHash:candidate.sourcePromptHash,planHash:hash(plan),privateArtifact:privatePath,
    roles:Object.fromEntries(Object.entries(candidate.roles).map(([kind,{promptText,...metadata}])=>[kind,metadata])),
    sections:candidate.sections,originalTextFullyAssigned:candidate.originalTextFullyAssigned,compilePassed:true,
    configStatus:config.status,configProblems:config.problems,reviewedConfig:config.reviewedAdditions,
    runtimeBlockers:plan.runtimeBlockers,executable:false,semanticAcceptance:'pending',databaseWrites:0}
  const publicOutput=await open(reportPath,'wx',0o600)
  try{await publicOutput.writeFile(JSON.stringify(report,null,2)+'\n')}finally{await publicOutput.close()}
  console.log(JSON.stringify({sourceId:source.id,sourceVersion:source.version,sections:candidate.sections.length,compilePassed:true,configStatus:config.status,executable:false,databaseWrites:0}))
}finally{await connection.end()}
