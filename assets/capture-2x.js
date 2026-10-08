// 2배 해상도 캡처 틀. 직접 고치지 않는다: scripts/make-capture.mjs 가 화면별 레시피(.ui-feedback/captures/<이름>.js)를
// 이 틀의 RECIPE·META 자리에 넣어 .ui-feedback/capture.js 를 만들고, 그 파일을 Playwright MCP browser_run_code_unsafe 의 filename 으로 넘긴다.
// 돌려주는 image 객체({ file, marks, source })를 리뷰 페이지 REVIEW 항목의 before/after 에 그대로 넣는다.
// 찍은 기록(레시피·차수·예시 응답 여부)은 리뷰 서버 캡처 기록(captures.json)에 남는다.
// page.screenshot은 화면 배율을 1로 고정하므로, CDP로 배율 2를 걸고 직접 찍는다.
// 실행 환경에서 fs를 쓸 수 없고, 다운로드 저장은 새 브라우저 첫 실행에서 page가 닫히는 문제가 있어서
// 찍은 이미지를 같은 페이지에 원본 크기로 띄운 뒤 page.screenshot(배율 1)으로 픽셀 그대로 저장한다.
async (page) => {
  const RECIPE = __RECIPE__;
  const META = __META__;
  const URL_ = new URL(RECIPE.url, META.base).href;
  const VIEWPORT = RECIPE.viewport;
  const SELECTOR = RECIPE.selector || null;
  const MARKS = RECIPE.marks || [];
  const MOCKS = RECIPE.mocks || [];

  // 앞선 캡처에서 건 예시 응답(page.route)이 남아 있으면 실제 데이터 화면에 섞이므로 먼저 지운다.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // 레시피의 예시 응답. json 이면 그대로 돌려주고, handle 이 있으면 그 함수로 처리한다.
  for (const m of MOCKS) await page.route(m.url, m.handle || ((route) => route.fulfill({ json: m.json })));
  await page.setViewportSize(VIEWPORT);
  await page.goto(URL_);
  await page.waitForLoadState('networkidle');
  // 버튼 클릭·입력처럼 캡처 전에 화면 상태를 만드는 단계
  if (RECIPE.steps) await RECIPE.steps(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 2, mobile: VIEWPORT.width < 768 });
  let clip;
  let region = null; // 찍는 영역(문서 좌표). null 이면 지금 보이는 화면
  if (SELECTOR) {
    const el = page.locator(SELECTOR).first();
    await el.scrollIntoViewIfNeeded();
    // CDP의 clip은 문서 기준 좌표라서 스크롤 위치를 더한다.
    const box = await el.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    });
    clip = { ...box, scale: 1 };
    region = box;
  }
  // 번호 상자 위치를 찍는 영역 기준 %로 잰다. 상자가 글자에 딱 붙어 번호가 첫 글자를 덮지 않게 6px 넓히고, 영역 밖은 자른다.
  const measured = await page.evaluate(({ marks, region }) => {
    const area = region || { x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight };
    const pct = (v, total) => Math.round((v / total) * 1000) / 10;
    const out = [];
    const missing = [];
    for (const m of marks) {
      const node = document.querySelector(m.selector);
      if (!node) { missing.push(m.selector); continue; }
      const r = node.getBoundingClientRect();
      const PAD = 6;
      const x1 = Math.max(r.left + window.scrollX - PAD, area.x), y1 = Math.max(r.top + window.scrollY - PAD, area.y);
      const x2 = Math.min(r.right + window.scrollX + PAD, area.x + area.width), y2 = Math.min(r.bottom + window.scrollY + PAD, area.y + area.height);
      if (x2 <= x1 || y2 <= y1) { missing.push(m.selector + ' (영역 밖)'); continue; }
      out.push({ n: m.n, x: pct(x1 - area.x, area.width), y: pct(y1 - area.y, area.height), w: pct(x2 - x1, area.width), h: pct(y2 - y1, area.height) });
    }
    const dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    return { marks: out, missing, theme: dark ? 'dark' : 'light', url: location.href };
  }, { marks: MARKS, region });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();

  // 화면 크기를 먼저 이미지 크기로 맞춘 뒤 이미지를 띄우고, 다 그려질 때까지 기다렸다 찍는다.
  // 크기를 나중에 키우면 새로 드러난 영역에 이전 페이지 화면(고정 헤더 등)이 남아 함께 찍힌다.
  const size = await page.evaluate(
    (b64) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.src = 'data:image/png;base64,' + b64;
      }),
    data,
  );
  await page.setViewportSize(size);
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}img{display:block}</style><img id="shot" src="data:image/png;base64,${data}">`,
  );
  await page.evaluate(async () => {
    await document.getElementById('shot').decode();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.screenshot({ path: META.out, clip: { x: 0, y: 0, ...size } });

  // CDP 해제 뒤 Playwright가 크기를 그대로라고 보고 무시하므로, 한 번 바꿨다가 되돌린다.
  await page.setViewportSize({ width: VIEWPORT.width + 1, height: VIEWPORT.height });
  await page.setViewportSize(VIEWPORT);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const image = {
    file: META.file,
    ...(measured.marks.length ? { marks: measured.marks } : {}),
    source: {
      url: measured.url,
      viewport: `${VIEWPORT.width}×${VIEWPORT.height}`,
      theme: measured.theme,
      at: new Date().toISOString(),
      recipe: META.recipe,
      // 예시 응답으로 바꾼 API. 리뷰 페이지에 "예시 데이터"로 보인다.
      ...(MOCKS.length ? { mocked: MOCKS.map((m) => m.label || m.url) } : {}),
      ...(RECIPE.steps ? { steps: true } : {}),
    },
  };
  // 찍은 기록을 리뷰 서버 캡처 기록에 남긴다(같은 파일은 덮어쓴다).
  await page.request.post(META.record, { data: { round: META.round, ...image } }).catch(() => {});
  return { saved: META.out, pixels: size, image, ...(measured.missing.length ? { missingMarks: measured.missing } : {}) };
}
