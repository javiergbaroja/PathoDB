// frontend/src/pages/TMADetail/TMAUploadWizard.jsx
import { useState } from 'react';
import { api } from '../../api'
import { Btn } from '../../components/ui';

const TMACsvInstructions = ({ uploadType }) => {
  if (uploadType === 'cores') {
    return (
      <div style={{ background: 'var(--navy-05)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16, fontSize: 13 }}>
        <h4 style={{ fontWeight: 600, color: 'var(--navy)', marginBottom: 8 }}>Grid Mapping CSV Format</h4>
        <p style={{ color: 'var(--text-2)', marginBottom: 12 }}>Exact column headers required. `row` and `col` must be integers.</p>
        <div style={{ overflowX: 'auto', background: 'white', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-l)' }}>
          <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ background: 'var(--navy-05)', borderBottom: '1px solid var(--border)' }}>
              <tr>
                <th style={{ padding: '8px 12px', fontFamily: 'monospace' }}>row</th>
                <th style={{ padding: '8px 12px', fontFamily: 'monospace' }}>col</th>
                <th style={{ padding: '8px 12px', fontFamily: 'monospace' }}>identifier</th>
                <th style={{ padding: '8px 12px', fontFamily: 'monospace' }}>core_type</th>
                <th style={{ padding: '8px 12px', fontFamily: 'monospace' }}>description</th>
              </tr>
            </thead>
            <tbody style={{ fontFamily: 'monospace', color: 'var(--text-2)' }}>
                <tr style={{ borderBottom: '1px solid var(--border-l)' }}>
                    <td style={{ padding: '6px 12px' }}>1</td>
                    <td style={{ padding: '6px 12px' }}>1</td>
                    <td style={{ padding: '6px 12px' }}>B08.17770_I_I</td>
                    <td style={{ padding: '6px 12px' }}>tissue</td>
                    <td style={{ padding: '6px 12px' }}>Tumor center</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border-l)' }}>
                    <td style={{ padding: '6px 12px' }}>1</td>
                    <td style={{ padding: '6px 12px' }}>2</td>
                    <td style={{ padding: '6px 12px' }}>B18.12345_1-A</td>
                    <td style={{ padding: '6px 12px' }}>tissue</td>
                    <td style={{ padding: '6px 12px' }}>Tumor front</td>
                </tr>
                <tr>
                    <td style={{ padding: '6px 12px' }}>1</td>
                    <td style={{ padding: '6px 12px' }}>3</td>
                    <td style={{ padding: '6px 12px' }}></td>
                    <td style={{ padding: '6px 12px' }}>control</td>
                    <td style={{ padding: '6px 12px' }}></td>
                </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (uploadType === 'scans') {
    return (
      <div style={{ background: 'var(--navy-05)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16, fontSize: 13 }}>
        <h4 style={{ fontWeight: 600, color: 'var(--navy)', marginBottom: 8 }}>Scan Upload CSV Format</h4>
        <p style={{ color: 'var(--text-2)', marginBottom: 12 }}>Map absolute NFS paths to registered stains.</p>
        <div style={{ overflowX: 'auto', background: 'white', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-l)' }}>
          <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ background: 'var(--navy-05)', borderBottom: '1px solid var(--border)' }}>
              <tr>
                <th style={{ padding: '8px 12px', fontFamily: 'monospace' }}>file_path</th>
                <th style={{ padding: '8px 12px', fontFamily: 'monospace' }}>stain_name</th>
              </tr>
            </thead>
            <tbody style={{ fontFamily: 'monospace', color: 'var(--text-2)' }}>
              <tr>
                <td style={{ padding: '6px 12px' }}>/mnt/nfs/scans/2026/TMA_001_HE.ndpi</td>
                <td style={{ padding: '6px 12px' }}>HE</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  return null;
};

export default function TMAUploadWizard({ tmaId, onComplete }) {
  const [step, setStep] = useState('cores'); // 'cores' then 'scans'
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      if (step === 'cores') {
        const res = await api.uploadTMACoresCSV(tmaId, file);
        // Intercept silent failures
        if (res.message && res.message.includes('Mapped 0 cores')) {
            setError('0 cores were mapped. Please check your CSV format, headers, and delimiter.');
            setLoading(false);
            return;
        }
        setStep('scans');
        setFile(null);
      } else {
        const res = await api.uploadTMAScansCSV(tmaId, file);
        // Intercept silent failures
        if (res.message && res.message.includes('Registered 0 WSI scans')) {
            setError('0 scans were registered. Check for typos in "file_path" or "stain_name", and ensure paths are exact.');
            setLoading(false);
            return;
        }
        onComplete(); 
      }
    } catch (e) {
      setError(e.message || 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#111827', padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 'var(--radius-xl)', padding: 32, width: '100%', maxWidth: 600 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--navy)', marginBottom: 8 }}>
          {step === 'cores' ? 'Step 1: Map TMA Grid' : 'Step 2: Upload TMA Scans'}
        </h2>
        <p style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 24 }}>
          {step === 'cores' 
            ? 'Upload a CSV defining the physical layout and patient blocks of this Tissue Microarray.' 
            : 'Upload a CSV pointing to the Whole Slide Images corresponding to this TMA.'}
        </p>

        <TMACsvInstructions uploadType={step} />

        <input type="file" accept=".csv" onChange={e => {setFile(e.target.files[0]); setError('');}} style={{ marginBottom: 16, display: 'block' }} />

        {error && <div style={{ color: 'var(--crimson)', fontSize: 13, marginBottom: 16, padding: 8, background: 'var(--crimson-10)', borderRadius: 'var(--radius-sm)' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Btn variant="primary" onClick={handleUpload} disabled={!file || loading}>
            {loading ? 'Uploading...' : 'Upload & Continue'}
          </Btn>
        </div>
      </div>
    </div>
  );
}