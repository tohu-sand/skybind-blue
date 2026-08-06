import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'

const AuthLayout = lazy(() => import('./AuthLayout'))
const CreateLink = lazy(() => import('./pages/CreateLink'))
const EmbedViewer = lazy(() => import('./pages/EmbedViewer'))
const Home = lazy(() => import('./pages/Home'))
const ManageLinks = lazy(() => import('./pages/ManageLinks'))
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'))
const TermsOfService = lazy(() => import('./pages/TermsOfService'))
const Viewer = lazy(() => import('./pages/Viewer'))

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<CreateLink />} />
          <Route path="/manage" element={<ManageLinks />} />
        </Route>
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/terms" element={<TermsOfService />} />
        <Route path="/v/:id" element={<Viewer />} />
        <Route path="/embed/:id" element={<EmbedViewer />} />
      </Routes>
    </Suspense>
  )
}
