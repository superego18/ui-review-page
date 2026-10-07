// 2배 해상도 캡처. Playwright MCP의 browser_run_code_unsafe에 이 함수를 그대로 넘긴다.
// 맨 위 네 값만 바꾼다. 페이지는 미리 열어 두지 않아도 된다(URL로 연다).
// page.screenshot은 화면 배율을 1로 고정하므로, CDP로 배율 2를 걸고 직접 찍은 뒤
// 다운로드 저장으로 파일을 쓴다(실행 환경에서 fs를 쓸 수 없음).
async (page) => {
  const URL_ = 'http://localhost:3001/';
  const OUT = '/절대경로/.ui-feedback/r1-화면.png';
  const VIEWPORT = { width: 1440, height: 900 }; // 모바일은 { width: 390, height: 844 }
  const SELECTOR = null; // 특정 영역만 찍으려면 CSS 선택자, 한 화면 전체면 null

  // API 응답을 흉내 내야 하면 여기서 page.route(...)를 goto 전에 건다.
  await page.setViewportSize(VIEWPORT);
  await page.goto(URL_);
  await page.waitForLoadState('networkidle');
  // 버튼 클릭·입력처럼 캡처 전에 화면 상태를 만들어야 하면 여기에 넣는다.

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  let clip;
  if (SELECTOR) {
    const el = page.locator(SELECTOR).first();
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();

  const download = page.waitForEvent('download');
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    a.download = 'capture.png';
    document.body.append(a);
    a.click();
    a.remove();
  }, data);
  await (await download).saveAs(OUT);

  // CDP 해제 뒤 Playwright가 크기를 그대로라고 보고 무시하므로, 한 번 바꿨다가 되돌린다.
  await page.setViewportSize({ width: VIEWPORT.width + 1, height: VIEWPORT.height });
  await page.setViewportSize(VIEWPORT);
  return { saved: OUT, viewport: await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]) };
}
