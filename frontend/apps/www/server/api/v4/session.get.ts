import { proxyWwwRequest } from '../../utils/www-proxy'
export default defineEventHandler(event => proxyWwwRequest(event, '/api/v4/session'))
