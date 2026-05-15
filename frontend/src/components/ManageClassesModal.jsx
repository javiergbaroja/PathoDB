// frontend/src/components/ManageClassesModal.jsx
import { useState, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { Modal, Btn, FormInput, Table, Th, Tr, Td } from './ui'
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
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 60 }}>Color</Th>
                <Th>Class Name</Th>
                <Th style={{ width: 60, textAlign: 'center' }}>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {draftClasses.length === 0 ? (
                <Tr>
                  <Td colSpan={3} style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
                    No classes defined. Add one below.
                  </Td>
                </Tr>
              ) : (
                draftClasses.map((cls) => (
                  <Tr key={cls.id}>
                    <Td>
                      <input 
                        type="color" 
                        value={cls.color} 
                        onChange={(e) => handleUpdateClass(cls.id, 'color', e.target.value)}
                        style={{ width: 32, height: 32, padding: 0, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: 'transparent' }}
                      />
                    </Td>
                    <Td>
                      <FormInput 
                        value={cls.name}
                        onChange={(e) => handleUpdateClass(cls.id, 'name', e.target.value)}
                        placeholder="e.g. Tumor, Necrosis..."
                      />
                    </Td>
                    <Td style={{ textAlign: 'center' }}>
                      <Btn 
                        variant="ghost" 
                        small
                        onClick={() => handleRemoveClass(cls.id)}
                        title="Remove class"
                        style={{ color: 'var(--crimson)', borderColor: 'transparent', padding: '4px 8px' }}
                      >
                        ✕
                      </Btn>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
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