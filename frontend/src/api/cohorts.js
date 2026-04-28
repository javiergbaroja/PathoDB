import { request, BASE } from './client'

export const deleteCohort     = (id)        => request('DELETE', `/cohorts/${id}`)
export const getCohortResults = (id)        => request('GET', `/cohorts/${id}/results`)
export const queryCohort      = (filters)   => request('POST', '/cohorts/query', filters)
export const queryList        = (req)       => request('POST', '/cohorts/query_list', req)
export const getCohorts       = ()          => request('GET', '/cohorts')
export const saveCohort       = (data)      => request('POST', '/cohorts', data)
export const exportCohort     = (id, fmt)   => `${BASE}/cohorts/${id}/export?fmt=${fmt}`