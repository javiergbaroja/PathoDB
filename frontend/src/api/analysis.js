import { request } from './client'

export const getModels          = ()                    => request('GET', '/analysis/models')
export const getAnalysisJobs    = (scanId)              => request('GET', `/analysis/jobs?scan_id=${scanId}`)
export const getAnalysisJob     = (jobId)               => request('GET', `/analysis/jobs/${jobId}`)
export const submitAnalysis     = (scanId, body)        => request('POST', `/analysis/jobs?scan_id=${scanId}`, body)
export const cancelAnalysis     = (jobId)               => request('DELETE', `/analysis/jobs/${jobId}`)
export const deleteAnalysis     = (jobId)               => request('DELETE', `/analysis/jobs/${jobId}?purge=true`)
export const getAnalysisResult  = (jobId)               => request('GET', `/analysis/jobs/${jobId}/result`)
export const getAnalysisOverlay = (jobId, file)         => request('GET', `/analysis/jobs/${jobId}/overlay?file=${file}`)