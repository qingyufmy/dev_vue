export function getCoursesForCategory(courses, category) {
  return (Array.isArray(courses) ? courses : [])
    .filter(course => course?.category === category)
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '') || 0
      const bTime = Date.parse(b.createdAt || '') || 0
      return bTime - aTime || Number(b.id || 0) - Number(a.id || 0)
    })
}
