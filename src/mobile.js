// Pointer capture keeps both thumbs independent, even when they leave their pads.
export function initMobileViewer({ isTouch, movement, start, look, stop, wake }) {
  const $ = (id) => document.getElementById(id)
  document.body.classList.toggle('touch-viewer', isTouch)
  $('startWalking').onclick = start
  $('dismissRotate').onclick = () => $('rotateTip').hidden = true
  const resets = []
  const reset = () => { resets.forEach((fn) => fn()); movement.x = movement.y = 0; stop() }
  for (const [id, move] of [['movePad', true], ['lookPad', false]]) {
    const pad = $(id)
    let pointer = null, originX = 0, originY = 0, lastX = 0, lastY = 0
    const release = () => {
      const old = pointer; pointer = null
      if (old !== null && pad.hasPointerCapture(old)) pad.releasePointerCapture(old)
      pad.classList.remove('active')
      if (move) { movement.x = movement.y = 0; $('moveStick').style.transform = '' }
    }
    resets.push(release)
    const update = (e) => {
      if (move) {
        const radius = pad.clientWidth * 0.28
        const dx = e.clientX - originX, dy = e.clientY - originY
        const length = Math.hypot(dx, dy), scale = Math.min(1, radius / (length || 1))
        movement.x = length < 5 ? 0 : dx * scale / radius
        movement.y = length < 5 ? 0 : dy * scale / radius
        $('moveStick').style.transform = `translate(${dx * scale}px, ${dy * scale}px)`
      } else look(e.clientX - lastX, e.clientY - lastY)
      lastX = e.clientX; lastY = e.clientY; wake()
    }
    pad.addEventListener('pointerdown', (e) => {
      if (pointer !== null || e.button !== 0) return
      e.preventDefault(); pointer = e.pointerId
      const rect = pad.getBoundingClientRect()
      originX = rect.left + rect.width / 2; originY = rect.top + rect.height / 2
      lastX = e.clientX; lastY = e.clientY
      pad.setPointerCapture(pointer); pad.classList.add('active'); update(e)
    })
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === pointer) { e.preventDefault(); update(e) } })
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(event, (e) => { if (e.pointerId === pointer) release() })
  }
  addEventListener('blur', reset)
  addEventListener('resize', reset)
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset() })
  const fullscreen = $('fullscreenWalk')
  if (!document.documentElement.requestFullscreen && !document.fullscreenEnabled) fullscreen.hidden = true
  fullscreen.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else {
        await document.documentElement.requestFullscreen()
        // Browsers that support locking need fullscreen and a user gesture.
        try { await screen.orientation?.lock?.('landscape') } catch { /* manual rotation works everywhere */ }
      }
    } catch { fullscreen.textContent = 'Turn phone sideways' }
  }
  document.addEventListener('fullscreenchange', () => { fullscreen.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; reset() })
  return { reset }
}
