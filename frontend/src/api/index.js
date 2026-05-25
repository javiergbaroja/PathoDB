// frontend/src/api/index.js
import { request } from './client'

import { login, register, logout, getMe, getUsers, createUser, deactivateUser } from './auth'
import { getPatients, getPatient, getHierarchy } from './patients'
import { deleteCohort, getCohortResults, queryCohort, queryList, getCohorts, saveCohort, exportCohort } from './cohorts'
import { getModels, getAnalysisJobs, getAnalysisJob, submitAnalysis, submitBatchAnalysis, cancelAnalysis, deleteAnalysis, getAnalysisResult, getLiveJobState, getAnalysisOverlay, downloadAnalysisFile, getAnalysisOverlayBlob } from './analysis'
import { getSlideInfo, getThumbnailUrl, getRelatedScans, matchSlides } from './slides'
import { getScansForBlock, registerScan, deleteScan } from './scans'
import { getStains, createStain, updateStain } from './stains'
import { search, lookup, getStats } from './search'
import { createChatSession, listChatSessions, getChatSession, getAssistantHealth, streamChat, confirmAction } from './assistant'
import { createTMA, uploadTMACoresCSV, uploadTMAScansCSV, getTMACores, getTMAs, getTMA, updateTMA, deleteTMA } from './tmas'
import { getRegistration, autoRegister, saveRegistration, deleteRegistration } from './registration'
import { 
  getProjects, getProject, createProject, updateProject, deleteProject,
  syncProject, getProjectProgress, createProjectFromFile,
  exportProject,
  getProjectScans,
  shareProject, updateShare, revokeShare,
  getAnnotations, createAnnotation, updateAnnotation, deleteAnnotation, bulkSaveAnnotations, importAnnotations,
} from './projects'

export const api = {
  // Auth
  login, register, logout, getMe, getUsers, createUser, deactivateUser,
  // Patients
  getPatients, getPatient, getHierarchy,
  // Cohorts
  deleteCohort, getCohortResults, queryCohort, queryList, getCohorts, saveCohort, exportCohort,

  getModels, getAnalysisJobs, getAnalysisJob, submitAnalysis, submitBatchAnalysis, cancelAnalysis, deleteAnalysis,
  getAnalysisResult, getAnalysisOverlay, downloadAnalysisFile, getAnalysisOverlayBlob, getLiveJobState,

  getSlideInfo, getThumbnailUrl, getRelatedScans, matchSlides,
  getScansForBlock, registerScan, deleteScan,
  // Stains
  getStains, createStain, updateStain,
  // Search & Stats
  search, lookup, getStats,
  // Assistant
  createChatSession, listChatSessions, getChatSession, getAssistantHealth, streamChat, confirmAction,
  // Projects
  getProjects, getProject, createProject, updateProject, deleteProject,
  syncProject, getProjectProgress, createProjectFromFile,
  exportProject,
  getProjectScans,
  shareProject, updateShare, revokeShare,
  getAnnotations, createAnnotation, updateAnnotation, deleteAnnotation, bulkSaveAnnotations, importAnnotations,
  // Health
  health: () => request('GET', '/health'),

  // TMAs
  createTMA, uploadTMACoresCSV, uploadTMAScansCSV, getTMACores, getTMAs, getTMA, updateTMA, deleteTMA,

  // Slide registration
  getRegistration, autoRegister, saveRegistration, deleteRegistration,
}