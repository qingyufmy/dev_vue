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
})
