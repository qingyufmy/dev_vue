import { createApiClient } from '@aurum/api-client'

const client = createApiClient()
export const bridgeApi = { createPairing: client.createBridgePairing }
