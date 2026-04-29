// frontend/src/store/viewerStore.js
import { create } from 'zustand'

export const useViewerStore = create((set) => ({
  // ── UI Panels ──
  panelOpen: false,
  setPanelOpen: (updater) => set((state) => ({ panelOpen: typeof updater === 'function' ? updater(state.panelOpen) : updater })),
  
  showModels: false,
  setShowModels: (updater) => set((state) => ({ showModels: typeof updater === 'function' ? updater(state.showModels) : updater })),
  
  showShortcuts: false,
  setShowShortcuts: (updater) => set((state) => ({ showShortcuts: typeof updater === 'function' ? updater(state.showShortcuts) : updater })),
  
  showBrightness: false,
  setShowBrightness: (updater) => set((state) => ({ showBrightness: typeof updater === 'function' ? updater(state.showBrightness) : updater })),

  // ── Tools ──
  isRulerActive: false,
  setIsRulerActive: (updater) => set((state) => ({ isRulerActive: typeof updater === 'function' ? updater(state.isRulerActive) : updater })),
  isPolygonActive: false,
  setIsPolygonActive: (updater) => set((state) => ({ isPolygonActive: typeof updater === 'function' ? updater(state.isPolygonActive) : updater })),
  
  polygons: [],
  setPolygons: (updater) => set((state) => ({ polygons: typeof updater === 'function' ? updater(state.polygons) : updater })),
  clearPolygons: () => set({ polygons: [] }),
  // ── Image Adjustments ──
  brightness: 100,
  setBrightness: (val) => set({ brightness: val }),
  
  contrast: 100,
  setContrast: (val) => set({ contrast: val }),
  
  gamma: 1.0,
  setGamma: (val) => set({ gamma: val }),
  
  resetAdjustments: () => set({ brightness: 100, contrast: 100, gamma: 1.0 }),
}))