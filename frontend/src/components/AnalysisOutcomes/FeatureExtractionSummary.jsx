// components/AnalysisOutcomes/FeatureExtractionSummary.jsx
//
// Outcome card for result_type === 'feature_extraction'.
// Feature extraction produces no GeoJSON / annotation import — the summary
// shows extraction stats (tile count, feature dimension, output path) and a
// download link for the .npz file.  Uses the neutral SummaryCard variant
// (isPositive=false, isWarning=false) since there is no positive/negative call.

import React from 'react'
import { SummaryCard, SummaryRow } from './OutcomeLayout'

function formatFileSize(npzPath) {
  // We don't have file size from the outcome JSON, so just show the filename.
  if (!npzPath) return null
  return npzPath.split('/').pop()
}

export default function FeatureExtractionSummary({ outcome }) {
  if (!outcome) return null

  const nTiles     = outcome.n_tiles     ?? null
  const featDim    = outcome.feature_dim ?? null
  const tileSize   = outcome.tile_size   ?? null
  const resolution = outcome.resolution_mpp != null ? `${outcome.resolution_mpp} µm/px` : null
  const fileName   = formatFileSize(outcome.feature_file)

  return (
    <SummaryCard isPositive={false}>
      <SummaryRow
        label="Status"
        value={outcome.status?.replace(/_/g, ' ') ?? 'Extracted'}
      />
      {nTiles != null && (
        <SummaryRow label="Tiles" value={nTiles.toLocaleString()} isMono />
      )}
      {featDim != null && (
        <SummaryRow label="Feature dim" value={featDim.toLocaleString()} isMono />
      )}
      {tileSize != null && (
        <SummaryRow label="Tile size" value={`${tileSize} px`} isMono />
      )}
      {resolution && (
        <SummaryRow label="Resolution" value={resolution} isMono />
      )}
      {fileName && (
        <SummaryRow label="Output file" value={fileName} isMono />
      )}
    </SummaryCard>
  )
}