// frontend/src/api/registration.js
import { request } from './client'

// Fetch a saved transform for a fixed/moving scan pair (either stored order).
export const getRegistration = (fixedScanId, movingScanId) =>
  request('GET', `/registration?fixed_scan_id=${fixedScanId}&moving_scan_id=${movingScanId}`)

// Compute a transform automatically (ORB feature matching). May 503 if OpenCV
// is unavailable on the server — callers should fall back to manual landmarks.
export const autoRegister = (fixedScanId, movingScanId) =>
  request('POST', '/registration/auto', { fixed_scan_id: fixedScanId, moving_scan_id: movingScanId })

// Persist a transform (manual landmarks or an accepted auto result).
export const saveRegistration = ({ fixedScanId, movingScanId, scale, rotation, tx, ty, method = 'manual' }) =>
  request('POST', '/registration', {
    fixed_scan_id: fixedScanId, moving_scan_id: movingScanId,
    scale, rotation, tx, ty, method,
  })

export const deleteRegistration = (fixedScanId, movingScanId) =>
  request('DELETE', `/registration?fixed_scan_id=${fixedScanId}&moving_scan_id=${movingScanId}`)
