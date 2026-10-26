const puppeteer = require('puppeteer-core');
const fs = require('fs');

// 상품명 → 이지어드민 검색어 매핑 (다를 경우만)
const SEARCH_NAMES = {
  '알래스카': '오메가',
};

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function getChromePath() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// YYYY-MM-DD 형식
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 메인 화면 팝업 전체 닫기 (로그인 직후 1회만 사용 - 해시 리셋 OK)
async function closePopups(page) {
  for (let i = 0; i < 4; i++) {
    const closed = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('button, a, span, div, p'));
      const allClose = allEls.find(el => el.textContent.trim() === '팝업 전체 닫기');
      if (allClose) { allClose.click(); return '팝업 전체 닫기'; }
      const byClass = document.querySelector('.popup-close,.btn-close,.layer-close,[class*="layerClose"],[class*="pop_close"]');
      if (byClass && byClass.offsetParent !== null) { byClass.click(); return 'class:' + byClass.className.slice(0, 30); }
      const xBtn = allEls.find(el => {
        const t = el.textContent.trim();
        return (t === '×' || t === '✕' || t === 'X') && el.offsetParent !== null;
      });
      if (xBtn) { xBtn.click(); return 'X:' + xBtn.tagName; }
      return null;
    });
    if (closed) { console.log('팝업 닫음:', closed); await sleep(800); }
    else break;
  }
}

// I100 진입 후 팝업 닫기 - X 버튼만 (팝업 전체 닫기 클릭 금지 - 해시 리셋됨)
async function closeXPopupsOnly(page) {
  for (let i = 0; i < 4; i++) {
    const closed = await page.evaluate(() => {
      const byClass = document.querySelector('.popup-close,.btn-close,.layer-close,[class*="layerClose"],[class*="pop_close"],[class*="popClose"]');
      if (byClass && byClass.offsetParent !== null) { byClass.click(); return 'class:' + byClass.className.slice(0, 30); }
      const byOnclick = Array.from(document.querySelectorAll('[onclick]')).find(el =>
        el.offsetParent !== null && /close|hide/i.test(el.getAttribute('onclick') || '')
      );
      if (byOnclick) { byOnclick.click(); return 'onclick'; }
      const xBtn = Array.from(document.querySelectorAll('button,a,span,div')).find(el => {
        const t = el.textContent.trim();
        return (t === '×' || t === '✕' || t === 'X') && el.offsetParent !== null;
      });
      if (xBtn) { xBtn.click(); return 'X:' + xBtn.className.slice(0, 20); }
      return null;
    });
    if (closed) { console.log('X팝업 닫음:', closed); await sleep(800); }
    else break;
  }
}

async function crawlBrand(brand, cred, products, startDate, endDate) {
  if (!cred || !products) throw new Error('계정 또는 제품 정보 없음');
  const chromePath = getChromePath();
  if (!chromePath) throw new Error('Chrome을 찾을 수 없습니다');

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: ['--window-size=1280,900', '--no-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1. 로그인
    await page.goto('https://www.ezadmin.co.kr/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      await doLogin(page, cred);
      await sleep(3000);
    }
    // 로그인 후 메인 화면에서 팝업 닫기 (팝업 전체 닫기 포함 - 아직 I100 진입 전이므로 OK)
    await closePopups(page);
    await sleep(500);

    const adminUrl = page.url();
    console.log('로그인 후 URL:', adminUrl);
    // 로그인 후 ka01.ezadmin.co.kr 로 이동됨
    const adminBase = adminUrl.includes('ka01') ? 'https://ka01.ezadmin.co.kr'
                    : adminUrl.includes('ezadmin.co.kr') ? new URL(adminUrl).origin
                    : 'https://ka01.ezadmin.co.kr';
    console.log('adminBase:', adminBase);

    const results = [];
    for (const productName of products) {
      try {
        console.log(`\n[${productName}] 조회 시작`);
        const data = await getProductStock(page, browser, adminBase, productName, startDate, endDate);
        results.push(data);
        await sleep(500);
      } catch (e) {
        console.error(`[${productName}] 실패:`, e.message);
        results.push({ name: productName, stockNow: null, out7d: null });
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}

async function doLogin(page, cred) {
  console.log('로그인 시도...');

  // JS 직접 주입으로 입력 (click 불필요, overlay/iframe 우회)
  const filled = await page.evaluate((domain, userId, passwd) => {
    function setVal(el, v) {
      if (!el) return false;
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const domainEl = document.querySelector('input[name="domain"]') || document.querySelector('input[id="login-domain"]');
    const idEl = document.querySelector('input[name="userid"]') || document.querySelector('input[id="login-id"]')
               || document.querySelector('input[name="m_id"]') || document.querySelector('input[name="userId"]');
    const pwEl = document.querySelector('input[type="password"]');
    return {
      domain: setVal(domainEl, domain),
      id: setVal(idEl, userId),
      pw: setVal(pwEl, passwd)
    };
  }, cred.domain, cred.userId, cred.passwd);
  console.log('입력 결과:', JSON.stringify(filled));

  // 로그인 버튼 클릭
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    page.evaluate(() => {
      const btn = document.querySelector('input.login-btn') || document.querySelector('button[type="submit"]') || document.querySelector('input[type="submit"]');
      if (btn) btn.click();
      else document.querySelector('form') && document.querySelector('form').submit();
    })
  ]);
  await sleep(2000);
  console.log('로그인 후 URL:', page.url());
}

async function navigateToI100(page) {
  // 상단 메뉴 재고관리 클릭
  await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, li, td, span'));
    const menu = all.find(el => (el.innerText || el.textContent || '').trim() === '재고관리');
    if (menu) menu.click();
  });
  await sleep(800);
  // 현재고조회 클릭
  const clicked = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const item = links.find(el => (el.innerText || el.textContent || '').trim() === '현재고조회');
    if (item) { item.click(); return 'text'; }
    const byHref = document.querySelector('a[href*="I100"]');
    if (byHref) { byHref.click(); return 'href'; }
    return null;
  });
  console.log('현재고조회 클릭:', clicked);
  await sleep(3000);
  console.log('I100 진입 후 URL:', page.url());

  // I100 콘텐츠 프레임 찾기 (template=I100 포함 프레임 우선, 없으면 page)
  const frames = page.frames();
  console.log('I100 프레임:', frames.map(f => f.url()).join(' | '));
  const i100Frame = frames.find(f => f.url().includes('template=I100') || f.url().includes('I100'));
  if (i100Frame) { console.log('I100 프레임 선택:', i100Frame.url()); return i100Frame; }
  // page 자체가 I100 URL이면 page 반환
  console.log('page 사용 (page.url:', page.url(), ')');
  return page;
}

async function getProductStock(page, browser, adminBase, productName, startDate, endDate) {
  // 메뉴 클릭으로 I100(현재고조회) 진입
  const contentFrame = await navigateToI100(page);
  await closeXPopupsOnly(page); // I100 진입 후 가이드/레이어 팝업 닫기
  await sleep(300);

  // 모든 input 목록 로그 (디버깅)
  const inputList = await contentFrame.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(el => ({
      name: el.name, id: el.id, type: el.type, visible: !!el.offsetParent
    }))
  );
  console.log('input 목록:', JSON.stringify(inputList));

  // 검색어 매핑 후 JS injection으로 입력
  const searchTerm = SEARCH_NAMES[productName] || productName;
  const typed = await contentFrame.evaluate((term) => {
    const sels = [
      'input[name="query_str"]', 'input[id="query_str"]',  // 이지어드민 현재고조회 상품명 검색
      'input[name="search_nm"]', 'input[id="search_nm"]',
      'input[name="prod_nm"]',   'input[id="prod_nm"]',
      'input[name="keyword"]',   'input[name="item_nm"]',
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) {
        el.focus(); el.value = term;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return sel;
      }
    }
    // 상품명 label 옆의 input
    const labels = Array.from(document.querySelectorAll('label, td, th, span'));
    const nmLabel = labels.find(el => (el.innerText || '').trim() === '상품명');
    if (nmLabel) {
      const next = nmLabel.nextElementSibling || nmLabel.parentElement?.nextElementSibling;
      const inp = next && next.querySelector ? next.querySelector('input[type="text"]') : null;
      if (inp) { inp.focus(); inp.value = term; inp.dispatchEvent(new Event('input', {bubbles:true})); return 'label-next'; }
    }
    const inputs = Array.from(document.querySelectorAll('input[type="text"]:not([readonly]):not([disabled])'))
                        .filter(el => el.offsetParent !== null);
    if (inputs.length) {
      const el = inputs[inputs.length - 1];
      el.focus(); el.value = term;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'fallback-visible(' + inputs.length + ')';
    }
    return null;
  }, searchTerm);

  if (!typed) {
    const bodyHtml = await contentFrame.evaluate(() => document.body.innerHTML.slice(0, 800));
    console.log('프레임 내용:', bodyHtml);
    throw new Error('검색 필드를 찾을 수 없음');
  }
  console.log('검색 필드:', typed, '검색어:', searchTerm);

  await sleep(300);
  await page.keyboard.press('F2');
  await sleep(3000);

  // 결과에서 상품코드 + 정상재고 추출 (디버그 정보 반환값에 포함)
  const stockData = await contentFrame.evaluate(() => {
    const stockTh = Array.from(document.querySelectorAll('th')).find(th => th.innerText.trim() === '정상재고');
    if (!stockTh) return { _err: 'stockTh없음' };

    const headerRow = stockTh.closest('tr');
    const cells = Array.from(headerRow.children);
    const stockIdx = cells.indexOf(stockTh);
    const codeCells = cells.filter(c => c.innerText.trim() === '상품코드');
    const codeIdx = codeCells.length > 0 ? cells.indexOf(codeCells[codeCells.length - 1]) : -1;
    const headerTable = stockTh.closest('table');
    if (stockIdx < 0 || !headerTable) return { _err: 'bad idx', stockIdx, codeIdx };

    // EZAdmin은 헤더 테이블과 데이터 테이블이 별도 <table>로 분리됨
    // headerTable에는 th 행 1개만 있고, 실제 데이터 행은 형제 테이블에 있음
    // → 문서 전체 tr에서 headerTable 소속이 아닌 행을 탐색
    const allRows = Array.from(document.querySelectorAll('tr'));

    for (const row of allRows) {
      if (headerTable.contains(row)) continue; // 헤더 테이블 행 제외
      const tds = Array.from(row.children).filter(c => c.tagName === 'TD');
      if (tds.length <= stockIdx) continue;
      const v = tds[stockIdx].innerText.replace(/,/g, '').trim();
      const n = parseInt(v);
      if (!isNaN(n) && n >= 0) {
        const productId = codeIdx >= 0 && tds[codeIdx] ? tds[codeIdx].innerText.trim() : null;
        return { stockNow: n, productId, _stockIdx: stockIdx, _codeIdx: codeIdx };
      }
    }
    const debugRows = allRows.filter(r => !headerTable.contains(r)).slice(0, 4).map(r =>
      Array.from(r.children).map(c => c.innerText.replace(/\s+/g,' ').trim().slice(0,15))
    );
    return { _err: '행없음', stockIdx, codeIdx, rowCount: allRows.length, debugRows };
  });

  if (!stockData || stockData._err !== undefined) {
    console.log('stockData 실패:', JSON.stringify(stockData));
    throw new Error('정상재고 데이터를 찾을 수 없음');
  }
  console.log('정상재고:', stockData.stockNow, '상품코드:', stockData.productId, 'idx:', stockData._stockIdx, stockData._codeIdx);

  // 재고이력 팝업 직접 접속 (클릭 없이 URL로)
  const out7d = await getOut7dByUrl(browser, adminBase, stockData.productId, stockData.stockNow, startDate, endDate);

  return { name: productName, stockNow: stockData.stockNow, out7d };
}

async function findContentFrame(page, adminBase) {
  const domain = new URL(adminBase).hostname;
  // 최대 8초 재시도
  for (let i = 0; i < 16; i++) {
    const frames = page.frames();
    if (i === 0 || i === 7) {
      console.log(`프레임 목록(${i}):`, frames.map(f => f.url()).join(' | '));
    }
    for (const frame of frames) {
      const url = frame.url();
      if (url.includes(domain) && !url.includes('index.htm') && url !== 'about:blank') {
        return frame;
      }
    }
    await sleep(500);
  }
  // fallback: 가장 긴 URL 프레임
  const frames = page.frames();
  console.log('최종 프레임 목록:', frames.map(f => f.url()).join(' | '));
  let best = page;
  for (const frame of frames) {
    if (frame.url() !== 'about:blank') { best = frame; break; }
  }
  return best;
}

async function findSearchInput(frame) {
  // 현 재고조회 검색 입력 필드 (상품명 입력)
  const sels = [
    'input[name="search_nm"]',
    'input[id="search_nm"]',
    'input[name="prod_nm"]',
    'input[name="keyword"]',
  ];
  for (const sel of sels) {
    const el = await frame.$(sel);
    if (el) { console.log('검색필드:', sel); return el; }
  }
  // 마지막 수단: 검색(F2) 버튼 바로 앞 text input
  const allInputs = await frame.$$('input[type="text"]:not([readonly]):not([disabled])');
  if (allInputs.length > 0) {
    console.log('text input 수:', allInputs.length, '→ 마지막 것 사용');
    return allInputs[allInputs.length - 1];
  }
  return null;
}

async function getOut7dByUrl(browser, adminBase, productId, stockNow, startDate, endDate) {
  if (!productId) { console.log('상품코드 없음, 팝업 스킵'); return null; }

  if (!startDate || !endDate) {
    const today = new Date();
    endDate = fmtDate(today);
    const startD = new Date(today);
    startD.setDate(startD.getDate() - 6);
    startDate = fmtDate(startD);
  }

  const encodedId = encodeURIComponent(productId);
  const popupUrl = `${adminBase}/popup35.htm?template=I101&readonly=T&product_id=${encodedId}&inout_type=0&stock=${stockNow}&start_date=${startDate}&end_date=${endDate}`;
  console.log('팝업 URL:', popupUrl);

  const popup = await browser.newPage();
  try {
    await popup.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);

    // SELECT/버튼 구조 파악 (디버그)
    const popupElems = await popup.evaluate(() => {
      const sels = Array.from(document.querySelectorAll('select')).map(s => ({
        id: s.id, name: s.name,
        opts: Array.from(s.options).map(o => ({ t: o.text.trim(), v: o.value }))
      }));
      const btns = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"],a[href^="javascript"]')).map(b => ({
        tag: b.tagName, txt: (b.innerText||b.value||'').trim().slice(0,20),
        oc: (b.getAttribute('onclick')||'').slice(0,60)
      }));
      const inputs = Array.from(document.querySelectorAll('input[type="text"]')).map(i => ({
        id: i.id, name: i.name, vis: !!i.offsetParent
      }));
      return { sels, btns, inputs };
    });
    console.log('팝업 SELECTs:', JSON.stringify(popupElems.sels));
    console.log('팝업 btns:', JSON.stringify(popupElems.btns));
    console.log('팝업 inputs:', JSON.stringify(popupElems.inputs));

    // 기간 입력 + SELECT/버튼으로 트리거
    const triggered = await popup.evaluate((sd, ed) => {
      function setVal(el, v) {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // SELECT를 "선택"(0)으로 초기화 (preset이 날짜를 덮어쓰지 않도록)
      const sel = document.getElementById('date_period_sel') || document.querySelector('select[name="date_period_sel"]');
      if (sel) { sel.value = '0'; sel.dispatchEvent(new Event('change', { bubbles: true })); }

      // ID 기반으로 날짜 입력
      const sdEl = document.getElementById('start_date') || document.querySelector('input[name="start_date"]');
      const edEl = document.getElementById('end_date')   || document.querySelector('input[name="end_date"]');
      if (sdEl && edEl) {
        setVal(sdEl, sd); setVal(edEl, ed);
      } else {
        const vis = Array.from(document.querySelectorAll('input[type="text"]:not([readonly])'))
                         .filter(e => e.offsetParent !== null);
        if (vis.length >= 2) { setVal(vis[vis.length - 2], sd); setVal(vis[vis.length - 1], ed); }
      }

      // '새로고침' 텍스트를 가진 visible SPAN/A/BUTTON 클릭
      const allEls = Array.from(document.querySelectorAll('*'));
      const refreshBtn = allEls.find(el => {
        const t = (el.innerText || el.value || '').trim();
        return t === '새로고침' && el.offsetParent !== null && el.tagName !== 'OPTION' && el.tagName !== 'SELECT';
      });
      if (refreshBtn) {
        refreshBtn.click();
        return 'click:' + refreshBtn.tagName + (refreshBtn.className ? '.' + refreshBtn.className.split(' ')[0] : '');
      }
      return 'no-trigger';
    }, startDate, endDate);
    console.log('팝업 트리거:', triggered);

    // AJAX 응답 대기 — 재고 컬럼이 숫자로 바뀔 때까지 (최대 8초)
    try {
      await popup.waitForFunction(() => {
        const trs = document.querySelectorAll('tbody tr');
        for (const row of trs) {
          const tds = row.querySelectorAll('td');
          if (!tds.length) continue;
          const first = tds[0].innerText.trim();
          if (first === '전체' || /^\d{4}/.test(first)) {
            const last = tds[tds.length - 1];
            const v = last ? last.innerText.trim() : '';
            return v !== '' && v !== '-';
          }
        }
        return false;
      }, { timeout: 8000 });
    } catch (e) {
      await sleep(1000); // timeout fallback
    }

    // 팝업 테이블 디버그
    const tableDebug = await popup.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('th')).map(th => th.innerText.trim());
      const rows = Array.from(document.querySelectorAll('tr')).map(r =>
        Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim())
      ).filter(r => r.length > 0).slice(0, 8);
      return { headers: ths, rows };
    });
    console.log('팝업 헤더:', JSON.stringify(tableDebug.headers));
    console.log('팝업 행(8):', JSON.stringify(tableDebug.rows));

    // 트랜잭션 테이블에서 배송 합산 (날짜+배송 컬럼이 있는 테이블)
    const out7d = await popup.evaluate(() => {
      // '날짜'와 '배송' 컬럼이 있는 테이블 찾기
      let transTable = null;
      for (const tbl of document.querySelectorAll('table')) {
        const ths = Array.from(tbl.querySelectorAll('th')).map(th => th.innerText.trim());
        if (ths.includes('날짜') && (ths.includes('배송') || ths.includes('출고'))) {
          transTable = tbl; break;
        }
      }

      let shipIdx = -1;
      if (transTable) {
        const ths = Array.from(transTable.querySelectorAll('th')).map(th => th.innerText.trim());
        shipIdx = ths.findIndex(t => t === '배송');
        if (shipIdx < 0) shipIdx = ths.findIndex(t => t === '출고');
      } else {
        // 전체 TH에서 찾기 (fallback)
        const allThs = Array.from(document.querySelectorAll('th'));
        allThs.forEach((th, i) => {
          const t = th.innerText.trim();
          if (t === '배송') shipIdx = i;
        });
      }
      if (shipIdx < 0) shipIdx = 3;

      const trs = transTable
        ? Array.from(transTable.querySelectorAll('tbody tr'))
        : Array.from(document.querySelectorAll('tr'));

      // 전체 합계 행
      for (const row of trs) {
        const tds = row.querySelectorAll('td');
        if (!tds.length) continue;
        const first = tds[0].innerText.trim();
        if (first === '전체' || first === '합계' || first === 'Total') {
          const v = tds[shipIdx] ? tds[shipIdx].innerText.replace(/,/g, '').trim() : '';
          const n = parseInt(v);
          if (!isNaN(n)) return n;
          // 배송 칸이 비어있으면 0 (해당 기간 출고 없음)
          return 0;
        }
      }

      // 날짜 행 합산
      let total = 0; let found = false;
      for (const row of trs) {
        const tds = row.querySelectorAll('td');
        if (!tds.length) continue;
        const first = tds[0].innerText.trim();
        if (/^\d{4}[-./]\d{2}[-./]\d{2}/.test(first)) {
          const v = tds[shipIdx] ? tds[shipIdx].innerText.replace(/,/g, '').trim() : '';
          const n = parseInt(v);
          if (!isNaN(n)) { total += n; found = true; }
        }
      }
      return found ? total : null;
    });

    console.log('7일 출고(배송):', out7d);
    return out7d;
  } finally {
    await popup.close();
  }
}

// ===== 유통기한 크롤링 =====

async function crawlExpiry(brand, cred, products) {
  if (!cred || !products) throw new Error('계정 또는 제품 정보 없음');
  const chromePath = getChromePath();
  if (!chromePath) throw new Error('Chrome을 찾을 수 없습니다');

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: ['--window-size=1280,900', '--no-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto('https://www.ezadmin.co.kr/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) { await doLogin(page, cred); await sleep(3000); }
    await closePopups(page);
    await sleep(500);

    const adminUrl = page.url();
    const adminBase = adminUrl.includes('ka01') ? 'https://ka01.ezadmin.co.kr'
                    : adminUrl.includes('ezadmin.co.kr') ? new URL(adminUrl).origin
                    : 'https://ka01.ezadmin.co.kr';

    const allRows = [];
    for (const productName of products) {
      try {
        console.log(`\n[유통기한][${productName}] 조회 시작`);
        const rows = await getProductExpiry(page, browser, adminBase, productName);
        allRows.push(...rows);
        await sleep(500);
      } catch (e) {
        console.error(`[유통기한][${productName}] 실패:`, e.message);
        allRows.push({ name: productName, expiry: null, qty: null });
      }
    }
    return allRows;
  } finally {
    await browser.close();
  }
}

async function getProductExpiry(page, browser, adminBase, productName) {
  // I100 현재고조회에서 product_id 획득
  const contentFrame = await navigateToI100(page);
  await closeXPopupsOnly(page);
  await sleep(300);

  const searchTerm = SEARCH_NAMES[productName] || productName;
  const typed = await contentFrame.evaluate((term) => {
    const sels = ['input[name="query_str"]','input[id="query_str"]','input[name="search_nm"]',
                  'input[id="search_nm"]','input[name="prod_nm"]','input[name="keyword"]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) {
        el.focus(); el.value = term;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return sel;
      }
    }
    const inputs = Array.from(document.querySelectorAll('input[type="text"]:not([readonly]):not([disabled])'))
                        .filter(el => el.offsetParent !== null);
    if (inputs.length) {
      const el = inputs[inputs.length - 1];
      el.focus(); el.value = term;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'fallback';
    }
    return null;
  }, searchTerm);

  if (!typed) throw new Error('검색 필드를 찾을 수 없음');
  await sleep(300);
  await page.keyboard.press('F2');
  await sleep(3000);

  const stockData = await contentFrame.evaluate(() => {
    const stockTh = Array.from(document.querySelectorAll('th')).find(th => th.innerText.trim() === '정상재고');
    if (!stockTh) return { _err: 'stockTh없음' };
    const headerRow = stockTh.closest('tr');
    const cells = Array.from(headerRow.children);
    const stockIdx = cells.indexOf(stockTh);
    const codeCells = cells.filter(c => c.innerText.trim() === '상품코드');
    const codeIdx = codeCells.length > 0 ? cells.indexOf(codeCells[codeCells.length - 1]) : -1;
    const headerTable = stockTh.closest('table');
    if (stockIdx < 0 || !headerTable) return { _err: 'bad idx' };
    const allRows = Array.from(document.querySelectorAll('tr'));
    for (const row of allRows) {
      if (headerTable.contains(row)) continue;
      const tds = Array.from(row.children).filter(c => c.tagName === 'TD');
      if (tds.length <= stockIdx) continue;
      const v = tds[stockIdx].innerText.replace(/,/g, '').trim();
      const n = parseInt(v);
      if (!isNaN(n) && n >= 0) {
        const productId = codeIdx >= 0 && tds[codeIdx] ? tds[codeIdx].innerText.trim() : null;
        return { productId };
      }
    }
    return { _err: '행없음' };
  });

  if (!stockData || stockData._err || !stockData.productId) throw new Error('상품코드를 찾을 수 없음: ' + JSON.stringify(stockData));
  console.log(`[유통기한][${productName}] 상품코드: ${stockData.productId}`);

  return await getExpiriesByUrl(browser, adminBase, productName, stockData.productId);
}

// 현재 컨텍스트(page 또는 frame)에서 유통기한+입고일+재고 행 추출
// 전략: 테이블의 모든 <th> 로 컬럼 인덱스 파악, <th> 없는 행만 데이터로 읽음
// '재고' 없으면 '수량' 사용 (SC01 전체 재고 테이블은 '수량' 컬럼)
async function readExpiryDetailsFromPage(ctx) {
  return await ctx.evaluate(() => {
    for (const tbl of document.querySelectorAll('table')) {
      // 테이블 내 모든 <th> 텍스트로 컬럼 인덱스 결정
      const thTexts = Array.from(tbl.querySelectorAll('th')).map(th => th.innerText.trim());
      const expiryIdx = thTexts.indexOf('유통기한');
      if (expiryIdx < 0) continue;
      const qtyIdx = thTexts.indexOf('재고') >= 0 ? thTexts.indexOf('재고') : thTexts.indexOf('수량');
      if (qtyIdx < 0) continue;
      const inboundIdx = thTexts.indexOf('입고일');

      // <th> 없는 행 = 데이터 행
      const dataRows = Array.from(tbl.querySelectorAll('tr')).filter(tr => !tr.querySelector('th'));
      const data = [];
      for (const row of dataRows) {
        const tds = row.querySelectorAll('td');
        const expiry  = tds[expiryIdx] ? tds[expiryIdx].innerText.trim() : '';
        const qty     = tds[qtyIdx]    ? parseInt(tds[qtyIdx].innerText.replace(/,/g,'').trim()) : NaN;
        const inbound = (inboundIdx >= 0 && tds[inboundIdx]) ? tds[inboundIdx].innerText.trim() : '';
        const inboundMonth = inbound.length >= 7 ? inbound.slice(0, 7) : '';
        if (expiry && /\d{4}/.test(expiry) && !isNaN(qty) && qty > 0) {
          data.push({ expiry, inboundMonth, qty });
        }
      }
      if (data.length) return data;
    }
    return [];
  });
}

async function getExpiriesByUrl(browser, adminBase, productName, productId) {
  const popupUrl = `${adminBase}/popup35.htm?template=SC01&product_id=${encodeURIComponent(productId)}`;
  console.log('[유통기한] SC01 URL:', popupUrl);

  const popup = await browser.newPage();
  try {
    await popup.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2500);

    // iframe 감지 - 메인 페이지에 테이블이 없으면 프레임 탐색
    let ctx = popup;
    const mainTables = await popup.evaluate(() => document.querySelectorAll('table').length);
    if (mainTables === 0) {
      for (const frame of popup.frames()) {
        try {
          const n = await frame.evaluate(() => document.querySelectorAll('table').length);
          if (n > 0) { ctx = frame; break; }
        } catch (e) {}
      }
    }
    console.log('[유통기한] 컨텍스트:', ctx === popup ? 'main' : 'frame', '테이블 수:', mainTables);

    // 테이블 구조 디버그
    const pageDebug = await ctx.evaluate(() =>
      Array.from(document.querySelectorAll('table')).map((tbl, i) => ({
        i,
        ths: Array.from(tbl.querySelectorAll('th')).map(th => th.innerText.trim()),
        firstRowCells: Array.from(tbl.querySelectorAll('tr:first-child th,tr:first-child td')).map(td => td.innerText.trim().slice(0,20)),
        bodyRows: tbl.querySelectorAll('tbody tr').length
      }))
    );
    console.log('[유통기한] 테이블 구조:', JSON.stringify(pageDebug));

    // 왼쪽 로케이션 테이블 찾기
    // '로케이션'(정확히 일치) + ('창고'|'수량'|'재고') 헤더 행 → 이후 행들을 데이터로 봄
    // tbody 유무 무관하게 allRows.slice() 사용
    const locInfo = await ctx.evaluate(() => {
      const COMPANIONS = ['창고', '수량', '재고'];
      for (const tbl of document.querySelectorAll('table')) {
        const allRows = Array.from(tbl.querySelectorAll('tr'));
        for (let ri = 0; ri < allRows.length; ri++) {
          const cells = Array.from(allRows[ri].querySelectorAll('th, td'));
          const hdrs = cells.map(c => c.innerText.trim());
          if (hdrs.some(t => t === '로케이션' || t === '로케이션명') &&
              hdrs.some(t => COMPANIONS.includes(t))) {
            const dataRows = allRows.slice(ri + 1).filter(tr => tr.querySelectorAll('td').length > 0);
            if (dataRows.length > 0) {
              return { count: dataRows.length, labels: dataRows.map(r =>
                Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim()).join('|')) };
            }
          }
        }
      }
      return { count: 0, labels: [] };
    });
    console.log('[유통기한] 로케이션:', JSON.stringify(locInfo));

    // (expiry|inboundMonth) → qty 누적 맵
    const rowMap = {};

    // 전체 재고 테이블 먼저 시도 (SC01에 전체 현황 테이블이 있는 경우)
    const initial = await readExpiryDetailsFromPage(ctx);
    console.log('[유통기한] 초기/전체 데이터:', JSON.stringify(initial));

    if (initial.length > 0) {
      // 전체 테이블에서 데이터 획득 — 로케이션 클릭 불필요
      for (const r of initial) {
        const key = r.expiry + '|' + (r.inboundMonth || '');
        rowMap[key] = (rowMap[key] || 0) + r.qty;
      }
    } else {
      // 전체 테이블 없음 — 로케이션 순차 클릭 (i=0 포함)
      for (let i = 0; i < locInfo.count; i++) {
        try {
          const clicked = await ctx.evaluate((idx) => {
            const COMPANIONS = ['창고', '수량', '재고'];
            for (const tbl of document.querySelectorAll('table')) {
              const allRows = Array.from(tbl.querySelectorAll('tr'));
              for (let ri = 0; ri < allRows.length; ri++) {
                const hdrs = Array.from(allRows[ri].querySelectorAll('th, td')).map(c => c.innerText.trim());
                if (hdrs.some(t => t === '로케이션' || t === '로케이션명') &&
                    hdrs.some(t => COMPANIONS.includes(t))) {
                  const dataRows = allRows.slice(ri + 1).filter(tr => tr.querySelectorAll('td').length > 0);
                  if (dataRows[idx]) { dataRows[idx].click(); return true; }
                }
              }
            }
            return false;
          }, i);
          if (!clicked) { console.log(`[유통기한] 로케이션${i} 클릭 실패`); continue; }
          await sleep(1500);

          const details = await readExpiryDetailsFromPage(ctx);
          console.log(`[유통기한] 로케이션${i}(${locInfo.labels[i]||''}) 상세:`, JSON.stringify(details));
          for (const r of details) {
            const key = r.expiry + '|' + (r.inboundMonth || '');
            rowMap[key] = (rowMap[key] || 0) + r.qty;
          }
        } catch (e) {
          console.log(`[유통기한] 로케이션${i} 오류:`, e.message);
        }
      }
    }

    const result = Object.entries(rowMap)
      .map(([key, qty]) => {
        const [expiry, inboundMonth] = key.split('|');
        return { name: productName, expiry, inboundMonth: inboundMonth || '', qty };
      })
      .sort((a, b) => a.expiry.localeCompare(b.expiry));

    console.log('[유통기한] 최종:', JSON.stringify(result));
    return result.length ? result : [{ name: productName, expiry: null, inboundMonth: '', qty: null }];
  } finally {
    await popup.close();
  }
}

module.exports = { crawlBrand, crawlExpiry };
