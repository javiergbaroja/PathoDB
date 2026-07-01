// frontend/src/vendor/openseadragon-global.js
//
// Makes OpenSeadragon available as `window.OpenSeadragon` BEFORE anything
// else runs — specifically before '../vendor/openseadragon-scalebar.js',
// which expects OpenSeadragon to already exist as a global variable.
//
// This must be imported (for its side effect) ahead of the scalebar import,
// wherever OpenSeadragon is first used. Right now that's useOSDViewer.js.
 
import OpenSeadragon from 'openseadragon'
 
window.OpenSeadragon = OpenSeadragon
