import { request } from './client'

export const getScansForBlock = (blockId) => request('GET', `/blocks/${blockId}/scans`)
export const registerScan     = (data)    => request('POST', '/scans', data)
export const deleteScan       = (id)      => request('DELETE', `/scans/${id}`)