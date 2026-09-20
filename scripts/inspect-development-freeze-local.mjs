import assert from 'node:assert/strict'
import {open} from 'node:fs/promises'
import {isAbsolute} from 'node:path'
import mysql from 'mysql2/promise'
const [destination]=process.argv.slice(2)
assert.ok(process.argv.length===3&&isAbsolute(destination??''))
const output=await open(destination,'wx',0o600),report={kind:'development-freeze-inventory/v1',passed:false,writes:0}
let db
try{
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
 const credential=JSON.parse(Buffer.concat(chunks).toString('utf8'))
 assert.ok(credential.host==='127.0.0.1'&&credential.port===13316&&credential.user==='root')
 db=await mysql.createConnection({...credential,database:'dev_vue'})
 const [[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid');assert.equal(identity.db,'dev_vue');assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104')
 const [accounts]=await db.query("SELECT User user,Host host,account_locked locked FROM mysql.user WHERE User='dev_vue' ORDER BY Host")
 const [databases]=await db.query("SELECT Db db FROM mysql.db WHERE User='dev_vue'")
 const [clients]=await db.query("SELECT USER user,DB db,COMMAND command,COUNT(*) quantity FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND (DB='dev_vue' OR USER='dev_vue') GROUP BY USER,DB,COMMAND")
 report.accounts=accounts;report.databases=databases;report.clients=clients;report.passed=true
}catch(error){report.errorCode=error?.code??error?.name;process.exitCode=1}
finally{if(db)await db.end();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close();console.log(JSON.stringify(report))}
