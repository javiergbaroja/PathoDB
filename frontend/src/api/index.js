// frontend/src/api/index.js
import { request } from './client'

// 1. Explicitly import every function
import { login, register, logout, getMe, getUsers, createUser, deactivateUser } from './auth'
import { getPatients, getPatient, getHierarchy } from './patients'
import { deleteCohort, getCohortResults, queryCohort, queryList, getCohorts, saveCohort, exportCohort } from './cohorts'
import { getModels, getAnalysisJobs, getAnalysisJob, submitAnalysis, cancelAnalysis, deleteAnalysis, getAnalysisResult, getAnalysisOverlay } from './analysis'
import { getSlideInfo, getThumbnailUrl, getRelatedScans } from './slides'
import { getScansForBlock, registerScan, deleteScan } from './scans'
import { getStains, createStain, updateStain } from './stains'
import { search, lookup, getStats } from './search'
import { askAssistant } from './assistant'

// 2. Export them as a single 'api' object
export const api = {
  // Auth
  login, register, logout, getMe, getUsers, createUser, deactivateUser,
  // Patients
  getPatients, getPatient, getHierarchy,
  // Cohorts
  deleteCohort, getCohortResults, queryCohort, queryList, getCohorts, saveCohort, exportCohort,
  // Analysis
  getModels, getAnalysisJobs, getAnalysisJob, submitAnalysis, cancelAnalysis, deleteAnalysis, getAnalysisResult, getAnalysisOverlay,
  // Slides & Scans
  getSlideInfo, getThumbnailUrl, getRelatedScans,
  getScansForBlock, registerScan, deleteScan,
  // Stains
  getStains, createStain, updateStain,
  // Search & Stats (This fixes your bug!)
  search, lookup, getStats,
  // Assistant & Misc
  askAssistant,
  health: () => request('GET', '/health'),
}