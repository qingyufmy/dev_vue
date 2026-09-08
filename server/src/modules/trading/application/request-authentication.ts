export interface TradeRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

export interface ObserverManagementRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
}

export interface TradeSessionAuthenticator extends TradeRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
}
