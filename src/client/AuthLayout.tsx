import { Outlet } from 'react-router-dom'
import { BskyAuthProvider } from './hooks/useBskyAuth'

// Keep OAuth dependencies out of the viewer bundles.
export default function AuthLayout() {
  return (
    <BskyAuthProvider>
      <Outlet />
    </BskyAuthProvider>
  )
}
