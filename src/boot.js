// Loads the apartment spec (?apt=id), fills in the title block, then starts the 3D app built from it.
import { loadSpec, describe, isPrivate, setPrivate } from './store.js'
import { icon } from './icons.js'

const q = new URLSearchParams(location.search)
const id = q.get('apt') || 'apartment-1'
const spec = await loadSpec(id)
if (!spec) location.replace('/')
else {
  window.__SPEC = spec
  const $ = (i) => document.getElementById(i)
  const renderTitle = () => {
    const d = describe(spec), hide = isPrivate()
    $('aptName').textContent = d.title
    $('aptAddr').textContent = d.sub
    $('aptCells').innerHTML = d.cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')
    document.title = hide ? 'Homevisual' : `${spec.name} in 3D`
    $('privacyBtn').innerHTML = icon(hide ? 'eye-slash' : 'eye')
    $('privacyBtn').setAttribute('aria-pressed', String(hide))
    $('privacyBtn').title = hide ? 'Show address' : 'Hide address'
    $('showAddress').checked = !hide
    document.body.classList.toggle('address-hidden', hide)
  }
  $('privacyBtn').onclick = () => setPrivate(!isPrivate())
  $('showAddress').onchange = (e) => setPrivate(!e.target.checked)
  addEventListener('hemma-private', renderTitle)
  renderTitle()
  $('editPlanLink').href = `/editor.html?apt=${encodeURIComponent(id)}`
  await import('./main.js')
  renderTitle() // main.js sets its own document title
}
