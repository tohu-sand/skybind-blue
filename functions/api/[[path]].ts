import { handle } from 'hono/cloudflare-pages'
import { app } from '../../src/server/index'

export const onRequest = handle(app)
