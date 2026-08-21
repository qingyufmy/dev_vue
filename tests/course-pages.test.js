import { describe, expect, it } from 'vitest'
import {
  coursePrograms,
  getCourseConsultUrl,
  getCourseProgramByView,
} from '../public/src/data/course-programs.js'
import {
  renderCourseOverviewPage,
  renderCourseProgramPage,
} from '../public/src/lib/course-pages.js'

describe('course program pages', () => {
  it('maps both public course views to their program data', () => {
    expect(getCourseProgramByView('courseCraft')?.slug).toBe('trading-craft')
    expect(getCourseProgramByView('courseAi')?.slug).toBe('ai-forging')
  })

  it.each(coursePrograms)('builds a course-specific customer service URL for $slug', (program) => {
    const url = new URL(getCourseConsultUrl(program))
    expect(url.origin).toBe('https://kefu.daoctech.com')
    expect(url.pathname).toBe('/kfG6.htm')
    expect(url.searchParams.get('t')).toBe('00')
    expect(url.searchParams.get('appuserid')).toBe(program.customerServiceId)
  })

  it('renders a course hub with both course routes', () => {
    const html = renderCourseOverviewPage()
    expect(html).toContain('data-course-route="courseCraft"')
    expect(html).toContain('data-course-route="courseAi"')
  })

  it.each(coursePrograms)('renders $slug as an integrated page without an iframe', (program) => {
    const html = renderCourseProgramPage(program)
    expect(html).toContain(program.title)
    expect(html).toContain('data-course-trial="true"')
    expect(html).toContain('kefu.daoctech.com')
    expect(html).not.toContain('<iframe')
  })

  it.each(coursePrograms)('renders only the $slug payment QR code with accessible metadata', (program) => {
    const html = renderCourseProgramPage(program)
    const otherProgram = coursePrograms.find(item => item.slug !== program.slug)

    expect(html).toContain(`<img src="${program.qrCode.src}" alt="${program.qrCode.alt}" width="176" height="176" loading="lazy" decoding="async">`)
    expect(html.match(new RegExp(program.qrCode.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1)
    expect(html).not.toContain(otherProgram.qrCode.src)
    expect(program.qrCode.alt).toContain('课程收款二维码')
    expect(html).toContain('扫码支付课程费用')
    expect(html).not.toContain('扫码咨询报名')
  })
})
