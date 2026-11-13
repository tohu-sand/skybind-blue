import { useEffect } from 'react'

// Keep the screen on while `active`. Browsers without the Screen Wake Lock API, or
// that refuse the request (low battery, power saving), simply carry on without it.
export default function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) {
      return undefined
    }

    let sentinel: WakeLockSentinel | null = null
    let disposed = false

    const acquire = async () => {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) {
        return
      }
      try {
        const lock = await navigator.wakeLock.request('screen')
        // Overlapping requests or an unmount may have won while this one was pending.
        if (disposed || (sentinel && !sentinel.released)) {
          lock.release().catch(() => {})
          return
        }
        sentinel = lock
      } catch {
        // Refused requests are not errors for the caller.
      }
    }

    // The browser releases the lock whenever the page is hidden.
    const handleVisibility = () => {
      void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', handleVisibility)
      sentinel?.release().catch(() => {})
    }
  }, [active])
}
