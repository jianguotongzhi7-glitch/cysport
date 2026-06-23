/**
 * ============================================================
 * fetch-jobs.js — 招聘数据抓取脚本（Puppeteer 版）
 * ============================================================
 *
 * 使用 Puppeteer + stealth 插件模拟真实浏览器访问 Boss 直聘，
 * 以绕过反爬检测。每周运行一次，频率低不会被封。
 *
 * 本地运行：
 *   cd scripts && npm install && node fetch-jobs.js
 *
 * GitHub Actions 自动运行：
 *   见 ../.github/workflows/update-jobs.yml（每周一自动运行）
 *
 * 如果抓取成功 → 更新 ../jobs.json
 * 如果抓取失败 → 保留原有 ../jobs.json 不变
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const JOBS_PATH = path.join(__dirname, '..', 'jobs.json');
// Boss直聘企业主页（移动端，更易抓取）
const TARGET_URL = process.env.SCRAPE_URL ||
  'https://www.zhipin.com/gongsi/cf58c7f2488967261X1z3tq7F1A~.html';

// ============================================================
// 模拟真实用户行为
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// 随机 User-Agent
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

// ============================================================
// 启动浏览器并抓取
// ============================================================
async function fetchWithPuppeteer() {
  console.log('🚀 启动 Puppeteer（真实浏览器）...\n');

  // 动态导入，避免本地未安装时报错
  let puppeteer;
  try {
    puppeteer = require('puppeteer-extra');
  } catch {
    console.error('❌ 请先安装依赖: npm install puppeteer-extra puppeteer-extra-plugin-stealth');
    return null;
  }

  // 加载 stealth 插件（隐藏自动化痕迹）
  try {
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  } catch {
    console.warn('⚠️  stealth 插件加载失败，继续尝试...');
  }

  const chromePath = process.env.CHROME_PATH;
  const launchOpts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      '--lang=zh-CN',
    ],
  };
  if (chromePath) {
    launchOpts.executablePath = chromePath;
    console.log(`📌 使用系统 Chrome: ${chromePath}`);
  }
  const browser = await puppeteer.launch(launchOpts);


  const page = await browser.newPage();

  // 设置随机 User-Agent
  const ua = UA_LIST[rand(0, UA_LIST.length - 1)];
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    console.log(`🌐 正在访问: ${TARGET_URL}`);

    // 使用 networkidle2 等待页面完全加载（Boss直聘是动态页面）
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    let currentUrl = page.url();
    console.log(`   📍 当前 URL: ${currentUrl}`);

    // 如果遇到安全验证页面，等待验证通过后的自动跳转
    if (currentUrl.includes('security.html') || currentUrl.includes('passport') || currentUrl === 'about:blank') {
      if (currentUrl !== 'about:blank') {
        console.log('   🔄 检测到安全验证，等待自动跳转...');
      } else {
        console.log('   🔄 页面为空白，等待重试...');
      }
      // 等待导航/重定向 - 最多等 35 秒
      for (let i = 0; i < 7; i++) {
        await sleep(5000);
        currentUrl = page.url();
        console.log(`   ⏳ 第 ${i + 1} 次检查: ${currentUrl}`);
        if (currentUrl && !currentUrl.includes('security.html') && !currentUrl.includes('passport') && currentUrl !== 'about:blank') {
          console.log(`   ✅ 成功到达目标页面: ${currentUrl}`);
          break;
        }
      }
    }

    await sleep(rand(2000, 4000));
    try {
      const scrollAmount = rand(300, 800);
      await page.evaluate((scrollY) => {
        window.scrollBy(0, scrollY);
      }, scrollAmount);
    } catch (scrollErr) {
      console.log(`   ⚠️  滚动页面出错（不影响）: ${scrollErr.message}`);
    }
    await sleep(rand(1500, 3000));

    // 等待职位列表加载
    await page.waitForSelector('body', { timeout: 10000 });
    await sleep(2000);

    // ============================================================
    // 方案1：从页面内嵌的 __NEXT_DATA__ 或 __INITIAL_STATE__ 提取
    // ============================================================
    let jobsData = null;
    try {
      jobsData = await page.evaluate(() => {
        const results = [];

        // 尝试从 window.__NEXT_DATA__ 提取（Next.js 页面）
        const scripts = document.querySelectorAll('script[type="application/json"], script[id]');
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent);
          // 递归查找 jobList
          function findJobs(obj, depth) {
            if (!obj || typeof obj !== 'object' || depth > 20) return;
            if (Array.isArray(obj) && obj.length > 0 && obj[0] && obj[0].jobName) {
              results.push(...obj);
              return;
            }
            if (obj.jobList || obj.jobs || obj.encryptJobList) {
              const list = obj.jobList || obj.jobs || obj.encryptJobList;
              if (Array.isArray(list)) results.push(...list);
              return;
            }
            for (const v of Object.values(obj)) findJobs(v, depth + 1);
          }
          findJobs(data, 0);
          if (results.length) break;
        } catch {}
      }

      // 如果 JSON 提取失败，从 HTML DOM 提取
      if (!results.length) {
        const cards = document.querySelectorAll(
          '.job-card, .job-item, .job-primary, ' +
          '[class*="job-card"], [class*="JobCard"], ' +
          'li[class*="job"], div[class*="job-item"]'
        );
        cards.forEach(card => {
          const title = card.querySelector(
            '.job-name, .job-title, [class*="title"], [class*="name"], h3, h4'
          )?.textContent?.trim();
          const salary = card.querySelector(
            '.salary, .red, [class*="salary"], [class*="pay"]'
          )?.textContent?.trim();
          const loc = card.querySelector(
            '.location, [class*="location"], [class*="area"]'
          )?.textContent?.trim();

          if (title && title.length > 1) {
            results.push({
              jobName: title,
              salaryDesc: salary || '薪资面议',
              locationName: loc || '温州',
            });
          }
        });
      }

      return results;
    });
  } catch (evaluateErr) {
    console.log(`   ⚠️  页面提取过程出错: ${evaluateErr.message}`);
  }
  const jobs = jobsData || [];

    console.log(`📋 从页面中提取到 ${jobs.length} 个岗位\n`);

    if (!jobs.length) {
      const title = await page.title();
      console.log(`   页面标题: "${title}"`);
      console.log('   可能触发了验证码或被重定向。');
    }
    }

    // ============================================================
    // 转换为标准格式
    // ============================================================
    const formatted = jobs.map((j, i) => ({
      id: 'job_' + (i + 1),
      title: j.jobName || j.title || '未知岗位',
      salary: j.salaryDesc || j.salary || '薪资面议',
      location: j.locationName || j.location || '温州',
      type: '全职',
      exp: j.experienceName || j.exp || '详见招聘页',
      edu: j.degreeName || j.edu || '详见招聘页',
      urgent: j.urgent || false,
      mgmt: j.title?.includes('经理') || j.title?.includes('主管') || j.title?.includes('店长') || false,
      desc: (j.jobDesc || j.desc || '岗位详情请访问 Boss 直聘企业主页查看')
        .replace(/<[^>]+>/g, '')
        .slice(0, 300),
      req: Array.isArray(j.jobRequire)
        ? j.jobRequire.slice(0, 6)
        : (j.jobRequire || j.reqText || '详见招聘页').split(/\n|\\n/).filter(Boolean).slice(0, 6),
    }));

    return formatted;

  } catch (err) {
    console.error('❌ 抓取过程出错:', err.message);
    return null;
  } finally {
    await browser.close();
    console.log('🔒 浏览器已关闭');
  }
}

// ============================================================
// 校验 jobs.json 格式
// ============================================================
function validateJobs(data) {
  if (!Array.isArray(data)) throw new Error('jobs.json 应该是数组');
  data.forEach((job, i) => {
    const required = ['id', 'title', 'salary', 'location', 'type', 'exp', 'edu', 'desc', 'req'];
    required.forEach(f => {
      if (!job[f]) throw new Error(`岗位 #${i} 缺少字段: ${f}`);
    });
  });
  console.log(`✅ 格式校验通过，共 ${data.length} 个岗位`);
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  穿越电竞 — 招聘数据更新');
  console.log('  ' + new Date().toISOString().split('T')[0]);
  console.log('═══════════════════════════════════════\n');

  // 读取现有数据（作为兜底）
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
    console.log(`📄 现有 jobs.json: ${existing.length} 个岗位`);
  } catch {
    console.log('📄 现有 jobs.json 不存在或格式错误');
  }

  // 尝试抓取
  console.log('\n--- 开始远程抓取 ---\n');
  const newJobs = await fetchWithPuppeteer();

  if (newJobs && newJobs.length > 0) {
    console.log(`\n✅ 抓取成功！获得 ${newJobs.length} 个岗位`);

    // 合并策略：新数据优先，保留旧数据中未被抓到的岗位
    const newIds = new Set(newJobs.map(j => j.title));
    const merged = [
      ...newJobs,
      ...existing.filter(j => !newIds.has(j.title)),
    ];

    fs.writeFileSync(JOBS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    validateJobs(merged);
    console.log(`💾 已写入 jobs.json（合并后共 ${merged.length} 个岗位）`);
  } else {
    console.log('\n⚠️  远程抓取未获得数据，保留原有 jobs.json');
    if (existing.length > 0) {
      validateJobs(existing);
    } else {
      console.log('⚠️  jobs.json 为空，请手动填写岗位数据');
    }
  }

  console.log('\n✨ 任务结束\n');
}

main().catch(err => {
  console.error('❌ 致命错误:', err);
  process.exit(1);
});
