import { coursePrograms, getCourseConsultUrl } from '../data/course-programs.js?v=20260814strategyeditor2'

function renderArtifact(program) {
  if (program.slug === 'trading-craft') {
    return `
      <div class="program-artifact program-artifact-ledger" aria-label="交易训练成果示意">
        <div class="artifact-ledger-head"><span>66 天训练日志</span><strong>执行率 86%</strong></div>
        <div class="artifact-ledger-rule"><span>当前训练</span><b>只做顺势回踩</b></div>
        <div class="artifact-ledger-grid">
          <span>判势</span><span>找位</span><span>等态</span><span>风控</span>
          <b>完成</b><b>完成</b><b>等待</b><b>通过</b>
        </div>
        <div class="artifact-ledger-note">今日复盘：计划内交易 2 笔，冲动交易 0 笔</div>
      </div>
    `
  }

  return `
    <div class="program-artifact program-artifact-console" aria-label="个人 AI 交易工具成果示意">
      <div class="artifact-console-bar"><span></span><span></span><span></span><b>我的 AI 交易工具</b></div>
      <div class="artifact-console-body">
        <div class="artifact-console-nav"><b>盘面解读</b><span>信号核对</span><span>风控检查</span><span>复盘助手</span></div>
        <div class="artifact-console-result">
          <span>规则核对结果</span>
          <strong>3 项符合 · 1 项存疑</strong>
          <div><i></i>趋势方向与系统一致</div>
          <div><i></i>入场位置仍需确认</div>
          <small>决策权始终属于使用者</small>
        </div>
      </div>
    </div>
  `
}

function renderProgramRouteButton(program, label, className = 'btn btn-primary') {
  return `<button class="${className}" type="button" data-course-route="${program.view}">${label}</button>`
}

export function renderCourseOverviewPage() {
  const [craft, ai] = coursePrograms
  return `
    <main class="course-hub fade-in">
      <section class="course-hub-hero">
        <button class="back-btn" type="button" data-course-route="home">← 返回首页</button>
        <p class="course-kicker">量见课程体系</p>
        <h1>先把交易练成手艺，再把方法铸成工具</h1>
        <p>两门课程既能前后衔接，也支持已有交易系统的学习者直接进入第二部。选择取决于你现在有没有一套能够说清楚、写下来、反复执行的交易方法。</p>
      </section>

      <section class="course-path" aria-label="课程学习路径">
        <article class="course-path-step course-path-craft">
          <div class="course-path-number">第一部</div>
          <h2>${craft.title}</h2>
          <p>${craft.summary}</p>
          <div class="course-path-outcome"><span>最终成果</span><strong>交易规则 + 66 天训练记录</strong></div>
          ${renderProgramRouteButton(craft, '查看第一部')}
        </article>
        <div class="course-path-connector" aria-hidden="true"><span>形成方法后</span><b>→</b></div>
        <article class="course-path-step course-path-ai">
          <div class="course-path-number">第二部</div>
          <h2>${ai.title}</h2>
          <p>${ai.summary}</p>
          <div class="course-path-outcome"><span>最终成果</span><strong>个人 AI 工具 + 测试报告</strong></div>
          ${renderProgramRouteButton(ai, '查看第二部')}
        </article>
      </section>

      <section class="course-entry-guide">
        <h2>从哪里开始</h2>
        <div class="course-entry-row">
          <div><strong>还没有稳定方法</strong><p>从第一部开始，先建立规则、纪律和复盘习惯。</p></div>
          ${renderProgramRouteButton(craft, '从第一部开始', 'btn btn-outline')}
        </div>
        <div class="course-entry-row">
          <div><strong>已经有自己的系统</strong><p>可以直接进入第二部，先通过系统盘点确认规则完整度。</p></div>
          ${renderProgramRouteButton(ai, '直接了解第二部', 'btn btn-outline')}
        </div>
      </section>

      <section class="course-boundary">
        <strong>课程边界</strong>
        <p>课程只提供交易知识、训练方法与 AI 技术教育，不提供荐股、带单、代客理财或收益承诺。所有训练优先使用模拟环境。</p>
      </section>
    </main>
  `
}

function renderList(items, className) {
  return `<ul class="${className}">${items.map(item => `<li>${item}</li>`).join('')}</ul>`
}

export function renderCourseProgramPage(program) {
  const consultUrl = getCourseConsultUrl(program).replaceAll('&', '&amp;')
  const other = coursePrograms.find(item => item.slug !== program.slug)
  return `
    <main class="program-page program-${program.slug} fade-in">
      <section class="program-hero">
        <div class="program-hero-inner">
          <button class="back-btn" type="button" data-course-route="courses">← 返回课程体系</button>
          <div class="program-hero-copy">
            <p class="course-kicker">${program.series}</p>
            <h1>${program.title}</h1>
            <h2>${program.subtitle}</h2>
            <p class="program-summary">${program.summary}</p>
            <p class="program-statement">${program.statement}</p>
            <div class="program-hero-actions">
              <button class="btn btn-primary" type="button" data-course-trial="true">免费试听第一课</button>
              <a class="btn btn-outline" href="${consultUrl}" target="_blank" rel="noopener noreferrer">咨询课程顾问</a>
            </div>
            <div class="program-facts">${program.facts.map(item => `<span>${item}</span>`).join('')}</div>
          </div>
          ${renderArtifact(program)}
        </div>
      </section>

      <nav class="program-anchor-nav" aria-label="本页导航">
        <a href="#program-results">学习成果</a>
        <a href="#program-outline">课程大纲</a>
        <a href="#program-fit">适合人群</a>
        <a href="#program-faq">常见问题</a>
        <a href="${consultUrl}" target="_blank" rel="noopener noreferrer">咨询顾问</a>
      </nav>

      <section class="program-section program-results" id="program-results">
        <div class="program-section-heading">
          <h2>${program.artifactTitle}</h2>
          <p>课程以可检查的作业与成果为交付，不以行情结果作为考核标准。</p>
        </div>
        <div class="program-output-strip">${program.artifactItems.map((item, index) => `<div><span>${String(index + 1).padStart(2, '0')}</span><strong>${item}</strong></div>`).join('')}</div>
        <div class="program-highlight-grid">${program.highlights.map(item => `<article><h3>${item.title}</h3><p>${item.text}</p></article>`).join('')}</div>
      </section>

      ${program.practice.length ? `
        <section class="program-section program-practice">
          <div class="program-section-heading"><h2>把“知道”练成“做到”</h2><p>练习不是多看盘，而是有目标、有反馈地改变具体动作。</p></div>
          <div class="program-practice-list">${program.practice.map((item, index) => `<div><span>${index + 1}</span><h3>${item.title}</h3><p>${item.text}</p></div>`).join('')}</div>
        </section>
      ` : ''}

      <section class="program-section program-outline" id="program-outline">
        <div class="program-section-heading"><h2>课程大纲</h2><p>${program.slug === 'trading-craft' ? '四个阶段，理论与训练交叉推进。' : '完成模块〇至四即可完成主线，模块五为进阶选修。'}</p></div>
        <div class="program-modules">${program.outline.map(item => `
          <article>
            <div class="program-module-label">${item.label}</div>
            <div><h3>${item.title}</h3><p>${item.text}</p><strong>产出：${item.output}</strong></div>
          </article>
        `).join('')}</div>
      </section>

      <section class="program-section program-fit" id="program-fit">
        <div class="program-section-heading"><h2>适合谁，也明确不适合谁</h2><p>把边界提前说清楚，是对学习者负责。</p></div>
        <div class="program-fit-columns">
          <div><h3>适合你，如果</h3>${renderList(program.fit, 'program-check-list')}</div>
          <div><h3>请谨慎报名，如果</h3>${renderList(program.unfit, 'program-stop-list')}</div>
        </div>
      </section>

      <section class="program-section program-enrollment">
        <div class="program-price-block">
          <span>课程定价</span><strong>${program.price}</strong><p>${program.priceNote}</p>
        </div>
        <div class="program-includes"><h2>报名包含</h2>${renderList(program.includes, 'program-check-list')}</div>
        <div class="program-enrollment-actions">
          <button class="btn btn-primary" type="button" data-course-trial="true">免费试听第一课</button>
          <a class="btn btn-outline" href="${consultUrl}" target="_blank" rel="noopener noreferrer">咨询课程顾问</a>
        </div>
      </section>

      <section class="program-section program-faq" id="program-faq">
        <div class="program-section-heading"><h2>常见问题</h2></div>
        <div class="program-faq-list">${program.faqs.map(item => `<details><summary>${item.q}</summary><p>${item.a}</p></details>`).join('')}</div>
      </section>

      <section class="program-next-course">
        <div><span>${other.series}</span><h2>${other.title}</h2><p>${other.subtitle}</p></div>
        ${renderProgramRouteButton(other, `查看${other.title}`, 'btn btn-outline')}
      </section>

      <section class="course-boundary program-disclaimer">
        <strong>风险提示与免责声明</strong>
        <p>本课程为交易知识与 AI 技术的教育性内容，仅供学习参考，不构成投资建议。本平台不提供荐股、带单、代客理财服务。金融交易具有高风险，可能导致本金全部损失；是否交易及其后果由学员自行判断与承担。任何示例、测试与练习结果均不代表未来收益。</p>
      </section>
    </main>
  `
}
