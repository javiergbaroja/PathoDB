// frontend/src/api/index.js
// FULL REPLACEMENT — adds projects API functions

import { request } from './client'

import { login, register, logout, getMe, getUsers, createUser, deactivateUser } from './auth'
import { getPatients, getPatient, getHierarchy } from './patients'
import { deleteCohort, getCohortResults, queryCohort, queryList, getCohorts, saveCohort, exportCohort } from './cohorts'
import { getModels, getAnalysisJobs, getAnalysisJob, submitAnalysis, cancelAnalysis, deleteAnalysis, getAnalysisResult, getAnalysisOverlay, downloadAnalysisFile } from './analysis'
import { getSlideInfo, getThumbnailUrl, getRelatedScans } from './slides'
import { getScansForBlock, registerScan, deleteScan } from './scans'
import { getStains, createStain, updateStain } from './stains'
import { search, lookup, getStats } from './search'
import { askAssistant } from './assistant'
import {
  getProjects, getProject, createProject, updateProject, deleteProject,
  syncProject, getProjectProgress, createProjectFromFile,
  getProjectScans,
  shareProject, updateShare, revokeShare,
  getAnnotations, createAnnotation, updateAnnotation, deleteAnnotation, bulkSaveAnnotations,
} from './projects'

export const api = {
  // Auth
  login, register, logout, getMe, getUsers, createUser, deactivateUser,
  // Patients
  getPatients, getPatient, getHierarchy,
  // Cohorts
  deleteCohort, getCohortResults, queryCohort, queryList, getCohorts, saveCohort, exportCohort,
  // Analysis
  getModels, getAnalysisJobs, getAnalysisJob, submitAnalysis, cancelAnalysis, deleteAnalysis,
  getAnalysisResult, getAnalysisOverlay, downloadAnalysisFile,
  // Slides & Scans
  getSlideInfo, getThumbnailUrl, getRelatedScans,
  getScansForBlock, registerScan, deleteScan,
  // Stains
  getStains, createStain, updateStain,
  // Search & Stats
  search, lookup, getStats,
  // Assistant
  askAssistant,
  // Projects
  getProjects, getProject, createProject, updateProject, deleteProject,
  syncProject, getProjectProgress, createProjectFromFile,
  getProjectScans,
  shareProject, updateShare, revokeShare,
  getAnnotations, createAnnotation, updateAnnotation, deleteAnnotation, bulkSaveAnnotations,
  // Health
  health: () => request('GET', '/health'),
}