import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  BrowserOAuthClient,
  buildLoopbackClientId,
  type OAuthSession,
} from '@atproto/oauth-client-browser'
import { Agent } from '@atproto/api'

type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error'

type AuthProfile = {
  did: string
  handle?: string
  displayName?: string
  avatar?: string
}

type AuthContextValue = {
  client: BrowserOAuthClient | null
  session: OAuthSession | null
  profile: AuthProfile | null
  status: AuthStatus
  error: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

const BskyAuthContext = createContext<AuthContextValue | null>(null)

const getEnv = (key: string, fallback: string) =>
  (import.meta.env[key] as string | undefined) ?? fallback

const hasOAuthParams = (params: URLSearchParams) =>
  params.has('state') && (params.has('code') || params.has('error'))

const getCallbackMode = () => {
  const searchParams = new URLSearchParams(window.location.search)
  if (hasOAuthParams(searchParams)) {
    return 'query' as const
  }
  const hashParams = new URLSearchParams(window.location.hash.slice(1))
  if (hasOAuthParams(hashParams)) {
    return 'fragment' as const
  }
  return null
}

export function BskyAuthProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<BrowserOAuthClient | null>(null)
  const [session, setSession] = useState<OAuthSession | null>(null)
  const [profile, setProfile] = useState<AuthProfile | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let localClient: BrowserOAuthClient | null = null

    const init = async () => {
      setError(null)
      setStatus('loading')
      const hostname = window.location.hostname
      const isLoopback =
        hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
      const handleResolver = getEnv(
        'VITE_BSKY_HANDLE_RESOLVER',
        'https://bsky.social',
      )
      const callbackMode = getCallbackMode()
      const responseMode = callbackMode ?? 'fragment'

      if (isLoopback) {
        const loopbackClientId = buildLoopbackClientId({
          hostname: window.location.hostname,
          port: window.location.port,
          pathname: '/',
        })
        localClient = await BrowserOAuthClient.load({
          clientId: loopbackClientId,
          handleResolver,
          responseMode,
        })
      } else {
        const fallbackClientId = new URL(
          '/client-metadata.json',
          window.location.origin,
        ).toString()
        const clientId = getEnv('VITE_OAUTH_CLIENT_ID', fallbackClientId)
        localClient = await BrowserOAuthClient.load({
          clientId,
          handleResolver,
          responseMode,
        })
      }

      if (!alive || !localClient) {
        localClient?.dispose()
        return
      }

      setClient(localClient)
      const result = await localClient.init()
      if (!alive) {
        return
      }

      if (result?.session) {
        setSession(result.session)
        setStatus('authenticated')
      } else {
        setStatus('anonymous')
      }
    }

    init().catch((err: unknown) => {
      if (!alive) {
        return
      }
      setError(err instanceof Error ? err.message : 'OAuth initialization failed')
      setStatus('error')
    })

    return () => {
      alive = false
      localClient?.dispose()
    }
  }, [])

  useEffect(() => {
    if (!session) {
      setProfile(null)
      return
    }

    let alive = true
    const agent = new Agent(session)
    const publicApi = getEnv('VITE_BSKY_PUBLIC_API', 'https://public.api.bsky.app')
    const applyProfile = (data: {
      did?: string
      handle?: string
      displayName?: string
      avatar?: string
    }) => {
      const normalizedHandle =
        data.handle && data.handle.startsWith('did:') ? undefined : data.handle
      setProfile({
        did: data.did || session.did,
        handle: normalizedHandle,
        displayName: data.displayName,
        avatar: data.avatar,
      })
    }
    const fetchPublicProfile = async () => {
      const response = await fetch(
        `${publicApi}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(
          session.did,
        )}`,
        { headers: { Accept: 'application/json' } },
      )
      if (!response.ok) {
        throw new Error('Failed to fetch profile')
      }
      const data = (await response.json()) as {
        did?: string
        handle?: string
        displayName?: string
        avatar?: string
      }
      if (!alive) {
        return
      }
      applyProfile(data)
    }

    agent
      .getProfile({ actor: session.did })
      .then((res) => {
        if (!alive) {
          return
        }
        applyProfile(res.data)
      })
      .catch(() => {
        fetchPublicProfile().catch(() => {
          if (!alive) {
            return
          }
          setProfile({
            did: session.did,
            handle: undefined,
          })
        })
      })

    return () => {
      alive = false
    }
  }, [session])

  const signIn = useCallback(async () => {
    if (!client) {
      return
    }
    const entryway = getEnv('VITE_BSKY_ENTRYWAY', 'https://bsky.social')
    await client.signIn(entryway)
  }, [client])

  const signOut = useCallback(async () => {
    if (!client || !session) {
      return
    }
    await client.revoke(session.sub)
    setSession(null)
    setProfile(null)
    setStatus('anonymous')
  }, [client, session])

  const value = useMemo(
    () => ({
      client,
      session,
      profile,
      status,
      error,
      signIn,
      signOut,
    }),
    [client, session, profile, status, error, signIn, signOut],
  )

  return <BskyAuthContext.Provider value={value}>{children}</BskyAuthContext.Provider>
}

export function useBskyAuth() {
  const context = useContext(BskyAuthContext)
  if (!context) {
    throw new Error('useBskyAuth must be used within BskyAuthProvider')
  }
  return context
}
