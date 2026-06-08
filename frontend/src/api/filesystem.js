import { request } from './client'

export const browseDirectory = (path = '/storage/research') =>
  request('GET', `/filesystem/browse?path=${encodeURIComponent(path)}`)

export const createDirectory = (path) =>
  request('POST', '/filesystem/mkdir', { path })
