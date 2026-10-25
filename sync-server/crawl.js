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

  // 결과에서 상품코드 + 정상재고 추출
  const stockData = await contentFrame.evaluate(() => {
    const ths = Array.from(document.querySelectorAll('table thead th, table th'));
    let stockIdx = -1, codeIdx = -1;
    ths.forEach((th, i) => {
      const t = th.innerText.trim();
      if (t === '정상재고') stockIdx = i;
      if (t === '상품코드') codeIdx = i;
    });
    console.log('stockIdx:', stockIdx, 'codeIdx:', codeIdx);

    const rows = document.querySelectorAll('table tbody tr');
    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      if (!tds.length) continue;
      // 정상재고 컬럼 인덱스로 추출
      if (stockIdx >= 0 && tds[stockIdx]) {
        const n = parseInt(tds[stockIdx].innerText.replace(/,/g, '').trim());
        const productId = codeIdx >= 0 ? tds[codeIdx].innerText.trim() : null;
        if (!isNaN(n) && n >= 0) return { stockNow: n, productId };
      }
    }
    return null;
  });

  if (!stockData) {
    // 디버그: 테이블 헤더 + 첫 2행 출력
    const tblDebug = await contentFrame.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('table th')).map(th => th.innerText.trim());
      const rows = Array.from(document.querySelectorAll('table tbody tr')).slice(0, 2).map(r =>
        Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim())
      );
      return { ths, rows };
    });
    console.log('검색결과 헤더:', JSON.stringify(tblDebug.ths));
    console.log('검색결과 행:', JSON.stringify(tblDebug.rows));
    throw new Error('정상재고 데이터를 찾을 수 없음');
  }
  console.log('정상재고:', stockData.stockNow, '상품코드:', stockData.productId);

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
    startD.setDate(startD.getDate() - 7);
    startDate = fmtDate(startD);
  }

  const popupUrl = `${adminBase}/popup35.htm?template=I101&readonly=T&product_id=${productId}&inout_type=0&stock=${stockNow}`;
  console.log('팝업 URL:', popupUrl);

  const popup = await browser.newPage();
  try {
    await popup.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);

    // 기간 입력 (JS injection)
    const dateSet = await popup.evaluate((sd, ed) => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"]:not([readonly])'));
      function setVal(el, v) {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (inputs.length >= 1) setVal(inputs[0], sd);
      if (inputs.length >= 2) setVal(inputs[1], ed);
      return inputs.length;
    }, startDate, endDate);
    console.log('팝업 날짜 입력:', dateSet, '개 필드');

    // 새로고침 버튼 클릭 (JS로 찾아 클릭 - :has-text 미지원)
    const refreshed = await popup.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"], button'));
      const btn = els.find(el => (el.value || el.textContent || '').trim() === '새로고침');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!refreshed) await popup.keyboard.press('Enter');
    await sleep(2000);

    // 팝업 테이블 디버그
    const tableDebug = await popup.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('th')).map(th => th.innerText.trim());
      const rows = Array.from(document.querySelectorAll('tr')).map(r =>
        Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim())
      ).filter(r => r.length > 0).slice(0, 5);
      return { headers: ths, rows };
    });
    console.log('팝업 헤더:', JSON.stringify(tableDebug.headers));
    console.log('팝업 행(5):', JSON.stringify(tableDebug.rows));

    // 배송 전체 합계 추출
    const out7d = await popup.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('th'));
      // 헤더에서 배송 컬럼 인덱스 찾기
      let shipIdx = -1;
      ths.forEach((th, i) => {
        const t = th.innerText.trim();
        if (t === '배송' || t === '출고') shipIdx = i;
      });
      if (shipIdx < 0) shipIdx = 3; // fallback

      const rows = document.querySelectorAll('tr');
      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        if (!tds.length) continue;
        const firstCell = tds[0].innerText.trim();
        // '전체' 행 또는 마지막 합계 행
        if (firstCell === '전체' || firstCell === '합계' || firstCell === 'Total') {
          const v = tds[shipIdx] ? tds[shipIdx].innerText.replace(/,/g, '').trim() : '';
          const n = parseInt(v);
          return isNaN(n) ? null : n;
        }
      }
      // 전체 행 없으면 모든 배송 합산
      let total = 0; let found = false;
      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        if (tds.length <= shipIdx) continue;
        const firstCell = tds[0].innerText.trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(firstCell)) { // 날짜 행
          const v = tds[shipIdx].innerText.replace(/,/g, '').trim();
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

module.exports = { crawlBrand };
