const puppeteer = require('puppeteer-core');
const fs = require('fs');

// Chrome 실행 경로
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

// 오늘부터 N일 전 날짜 (YYYY-MM-DD)
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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

    // 1. 이지어드민 접속
    await page.goto('https://ka01.ezadmin.co.kr/', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1000);

    // 로그인 필요 여부 확인
    const isLoginPage = await page.$('input[type="password"]');
    if (isLoginPage) {
      await doLogin(page, cred);
      await sleep(2000);
    }

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
  // 도메인 필드
  try {
    const domainSel = 'input[name="domain"], input[id="domain"]';
    const domainEl = await page.$(domainSel);
    if (domainEl) {
      await domainEl.triple_click();
      await domainEl.type(cred.domain);
    }
  } catch (e) {}

  // 아이디
  const idEl = await page.$('input[name="m_id"], input[id="m_id"], input[type="text"]');
  if (idEl) { await idEl.click({ clickCount: 3 }); await idEl.type(cred.userId); }

  // 비밀번호
  const pwEl = await page.$('input[type="password"]');
  if (pwEl) { await pwEl.click({ clickCount: 3 }); await pwEl.type(cred.passwd); }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    page.keyboard.press('Enter')
  ]);
}

async function getProductStock(page, productName) {
  // 현 재고조회 페이지 이동
  await page.goto('https://ka01.ezadmin.co.kr/index.htm#I100', { waitUntil: 'networkidle2', timeout: 20000 });
  await sleep(2000);

  // 검색 타입을 "상품명"으로 설정 (드롭다운)
  try {
    await page.select('select[name="search_type"], select[id="search_type"]', '상품명');
  } catch (e) {}

  // 상품명 입력
  const searchSel = 'input[name="search_nm"], input[id="search_nm"], input[placeholder*="검색"]';
  await page.waitForSelector(searchSel, { timeout: 8000 });
  const searchEl = await page.$(searchSel);
  await searchEl.click({ clickCount: 3 });
  await searchEl.type(productName);

  // 검색 실행 (F2)
  await page.keyboard.press('F2');
  await sleep(2500);

  // 정상재고 값 추출 (첫 번째 결과 행)
  const stockData = await page.evaluate(() => {
    const rows = document.querySelectorAll('#grid1 tbody tr, table.list tbody tr, .grid-wrap tbody tr');
    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      // 정상재고 컬럼 찾기 (헤더와 매핑)
      const headers = document.querySelectorAll('#grid1 thead th, table.list thead th');
      let stockIdx = -1;
      let productIdx = -1;
      headers.forEach((th, i) => {
        const t = th.innerText.trim();
        if (t === '정상재고') stockIdx = i;
        if (t === '상품명') productIdx = i;
      });
      if (stockIdx >= 0 && tds[stockIdx]) {
        const val = tds[stockIdx].innerText.replace(/,/g, '').trim();
        const n = parseInt(val);
        if (!isNaN(n)) return { stockNow: n, productId: null };
      }
    }
    return null;
  });

  if (!stockData) return { name: productName, stockNow: null, out7d: null };

  // 정상재고 숫자 클릭 → 재고이력 팝업
  const out7d = await getOut7d(page, stockData.stockNow);

  return { name: productName, stockNow: stockData.stockNow, out7d };
}

async function getOut7d(page, currentStock) {
  // 정상재고 링크/버튼 클릭
  try {
    const stockLink = await page.$(`a[href*="I101"], td.stock-now a, td.正常재고 a`);
    if (!stockLink) {
      // 숫자로 된 정상재고 td를 찾아 클릭
      const clicked = await page.evaluate((stock) => {
        const tds = document.querySelectorAll('td');
        for (const td of tds) {
          const v = td.innerText.replace(/,/g,'').trim();
          if (v === String(stock) && td.querySelector('a, span')) {
            (td.querySelector('a') || td).click();
            return true;
          }
        }
        return false;
      }, currentStock);
      if (!clicked) return null;
    } else {
      await stockLink.click();
    }

    // 팝업 대기
    await sleep(2000);
    const pages = await page.browser().pages();
    const popup = pages[pages.length - 1];
    if (!popup || popup === page) return null;

    // 기간 설정: 7일 전 ~ 오늘
    const startDate = daysAgo(7);
    const endDate = daysAgo(0);

    const startEl = await popup.$('input[id*="start"], input[name*="start"], input.date:first-of-type');
    if (startEl) {
      await startEl.triple_click();
      await startEl.type(startDate);
    }
    // 새로고침 버튼
    const refreshBtn = await popup.$('button:contains("새로고침"), input[value="새로고침"], button.search');
    if (refreshBtn) await refreshBtn.click();
    else await popup.keyboard.press('Enter');
    await sleep(1500);

    // 배송 전체 합계 추출
    const out7d = await popup.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const headers = document.querySelectorAll('table thead th');
      let shipIdx = -1;
      headers.forEach((th, i) => {
        if (th.innerText.trim() === '배송') shipIdx = i;
      });
      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        if (tds[0] && tds[0].innerText.trim() === '전체' && shipIdx >= 0) {
          const v = tds[shipIdx].innerText.replace(/,/g,'').trim();
          const n = parseInt(v);
          return isNaN(n) ? null : n;
        }
      }
      return null;
    });

    await popup.close();
    return out7d;
  } catch (e) {
    console.error('재고이력 팝업 오류:', e.message);
    return null;
  }
}

module.exports = { crawlBrand };
