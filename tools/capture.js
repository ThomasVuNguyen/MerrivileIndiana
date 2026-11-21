// Screenshots of each concept, for review. Run through the Playwright MCP
// `browser_run_code_unsafe` tool with the dev server on :5180.
async (page) => {
  const BASE = 'http://localhost:5180/?clean'
  const OUT = '/home/thomas/recordings/merrivile'
  await page.setViewportSize({ width: 1440, height: 900 })

  const shot = (name) => page.screenshot({ path: `${OUT}-${name}.png` })
  const open = async (v, hash) => {
    await page.goto(`${BASE}&v=${v}${hash}`)
    await page.waitForTimeout(2200)
  }
  // Click the front-most triangle of a part, so the click lands on visible geometry.
  const clickPart = async (id) => {
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
        if (area > 4 && (!best || d < best.d)) best = { d, m }
      }
      const p = best.m.project(s.camera)
      const r = s.gl.domElement.getBoundingClientRect()
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height }
    }, id)
    await page.mouse.click(pt.x, pt.y)
    await page.waitForTimeout(500)
  }

  // Auth + projects
  for (const v of ['a', 'b', 'c']) {
    await open(v, '#/login')
    await shot(`${v}-login`)
    await open(v, '#/projects')
    await shot(`${v}-projects`)
  }

  // A: Studio
  await open('a', '#/p/actuator')
  await shot('a-1-default')
  await page.keyboard.press('e')
  await page.waitForTimeout(1600)
  await clickPart('ring-gear')
  await shot('a-2-exploded-selected')
  await page.getByRole('button', { name: 'build123d' }).click()
  await page.waitForTimeout(300)
  await shot('a-3-inspector-source')
  await page.getByRole('button', { name: 'Export' }).click()
  await page.waitForTimeout(300)
  await shot('a-4-export-menu')

  // B: Paper
  await open('b', '#/p/actuator')
  await shot('b-1-default')
  await page.keyboard.press('e')
  await page.waitForTimeout(1600)
  await clickPart('planets-3')
  await shot('b-2-exploded-callout')
  await page.getByRole('button', { name: 'Expand chat' }).click()
  await page.waitForTimeout(400)
  await shot('b-3-chat-open')

  // C: Instrument
  await open('c', '#/p/actuator')
  await page.getByText('Housing', { exact: true }).last().click()
  await page.waitForTimeout(300)
  await page.locator('.outline-inspect input[type=range]').fill('0.25')
  await page.waitForTimeout(500)
  await shot('c-1-transparent-housing')
  await page.keyboard.press('Escape')
  await page.keyboard.press('s')
  await page.waitForTimeout(800)
  await clickPart('output-flange')
  await shot('c-2-section')
  return 'ok'
}
