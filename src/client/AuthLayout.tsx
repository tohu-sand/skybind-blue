import { Outlet } from 'react-router-dom'
import { BskyAuthProvider } from './hooks/useBskyAuth'

// Wraps only the routes that need Bluesky OAuth so the heavy
// @atproto/oauth-client-browser bundle stays out of the viewer chunks.
export default function AuthLayout() {
  return (
    <BskyAuthProvider>
      <Outlet />
    </BskyAuthProvider>
  )
}
