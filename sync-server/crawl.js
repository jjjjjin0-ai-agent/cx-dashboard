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

async function crawlBrand(brand, cred, products) {
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
        const data = await getProductStock(page, browser, adminBase, productName);
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

async function getProductStock(page, browser, adminBase, productName) {
  // 현 재고조회(I100) 이동
  await page.goto(`${adminBase}/index.htm#I100`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(3000);

  // 컨텐츠 iframe 찾기
  const contentFrame = await findContentFrame(page, adminBase);
  console.log('사용 프레임 URL:', contentFrame.url());

  // 검색 입력필드 찾기
  const searchInput = await findSearchInput(contentFrame);
  if (!searchInput) {
    const bodyHtml = await contentFrame.evaluate(() => document.body.innerHTML.slice(0, 500));
    console.log('프레임 내용 일부:', bodyHtml);
    throw new Error('검색 필드를 찾을 수 없음');
  }

  // 상품명 입력 후 검색 (매핑된 검색어 사용)
  const searchTerm = SEARCH_NAMES[productName] || productName;
  await searchInput.click({ clickCount: 3 });
  await searchInput.type(searchTerm, { delay: 50 });
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

  if (!stockData) throw new Error('정상재고 데이터를 찾을 수 없음');
  console.log('정상재고:', stockData.stockNow, '상품코드:', stockData.productId);

  // 재고이력 팝업 직접 접속 (클릭 없이 URL로)
  const out7d = await getOut7dByUrl(browser, adminBase, stockData.productId, stockData.stockNow);

  return { name: productName, stockNow: stockData.stockNow, out7d };
}

async function findContentFrame(page, adminBase) {
  const domain = new URL(adminBase).hostname;
  const frames = page.frames();
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes(domain) && !url.includes('index.htm') && url !== 'about:blank') {
      return frame;
    }
  }
  // 못 찾으면 index.htm 이 아닌 첫 번째 non-blank 프레임
  for (const frame of frames) {
    const url = frame.url();
    if (url !== 'about:blank' && !url.includes('index.htm')) return frame;
  }
  return page; // fallback
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

async function getOut7dByUrl(browser, adminBase, productId, stockNow) {
  if (!productId) { console.log('상품코드 없음, 팝업 스킵'); return null; }

  const today = new Date();
  const endDate = fmtDate(today);
  const startD = new Date(today);
  startD.setDate(startD.getDate() - 7);
  const startDate = fmtDate(startD);

  const popupUrl = `${adminBase}/popup35.htm?template=I101&readonly=T&product_id=${productId}&inout_type=0&stock=${stockNow}`;
  console.log('팝업 URL:', popupUrl);

  const popup = await browser.newPage();
  try {
    await popup.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);

    // 기간 입력 (text 타입 input 2개)
    const inputs = await popup.$$('input[type="text"]:not([readonly])');
    console.log('팝업 input 수:', inputs.length);
    if (inputs.length >= 1) {
      await inputs[0].click({ clickCount: 3 });
      await inputs[0].type(startDate, { delay: 50 });
    }
    if (inputs.length >= 2) {
      await inputs[1].click({ clickCount: 3 });
      await inputs[1].type(endDate, { delay: 50 });
    }

    // 새로고침 버튼 클릭
    const refreshBtn = await popup.$('input[value="새로고침"], button:has-text("새로고침")');
    if (refreshBtn) {
      await refreshBtn.click();
    } else {
      await popup.keyboard.press('Enter');
    }
    await sleep(2000);

    // 배송 전체 합계 추출 (전체 행, 배송=index 3)
    const out7d = await popup.evaluate(() => {
      const rows = document.querySelectorAll('tr');
      // 헤더에서 배송 컬럼 인덱스 찾기
      let shipIdx = 3; // 기본값: 날짜=0, 입고=1, 출고=2, 배송=3
      const ths = document.querySelectorAll('th');
      ths.forEach((th, i) => {
        if (th.innerText.trim() === '배송') shipIdx = i;
      });
      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        if (tds.length > shipIdx && tds[0] && tds[0].innerText.trim() === '전체') {
          const v = tds[shipIdx].innerText.replace(/,/g, '').trim();
          const n = parseInt(v);
          console.log('전체 배송:', v, '→', n);
          return isNaN(n) ? null : n;
        }
      }
      return null;
    });

    console.log('7일 출고(배송):', out7d);
    return out7d;
  } finally {
    await popup.close();
  }
}

module.exports = { crawlBrand };
