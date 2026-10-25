const puppeteer = require('puppeteer-core');
const fs = require('fs');

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

    await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    const isLoginPage = await page.$('input[type="password"]');
    if (isLoginPage) {
      await doLogin(page, cred);
      await sleep(3000);
    }

    console.log('현재 URL:', page.url());

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
  const domainSelectors = ['input[name="domain"]', 'input[id="domain"]', 'input[placeholder*="도메인"]'];
  for (const sel of domainSelectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click({ clickCount: 3 }); await el.type(cred.domain); console.log('도메인 입력:', sel); break; }
    } catch (e) {}
  }

  const idSelectors = ['input[name="m_id"]', 'input[id="m_id"]', 'input[name="userId"]', 'input[name="id"]'];
  for (const sel of idSelectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click({ clickCount: 3 }); await el.type(cred.userId); console.log('아이디 입력:', sel); break; }
    } catch (e) {}
  }

  const pwEl = await page.$('input[type="password"]');
  if (pwEl) { await pwEl.click({ clickCount: 3 }); await pwEl.type(cred.passwd); console.log('비밀번호 입력 완료'); }

  const loginBtn = await page.$('button[type="submit"], input[type="submit"], button.login-btn');
  if (loginBtn) { await loginBtn.click(); }
  else { await page.keyboard.press('Enter'); }

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(2000);
  console.log('로그인 후 URL:', page.url());
}

async function getProductStock(page, productName) {
  const adminBase = page.url().includes('ka01') ? 'https://ka01.ezadmin.co.kr' : BASE_URL;
  await page.goto(adminBase + '/index.htm#I100', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(3000);

  const frames = page.frames();
  console.log('  frames 수:', frames.length);

  let targetFrame = page;
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes('I100') || (url !== 'about:blank' && !url.includes('index.htm'))) {
      targetFrame = frame;
      console.log('  타겟 프레임:', url);
      break;
    }
  }

  try {
    await targetFrame.select('select[name="search_type"], select[id="search_type"]', '2');
  } catch (e) {}

  const searchSelectors = ['input[name="search_nm"]', 'input[id="search_nm"]', 'input[name="keyword"]', 'input[placeholder*="검색"]'];
  let searchEl = null;
  for (const sel of searchSelectors) {
    try {
      searchEl = await targetFrame.$(sel);
      if (searchEl) { console.log('  검색필드:', sel); break; }
    } catch (e) {}
  }

  if (!searchEl) {
    console.log('  검색 필드 없음');
    return { name: productName, stockNow: null, out7d: null };
  }

  await searchEl.click({ clickCount: 3 });
  await searchEl.type(productName);
  await targetFrame.keyboard.press('F2');
  await sleep(3000);

  const stockData = await targetFrame.evaluate(() => {
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
      for (const td of tds) {
        if (td.querySelector('a') && /^[\d,]+$/.test(td.innerText.trim())) {
          const n = parseInt(td.innerText.replace(/,/g,'').trim());
          if (!isNaN(n) && n >= 0) return { stockNow: n };
        }
      }
    }
    return null;
  });

  if (!stockData) { console.log('  정상재고 추출 실패'); return { name: productName, stockNow: null, out7d: null }; }
  console.log('  정상재고:', stockData.stockNow);

  const out7d = await getOut7d(page, targetFrame, stockData.stockNow);
  return { name: productName, stockNow: stockData.stockNow, out7d };
}

async function getOut7d(page, targetFrame, currentStock) {
  try {
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

    await sleep(2500);
    const pages = await page.browser().pages();
    const popup = pages.find(p => p !== page && !p.url().includes('about:blank'));
    if (!popup) { console.log('  팝업 없음'); return null; }

    console.log('  팝업 URL:', popup.url());
    await sleep(1000);

    const startDate = daysAgo(7);
    const endDate = daysAgo(0);

    const startSelectors = ['input[id*="start"]', 'input[name*="start"]', 'input[name*="fr"]', 'input.date'];
    for (const sel of startSelectors) {
      try {
        const el = await popup.$(sel);
        if (el) { await el.click({ clickCount: 3 }); await el.type(startDate); break; }
      } catch (e) {}
    }

    const endSelectors = ['input[id*="end"]', 'input[name*="end"]', 'input[name*="to"]'];
    for (const sel of endSelectors) {
      try {
        const el = await popup.$(sel);
        if (el) { await el.click({ clickCount: 3 }); await el.type(endDate); break; }
      } catch (e) {}
    }

    const searchBtn = await popup.$('input[value="조회"], input[value*="검색"]');
    if (searchBtn) { await searchBtn.click(); }
    else { await popup.keyboard.press('Enter'); }
    await sleep(2000);

    const out7d = await popup.evaluate(() => {
      const headers = document.querySelectorAll('th');
      let shipIdx = -1;
      headers.forEach((th, i) => { if (th.innerText.trim().includes('배송')) shipIdx = i; });
      const rows = document.querySelectorAll('tbody tr, tr');
      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        const firstCell = tds[0] ? tds[0].innerText.trim() : '';
        if (firstCell === '전체' || firstCell.includes('합계')) {
          if (shipIdx >= 0 && tds[shipIdx]) {
            const n = parseInt(tds[shipIdx].innerText.replace(/,/g,'').trim());
            if (!isNaN(n)) return n;
          }
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
