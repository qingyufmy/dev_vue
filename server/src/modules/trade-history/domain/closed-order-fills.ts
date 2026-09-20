import type { TerminalDealFact } from './terminal-history-projection.js'

export interface ClosedOrderFillScope {
  readonly orderTicket:string
  readonly receiptDealTickets:readonly string[]
  readonly positionIdentifier:string
  readonly symbol:string
  readonly positionSide:'buy'|'sell'
  readonly expectedVolume:string
  readonly issuedAtUtcMsc:number
  readonly completedAtUtcMsc:number
}
const id=(value:unknown):value is string=>typeof value==='string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value)<=18446744073709551615n
const scale=10n**18n
function units(value:unknown):bigint|null {
  if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,28})(\.[0-9]{1,18})?$/.test(value))return null
  const [whole,fraction='']=value.split('.')
  return BigInt(whole!)*scale+BigInt(fraction.padEnd(18,'0'))
}
function decimal(value:bigint){const fraction=(value%scale).toString().padStart(18,'0').replace(/0+$/,'');return `${value/scale}${fraction?`.${fraction}`:''}`}

/** Only sums identified closing fills; does not itself prove task completeness or source provenance. */
export function reconcileClosedOrderFills(scope:ClosedOrderFillScope,deals:readonly TerminalDealFact[]):{
  closedVolume:string;tradeDealTickets:string[];lastDealAtUtcMsc:number
}|null {
  const expected=units(scope.expectedVolume)
  if(!id(scope.orderTicket)||!id(scope.positionIdentifier)||!expected||expected<=0n
    ||!Array.isArray(scope.receiptDealTickets)||scope.receiptDealTickets.length<1||scope.receiptDealTickets.length>128
    ||!scope.receiptDealTickets.every(id)||new Set(scope.receiptDealTickets).size!==scope.receiptDealTickets.length
    ||!['buy','sell'].includes(scope.positionSide)||typeof scope.symbol!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(scope.symbol)
    ||![scope.issuedAtUtcMsc,scope.completedAtUtcMsc].every(v=>Number.isSafeInteger(v)&&v>0&&Number.isFinite(new Date(v).getTime()))
    ||scope.completedAtUtcMsc<scope.issuedAtUtcMsc||!Array.isArray(deals)||deals.length<1||deals.length>1000)return null
  const seen=new Set<string>(),trades:string[]=[]
  let total=0n,last=0
  for(const deal of deals){
    if(!deal||!id(deal.ticket)||seen.has(deal.ticket)||deal.orderTicket!==scope.orderTicket
      ||!Number.isSafeInteger(deal.occurredAtUtcMsc)||deal.occurredAtUtcMsc<scope.issuedAtUtcMsc||deal.occurredAtUtcMsc>scope.completedAtUtcMsc)return null
    seen.add(deal.ticket)
    if(deal.dealKind==='fee'&&deal.entryKind==='none'&&deal.side==='none'&&(deal.volume===null||units(deal.volume)===0n)
      &&(deal.positionId===null||deal.positionId===scope.positionIdentifier)&&(deal.symbol===null||deal.symbol===scope.symbol))continue
    const amount=units(deal.volume)
    if(deal.dealKind!=='trade'||deal.entryKind!=='out'||deal.positionId!==scope.positionIdentifier||deal.symbol!==scope.symbol
      ||deal.side!==(scope.positionSide==='buy'?'sell':'buy')||amount===null||amount<=0n)return null
    total+=amount;trades.push(deal.ticket);last=Math.max(last,deal.occurredAtUtcMsc)
  }
  if(total!==expected||scope.receiptDealTickets.some(ticket=>!trades.includes(ticket)))return null
  return {closedVolume:decimal(total),tradeDealTickets:trades.sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),lastDealAtUtcMsc:last}
}
