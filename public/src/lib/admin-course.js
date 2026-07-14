export function getCourseMediaValidationError({
  contentType,
  isExistingCourse,
  hasVideoFile,
  bilibiliId,
}) {
  if (contentType !== 'video' || isExistingCourse || hasVideoFile || bilibiliId) return ''
  return '请上传新视频或填写B站BV号'
}
