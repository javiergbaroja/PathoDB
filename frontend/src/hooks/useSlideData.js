// frontend/src/hooks/useSlideData.js
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'

export function useModelsCatalog() {
  return useQuery({
    queryKey: ['models'],
    queryFn: () => api.getModels()
  })
}

export function useSlideInfo(scanId, token) {
  return useQuery({
    queryKey: ['slide', scanId, 'info'],
    queryFn: () => api.getSlideInfo(scanId, token),
    enabled: !!scanId && !!token
  })
}

export function useRelatedScans(scanId, token) {
  return useQuery({
    queryKey: ['slide', scanId, 'related'],
    queryFn: () => api.getRelatedScans(scanId, token),
    enabled: !!scanId && !!token
  })
}

export function useAnalysisJobs(scanId) {
  // 1. Base query for the jobs
  const query = useQuery({
    queryKey: ['jobs', scanId],
    queryFn: () => api.getAnalysisJobs(scanId),
    enabled: !!scanId,
  })

  // 2. Determine if we need to poll
  const jobs = query.data || []
  const hasActiveJobs = jobs.some(j => j.status === 'queued' || j.status === 'running')

  // 3. Polling query (runs seamlessly in the background)
  useQuery({
    queryKey: ['jobs', scanId],
    queryFn: () => api.getAnalysisJobs(scanId),
    enabled: hasActiveJobs,
    refetchInterval: 5000 
  })

  return { ...query, data: jobs }
}