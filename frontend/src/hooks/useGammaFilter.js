import { useEffect } from 'react'

// Ensures a single global SVG gamma filter (#sv-gamma) exists and keeps its
// exponent in sync with `gamma`. Both viewers apply it via `filter: url(#sv-gamma)`.
export function useGammaFilter(gamma) {
  useEffect(() => {
    let svg = document.getElementById('sv-gamma-svg')
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('id', 'sv-gamma-svg')
      svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
      svg.innerHTML = `<defs><filter id="sv-gamma"><feComponentTransfer>
        <feFuncR type="gamma" exponent="1"/>
        <feFuncG type="gamma" exponent="1"/>
        <feFuncB type="gamma" exponent="1"/>
      </feComponentTransfer></filter></defs>`
      document.body.appendChild(svg)
    }
    const exponent = (1 / gamma).toFixed(4)
    svg.querySelectorAll('feFuncR, feFuncG, feFuncB')
      .forEach(el => el.setAttribute('exponent', exponent))
  }, [gamma])
}
