const puppeteer = require('puppeteer-core');
const fs = require('fs');

// Chrome 실행 경로
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const BASE_URL = 'https://www.ezadmin.co.kr';

function getChromePath() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 오늘부터 N일 전 날짜 (YYYYMMDD)
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}${m}${day}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// cred: { domain, userId, passwd }
// products: ['조인트본', '루테아틴', ...]
async function crawlBrand(brand, cred, products) {
  if (!cred || !products) throw new Error('계정 또는 제품 정보 없음');

  const chromePath = getChromePath();
  if (!chromePath) throw new Error('Chrome을 찾을 수 없습니다 (Chrome 설치 필요)');

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: ['--window-size=1280,900', '--no-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1. 이지어드민 접속 (새 URL: www.ezadmin.co.kr)
    await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // 로그인 필요 여부 확인
    const isLoginPage = await page.$('input[type="password"]');
    if (isLoginPage) {
      await doLogin(page, cred);
      await sleep(3000);
    }

    // 로그인 후 실제 어드민 URL 확인
    const currentUrl = page.url();
    console.log('현재 URL:', currentUrl);

    const results = [];

    for (const productName of products) {
      try {
        console.log(`  조회 중: ${productName}`);
        const data = await getProductStock(page, productName);
        results.push(data);
        await sleep(800);
      } catch (e) {
        console.error(`  ${productName} 실패:`, e.message);
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
  // 도메인 필드 (여러 selector 시도)
  const domainSelectors = [
    'input[name="domain"]',
    'input[id="domain"]',
    'input[placeholder*="도메인"]',
  ];
  for (const sel of domainSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(cred.domain);
        console.log('도메인 입력 완료 (selector:', sel, ')');
        break;
      }
    } catch (e) {}
  }

  // 아이디
  const idSelectors = [
    'input[name="m_id"]',
    'input[id="m_id"]',
    'input[name="userId"]',
    'input[name="id"]',
    'input[type="text"]:not([name="domain"])',
  ];
  for (const sel of idSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(cred.userId);
        console.log('아이디 입력 완료 (selector:', sel, ')');
        break;
      }
    } catch (e) {}
  }

  // 비밀번호
  const pwEl = await page.$('input[type="password"]');
  if (pwEl) {
    await pwEl.click({ clickCount: 3 });
    await pwEl.type(cred.passwd);
    console.log('비밀번호 입력 완료');
  }

  // 로그인 버튼 클릭 또는 Enter
  const loginBtn = await page.$('button[type="submit"], input[type="submit"], button.login-btn, .login-btn');
  if (loginBtn) {
    await loginBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(2000);
  console.log('로그인 후 URL:', page.url());
}

async function getProductStock(page, productName) {
  // 현 재고조회 페이지 이동 (Hash #I100 = 재고조회 메뉴)
  const adminBase = page.url().includes('ka01') ? 'https://ka01.ezadmin.co.kr' : BASE_URL;
  await page.goto(adminBase + '/index.htm#I100', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(3000);

  // iframe 확인 (어드민은 iframe 구조일 수 있음)
  const frames = page.frames();
  console.log('  frames 수:', frames.length);

  // 메인 프레임 또는 컨텐츠 프레임 찾기
  let targetFrame = page;
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes('I100') || url.includes('stock') || url.includes('popup') || (url !== 'about:blank' && !url.includes('index.htm'))) {
      targetFrame = frame;
      console.log('  타겟 프레임:', url);
      break;
    }
  }

  // 검색 타입을 "상품명"으로 설정
  try {
    await targetFrame.select('select[name="search_type"], select[id="search_type"]', '2');
  } catch (e) {
    try { await targetFrame.select('select', '상품명'); } catch (e2) {}
  }

  // 상품명 입력
  const searchSelectors = [
    'input[name="search_nm"]',
    'input[id="search_nm"]',
    'input[name="keyword"]',
    'input[placeholder*="검색"]',
    'input[placeholder*="상품"]',
  ];
  let searchEl = null;
  for (const sel of searchSelectors) {
    try {
      searchEl = await targetFrame.$(sel);
      if (searchEl) { console.log('  검색필드:', sel); break; }
    } catch (e) {}
  }

  if (!searchEl) {
    console.log('  검색 필드 없음, frame HTML 일부:', await targetFrame.evaluate(() => document.body.innerHTML.slice(0,500)));
    return { name: productName, stockNow: null, out7d: null };
  }

  await searchEl.click({ clickCount: 3 });
  await searchEl.type(productName);
  await targetFrame.keyboard.press('F2');
  await sleep(3000);

  // 정상재고 값 추출
  const stockData = await targetFrame.evaluate(() => {
    // 헤더에서 컬럼 인덱스 찾기
    const headerEls = document.querySelectorAll('th, thead td');
    let stockIdx = -1;
    headerEls.forEach((th, i) => {
      const t = th.innerText.trim();
      if (t.includes('정상재고') || t === '정상') stockIdx = i;
    });

    const rows = document.querySelectorAll('tbody tr');
    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      if (stockIdx >= 0 && tds[stockIdx]) {
        const val = tds[stockIdx].innerText.replace(/,/g, '').trim();
        const n = parseInt(val);
        if (!isNaN(n)) return { stockNow: n };
      }
      // 정상재고 컬럼을 못 찾으면 링크 있는 td 숫자 시도
      for (const td of tds) {
        if (td.querySelector('a') && /^[\d,]+$/.test(td.innerText.trim())) {
          const n = parseInt(td.innerText.replace(/,/g,'').trim());
          if (!isNaN(n) && n >= 0) return { stockNow: n };
        }
      }
    }
    return null;
  });

  if (!stockData) {
    console.log('  정상재고 추출 실패');
    return { name: productName, stockNow: null, out7d: null };
  }

  console.log('  정상재고:', stockData.stockNow);

  // 정상재고 클릭 → 재고이력 팝업
  const out7d = await getOut7d(page, targetFrame, stockData.stockNow);

  return { name: productName, stockNow: stockData.stockNow, out7d };
}

async function getOut7d(page, targetFrame, currentStock) {
  try {
    // 정상재고 숫자 td의 링크 클릭
    const clicked = await targetFrame.evaluate((stock) => {
      const tds = document.querySelectorAll('td');
      for (const td of tds) {
        const v = td.innerText.replace(/,/g,'').trim();
        if (v === String(stock)) {
          const a = td.querySelector('a');
          if (a) { a.click(); return true; }
          td.click();
          return true;
        }
      }
      return false;
    }, currentStock);

    if (!clicked) { console.log('  재고 링크 클릭 실패'); return null; }

    // 팝업 대기
    await sleep(2500);
    const pages = await page.browser().pages();
    const popup = pages.find(p => p !== page && !p.url().includes('about:blank'));
    if (!popup) { console.log('  팝업 없음'); return null; }

    console.log('  팝업 URL:', popup.url());
    await sleep(1000);

    // 기간 설정: 오늘부터 7일 전
    const endDate = daysAgo(0);
    const startDate = daysAgo(7);
    console.log('  기간:', startDate, '~', endDate);

    // 시작일 입력
    const startSelectors = ['input[id*="start"]', 'input[name*="start"]', 'input[name*="fr"]', 'input.date'];
    for (const sel of startSelectors) {
      try {
        const el = await popup.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.type(startDate);
          console.log('  시작일 입력:', sel);
          break;
        }
      } catch (e) {}
    }

    // 종료일 입력
    const endSelectors = ['input[id*="end"]', 'input[name*="end"]', 'input[name*="to"]'];
    for (const sel of endSelectors) {
      try {
        const el = await popup.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.type(endDate);
          console.log('  종료일 입력:', sel);
          break;
        }
      } catch (e) {}
    }

    // 조회 버튼 클릭
    const searchBtn = await popup.$('input[value="조회"], button:contains("조회"), input[value*="검색"], button.search-btn');
    if (searchBtn) { await searchBtn.click(); }
    else { await popup.keyboard.press('Enter'); }
    await sleep(2000);

    // 배송 전체 합계 추출
    const out7d = await popup.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr, tr');
      const headers = document.querySelectorAll('table thead th, th');
      let shipIdx = -1;
      headers.forEach((th, i) => {
        const t = th.innerText.trim();
        if (t === '배송' || t.includes('배송')) shipIdx = i;
      });

      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        const firstCell = tds[0] ? tds[0].innerText.trim() : '';
        if (firstCell === '전체' || firstCell.includes('합계') || firstCell.includes('전체')) {
          if (shipIdx >= 0 && tds[shipIdx]) {
            const v = tds[shipIdx].innerText.replace(/,/g,'').trim();
            const n = parseInt(v);
            if (!isNaN(n)) return n;
          }
          // shipIdx 못 찾으면 숫자 있는 td 중 가장 큰 값
          let maxVal = 0;
          for (const td of tds) {
            const v = td.innerText.replace(/,/g,'').trim();
            const n = parseInt(v);
            if (!isNaN(n) && n > maxVal) maxVal = n;
          }
          return maxVal || null;
        }
      }
      return null;
    });

    console.log('  7일 출고:', out7d);
    await popup.close();
    return out7d;
  } catch (e) {
    console.error('  재고이력 팝업 오류:', e.message);
    return null;
  }
}

module.exports = { crawlBrand };
