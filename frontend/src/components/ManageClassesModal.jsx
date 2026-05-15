// frontend/src/components/ManageClassesModal.jsx
import { useState, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { Modal, Btn, FormInput } from './ui'
import { PATHOLOGY_PALETTE } from '../constants/stains'

export default function ManageClassesModal({ isOpen, onClose, project }) {
  const queryClient = useQueryClient()
  
  // Isolate changes in a draft state
  const [draftClasses, setDraftClasses] = useState([])

  useEffect(() => {
    if (isOpen && project) {
      setDraftClasses(JSON.parse(JSON.stringify(project.classes || [])))
    }
  }, [isOpen, project])

  const mutation = useMutation({
    mutationFn: (updatedClasses) => api.updateProject(project.id, { classes: updatedClasses }),
    onSuccess: () => {
      // Invalidate to force UI repaint with new colors/names
      queryClient.invalidateQueries({ queryKey: ['project', project.id.toString()] })
      queryClient.invalidateQueries({ queryKey: ['annotations'] }) 
      onClose()
    }
  })

  const handleAddClass = () => {
    const newClass = {
      id: crypto.randomUUID(), 
      name: 'New Class',
      color: PATHOLOGY_PALETTE[draftClasses.length % PATHOLOGY_PALETTE.length]
    }
    setDraftClasses([...draftClasses, newClass])
  }

  const handleUpdateClass = (id, field, value) => {
    setDraftClasses(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c))
  }

  const handleRemoveClass = (id) => {
    setDraftClasses(prev => prev.filter(c => c.id !== id))
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Manage Project Classes" width={550}>
      <Modal.Body style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--navy)', marginBottom: 12, textTransform: 'uppercase' }}>
            Class Ontology
          </label>
          
          {/* Formatted Table Grid (Matching BatchAIModal style) */}
          <div style={{ border: '1px solid var(--border-l)', borderRadius: 8, overflow: 'hidden' }}>
            
            {/* Table Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr 40px', background: 'var(--navy-05)', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', borderBottom: '1px solid var(--border-l)' }}>
              <div>COLOR</div>
              <div>CLASS NAME</div>
              <div></div>
            </div>
            
            {/* Table Body */}
            <div style={{ maxHeight: 300, overflowY: 'auto', background: 'var(--white)' }}>
              {draftClasses.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>
                  No classes defined. Add one below.
                </div>
              ) : (
                draftClasses.map((cls) => (
                  <div key={cls.id} style={{ display: 'grid', gridTemplateColumns: '50px 1fr 40px', gap: 12, padding: '10px 12px', borderBottom: '1px solid var(--border-l)', alignItems: 'center' }}>
                    
                    <input 
                      type="color" 
                      value={cls.color} 
                      onChange={(e) => handleUpdateClass(cls.id, 'color', e.target.value)}
                      style={{ width: 32, height: 32, padding: 0, border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', background: 'transparent' }}
                    />

                    {/* Utilizing shared FormInput from ui/index.jsx */}
                    <FormInput 
                      value={cls.name}
                      onChange={(e) => handleUpdateClass(cls.id, 'name', e.target.value)}
                      placeholder="e.g. Tumor, Necrosis..."
                    />

                    <div style={{ textAlign: 'center' }}>
                      <button 
                        onClick={() => handleRemoveClass(cls.id)}
                        title="Remove class"
                        style={{ background: 'transparent', border: 'none', color: 'var(--crimson)', opacity: 0.6, cursor: 'pointer', fontSize: 20, lineHeight: 1 }}
                        onMouseEnter={e => e.currentTarget.style.opacity = 1}
                        onMouseLeave={e => e.currentTarget.style.opacity = 0.6}
                      >
                        ×
                      </button>
                    </div>

                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <Btn variant="ghost" onClick={handleAddClass} style={{ alignSelf: 'flex-start' }}>
          + Add New Class
        </Btn>

      </Modal.Body>
      
      {/* Shared Modal Footer */}
      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose} disabled={mutation.isLoading}>Cancel</Btn>
        <Btn variant="primary" onClick={() => mutation.mutate(draftClasses)} disabled={mutation.isLoading}>
          {mutation.isLoading ? 'Saving...' : 'Save Changes'}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}