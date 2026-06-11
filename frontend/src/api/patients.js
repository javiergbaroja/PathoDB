import { request } from './client'

export const getPatients = (params = {}) => {
  const q = new URLSearchParams(params).toString()
  return request('GET', `/patients${q ? '?' + q : ''}`)
}
export const getPatient   = (id) => request('GET', `/patients/${id}`)
export const getHierarchy = (id) => request('GET', `/patients/${id}/hierarchy`)

export const updatePatient    = (id, data) =>
  request('PATCH', `/patients/${id}`, data)
export const updateSubmission = (patientId, submissionId, data) =>
  request('PATCH', `/patients/${patientId}/submissions/${submissionId}`, data)
export const updateReport     = (patientId, submissionId, reportId, data) =>
  request('PATCH', `/patients/${patientId}/submissions/${submissionId}/reports/${reportId}`, data)
export const createProbe  = (patientId, subId, data) =>
  request('POST', `/patients/${patientId}/submissions/${subId}/probes`, data)
export const updateProbe  = (patientId, subId, probeId, data) =>
  request('PATCH', `/patients/${patientId}/submissions/${subId}/probes/${probeId}`, data)
export const deleteProbe  = (patientId, subId, probeId) =>
  request('DELETE', `/patients/${patientId}/submissions/${subId}/probes/${probeId}`)
export const createBlock  = (patientId, subId, probeId, data) =>
  request('POST', `/patients/${patientId}/submissions/${subId}/probes/${probeId}/blocks`, data)
export const updateBlock  = (patientId, subId, probeId, blockId, data) =>
  request('PATCH', `/patients/${patientId}/submissions/${subId}/probes/${probeId}/blocks/${blockId}`, data)
export const deleteBlock  = (patientId, subId, probeId, blockId) =>
  request('DELETE', `/patients/${patientId}/submissions/${subId}/probes/${probeId}/blocks/${blockId}`)