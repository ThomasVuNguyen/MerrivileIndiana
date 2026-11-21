// Screenshots of the Paper concept (option B): assembly and part documents,
// motion and fit. Run through the Playwright MCP `browser_run_code_unsafe`
// tool with the dev server on :5180.
async (page) => {
  const OUT = '/home/thomas/recordings/merrivile-b2'
  await page.setViewportSize({ width: 1440, height: 900 })
  const shot = (name) => page.screenshot({ path: `${OUT}-${name}.png` })
  const result = {}

  // Click the front-most triangle of a placed instance.
  const clickInstance = async (id, dbl = false) => {
    const pt = await page.evaluate((id) => {
      const s = window.__three
      const mesh = s.scene.getObjectByName(id)
      const pos = mesh.geometry.attributes.position
      const V = mesh.position.constructor
      const a = new V(), b = new V(), c = new V()
      let best = null
      for (let i = 0; i < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
        b.fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld)
        c.fromBufferAttribute(pos, i + 2).applyMatrix4(mesh.matrixWorld)
        const m = a.clone().add(b).add(c).divideScalar(3)
        const d = m.distanceTo(s.camera.position)
        const area = b.clone().sub(a).cross(c.clone().sub(a)).length()
        if (area > 2 && (!best || d < best.d)) best = { d, m }
      }
      const p = best.m.project(s.camera)
      const r = s.gl.domElement.getBoundingClientRect()
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height }
    }, id)
    if (dbl) await page.mouse.dblclick(pt.x, pt.y)
    else await page.mouse.click(pt.x, pt.y)
    await page.waitForTimeout(600)
  }
  const hide = async (name) => {
    await page.locator('.partlist-row', { hasText: name }).hover()
    await page.getByRole('button', { name: `Hide ${name}` }).click()
  }

  await page.goto('http://localhost:5180/?clean&v=b#/p/actuator')
  await page.waitForTimeout(3000)
  await shot('1-main-assembly')

  // Exploded, with a planet picked in the viewer.
  await page.keyboard.press('e')
  await page.waitForTimeout(1800)
  await clickInstance('planet-1')
  result.callout = await page.locator('.callout-card strong').textContent()
  await shot('2-exploded-callout')
  await page.keyboard.press('Escape')
  await page.keyboard.press('e')
  await page.waitForTimeout(1200)

  // Hide the outer parts and run the motor.
  for (const n of ['Housing', 'Rotor can', 'Output flange', 'Crossed roller bearing', 'Carrier plate']) await hide(n)
  await page.getByRole('button', { name: 'Run' }).click()
  await page.waitForTimeout(2600)
  await page.getByRole('button', { name: 'Pause' }).click()
  result.readout = await page.locator('.motion-readout').textContent()
  await shot('3-motion')

  // Fit check, then inspect one clash.
  await page.getByRole('button', { name: 'Check fit' }).click()
  await page.waitForTimeout(300)
  result.fitMain = await page.locator('.clashes li').count()
  await page.locator('.clashes button').nth(2).click()
  await page.waitForTimeout(1400)
  await shot('4-clash')
  await page.keyboard.press('Escape')

  // Part document.
  await page.locator('.partlist-row', { hasText: 'Planet gear' }).click()
  await page.waitForTimeout(1600)
  result.part = await page.locator('.paper-top').textContent()
  await shot('5-part-planet')
  await page.locator('.sheet-source summary').click()
  await page.locator('.partlist-row', { hasText: 'Ring gear' }).click()
  await page.waitForTimeout(1500)
  await shot('6-part-ring-source')

  // "Used in" opens the sub-assembly document.
  await page.locator('.paper-sheet').getByRole('button', { name: 'Gearbox' }).click()
  await page.waitForTimeout(1600)
  result.sub = await page.locator('.paper-top').textContent()
  result.fitGearbox = await page.locator('.clashes li').count()
  await shot('7-gearbox-assembly')

  // Esc from a part returns to the assembly it was opened from.
  await page.locator('.partlist-row', { hasText: 'Carrier plate' }).click()
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  result.escBack = await page.locator('.paper-top').textContent()
  return result
}
