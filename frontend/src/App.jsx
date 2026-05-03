// frontend/src/App.jsx — FULL REPLACEMENT
// Adds /projects and /projects/:projectId routes

import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { SpinnerPage } from './components/ui'
import Login         from './pages/Login'
import Patients      from './pages/Patients'
import PatientDetail from './pages/PatientDetail'
import Cohorts       from './pages/Cohorts'
import Stains        from './pages/Stains'
import AIAssistant   from './pages/AIAssistant'
import SlideViewer   from './pages/SlideViewer'
import CohortResults from './pages/CohortResults'
import Projects      from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import { ErrorBoundary } from './components/ErrorBoundary'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

function Protected({ children }) {
  const { isAuth, loading } = useAuth()
  const location = useLocation()
  if (loading) return <SpinnerPage />
  if (!isAuth) return <Navigate to="/login" state={{ from: location }} replace />
  return children
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <ErrorBoundary>
            <Routes>
              <Route path="/login"    element={<Login />} />
              <Route path="/"         element={<Navigate to="/patients" replace />} />
              
              <Route path="/patients" element={<Protected><Patients /></Protected>} />
              <Route path="/patients/:id" element={<Protected><PatientDetail /></Protected>} />
              <Route path="/cohorts"  element={<Protected><Cohorts /></Protected>} />
              <Route path="/stains"   element={<Protected><Stains /></Protected>} />
              <Route path="/assistant" element={<Protected><AIAssistant /></Protected>} />
              <Route path="/viewer/:scanId" element={<Protected><SlideViewer /></Protected>} />
              <Route path="/saved-results/:cohortId" element={<Protected><CohortResults /></Protected>} />
              <Route path="/projects"            element={<Protected><Projects /></Protected>} />
              <Route path="/projects/:projectId" element={<Protected><ProjectDetail /></Protected>} />
              <Route path="*"element={<Navigate to="/patients" replace />} />
            </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
      <ReactQueryDevtools initialIsOpen={false} position="bottom-right" />
    </QueryClientProvider>
  )
}