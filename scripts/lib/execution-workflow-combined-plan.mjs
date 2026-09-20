import assert from 'node:assert/strict'
import {loadExecutionWorkflowUpgrade} from './execution-workflow-upgrade.mjs'

/** One whole-schema state chain across both migrations; original step checksums stay unchanged. */
export async function loadCombinedExecutionWorkflowPlan(root){
 const loaded=await loadExecutionWorkflowUpgrade(root)
 const added=[loaded.prior.step,...loaded.added]
 assert.equal(added.length,33)
 for(let i=1;i<added.length;i++)assert.equal(added[i-1].afterHash,added[i].beforeHash)
 return {steps:loaded.steps,transitions:added.map(step=>({step,key:'execution_workflow_complete_schema',before:step.beforeHash,after:step.afterHash})),
  added,finalSchemaHash:loaded.finalSchemaHash,finalTableHashes:loaded.finalTableHashes}
}
