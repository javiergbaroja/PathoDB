// Attaches an interactive measuring ruler to a single OpenSeadragon viewer.
// Press-drag draws a line and labels its length in µm/mm using `mpp`
// (microns per pixel). Returns a cleanup function that detaches everything
// and restores mouse navigation.
export function attachRuler(viewer, mpp) {
  if (!viewer?.element) return () => {}

  const container = viewer.element
  viewer.setMouseNavEnabled(false)

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  Object.assign(svg.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: 100,
  })
  container.appendChild(svg)

  let sp = null, line = null, label = null
  const tracker = new window.OpenSeadragon.MouseTracker({
    element: container,
    pressHandler: e => {
      svg.innerHTML = ''
      sp   = e.position
      line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('stroke', '#00ffcc'); line.setAttribute('stroke-width', '2')
      svg.appendChild(line)
      label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      label.setAttribute('fill', '#00ffcc')
      label.setAttribute('style', 'font-family:monospace;font-size:13px;font-weight:bold;paint-order:stroke;stroke:#000;stroke-width:3px')
      svg.appendChild(label)
    },
    dragHandler: e => {
      if (!sp || !line) return
      const ep = e.position
      line.setAttribute('x1', sp.x); line.setAttribute('y1', sp.y)
      line.setAttribute('x2', ep.x); line.setAttribute('y2', ep.y)
      const iz  = viewer.world.getItemAt(0)?.viewportToImageZoom(viewer.viewport.getZoom(true)) || 1
      const um  = (Math.hypot(ep.x - sp.x, ep.y - sp.y) / iz) * (mpp || 0.25)
      label.textContent = um >= 1000 ? `${(um / 1000).toFixed(2)} mm` : `${um.toFixed(1)} µm`
      label.setAttribute('x', ep.x + 10); label.setAttribute('y', ep.y - 10)
    },
  })

  return () => {
    tracker.destroy()
    if (container.contains(svg)) container.removeChild(svg)
    if (viewer.viewport) viewer.setMouseNavEnabled(true)
  }
}
