// Keep the movement thumb captured while the other hand drags the scene to look.
export function initMobileViewer({ isTouch, movement, start, stop, wake }) {
  const $ = (id) => document.getElementById(id)
  document.body.classList.toggle('touch-viewer', isTouch)
  $('startWalking').onclick = start
  const pad = $('movePad')
  let pointer = null, originX = 0, originY = 0
  const release = () => {
    const old = pointer; pointer = null
    if (old !== null && pad.hasPointerCapture(old)) pad.releasePointerCapture(old)
    pad.classList.remove('active')
    movement.x = movement.y = 0
    $('moveStick').style.transform = ''
  }
  const reset = () => { release(); stop() }
  const update = (e) => {
    const radius = pad.clientWidth * 0.28
    const dx = e.clientX - originX, dy = e.clientY - originY
    const length = Math.hypot(dx, dy), scale = Math.min(1, radius / (length || 1))
    movement.x = length < 5 ? 0 : dx * scale / radius
    movement.y = length < 5 ? 0 : dy * scale / radius
    $('moveStick').style.transform = `translate(${dx * scale}px, ${dy * scale}px)`
    wake()
  }
  pad.addEventListener('pointerdown', (e) => {
    if (pointer !== null || e.button !== 0) return
    e.preventDefault(); pointer = e.pointerId
    const rect = pad.getBoundingClientRect()
    originX = rect.left + rect.width / 2; originY = rect.top + rect.height / 2
    pad.setPointerCapture(pointer); pad.classList.add('active'); update(e)
  })
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === pointer) { e.preventDefault(); update(e) } })
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(event, (e) => { if (e.pointerId === pointer) release() })
  addEventListener('blur', reset)
  addEventListener('resize', reset)
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset() })
  return { reset }
}
