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

function Protected({ children }) {
  const { isAuth, loading } = useAuth()
  const location = useLocation() // 2. Get the current route location

  if (loading) return <SpinnerPage />
  if (!isAuth) {
    // 3. Pass the location into the Navigate state so the Login page knows where we came from
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return children
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login"    element={<Login />} />
          <Route path="/"         element={<Navigate to="/patients" replace />} />
          <Route path="/patients" element={<Protected><Patients /></Protected>} />
          <Route path="/patients/:id" element={<Protected><PatientDetail /></Protected>} />
          <Route path="/cohorts"  element={<Protected><Cohorts /></Protected>} />
          <Route path="/stains"   element={<Protected><Stains /></Protected>} />
          <Route path="/assistant" element={<Protected><AIAssistant /></Protected>} />
          <Route path="/viewer/:scanId" element={<Protected><SlideViewer /></Protected>} />
          <Route path="*"         element={<Navigate to="/patients" replace />} />
          <Route path="/saved-results/:cohortId" element={<Protected><CohortResults /></Protected>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
