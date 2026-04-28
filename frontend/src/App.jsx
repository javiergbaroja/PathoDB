// frontend/src/App.jsx
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
import { ErrorBoundary } from './components/ErrorBoundary'

// 1. Import React Query
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

// 2. Initialize the client (we keep staleTime at default 0 so it always checks for fresh WSI data in the background)
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false, // Don't refetch every time the user switches browser tabs
      retry: 1, // Only retry failed requests once
    },
  },
})

function Protected({ children }) {
  const { isAuth, loading } = useAuth()
  const location = useLocation() 

  if (loading) return <SpinnerPage />
  if (!isAuth) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return children
}

export default function App() {
  return (
    // 3. Wrap everything inside the QueryClientProvider
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
              
              <Route path="*"         element={<Navigate to="/patients" replace />} />
            </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
      {/* 4. Add the DevTools (only visible in dev mode) */}
      <ReactQueryDevtools initialIsOpen={false} position="bottom-right" />
    </QueryClientProvider>
  )
}