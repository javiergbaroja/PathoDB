import { request } from './client'

export const login          = (username, password) => request('POST', '/auth/login', { username, password })
export const register       = (data) => request('POST', '/auth/register', data)
export const logout         = () => request('POST', '/auth/logout')
export const getMe          = () => request('GET', '/auth/me')
export const getUsers       = () => request('GET', '/auth/users')
export const createUser     = (data) => request('POST', '/auth/users', data)
export const deactivateUser = (id)   => request('PATCH', `/auth/users/${id}/deactivate`)