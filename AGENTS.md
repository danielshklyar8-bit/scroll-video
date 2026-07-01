# AGENTS.md

## Cursor Cloud specific instructions

This repo contains two independent static front-end pieces (no build step, no package manager, no backend):

- `index.html` + `rust.mp4` (repo root): a scroll-to-scrub video page.
- `particle-silhouette/` (`index.html` + `main.js`): a webcam BodyPix installation / hand-catch game. It expects an `Electric SHOCK.mp3` next to `main.js` for the sizzle sound; if that file is absent the code falls back to a synthesized tone.

### Running / serving

- Serve statically from the repo root, e.g. `python3 -m http.server 8000`, then open the page you want (`http://localhost:8000/` or `http://localhost:8000/particle-silhouette/index.html`). Opening `particle-silhouette` as a `file://` URL will not work because the browser blocks `getUserMedia` and the module fetch.

### Testing `particle-silhouette` in Cursor Cloud (no webcam, and CDN may be needed)

- The live mode needs a real webcam + a person for BodyPix to segment, which the cloud VM does not have. Use the camera-less **demo mode** instead: `http://localhost:8000/particle-silhouette/index.html?demo=1` (auto-plays with a synthetic figure and auto-controlled hands), or `?demo=mouse` to drive one hand with the mouse. Demo mode does not require TensorFlow.js/BodyPix, so it also works without internet access.
- Live (non-demo) mode loads TensorFlow.js + BodyPix from a CDN (`cdn.jsdelivr.net`), so it needs internet access in the browser.
- Audio (the sizzle/shock sound) only starts after the first click/tap on the page due to browser autoplay policy — click once before expecting sound.
- Opening DevTools pauses `requestAnimationFrame` rendering; close DevTools to resume the animation.
