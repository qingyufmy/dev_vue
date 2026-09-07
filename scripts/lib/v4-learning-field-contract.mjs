const course = {
  id: ['learning_courses.id', 'preserve_id'],
  episode_id: ['learning_lessons.public_episode_id', 'preserve_public_identity'],
  number: ['learning_lessons.display_number', 'preserve_nullable_integer'],
  title: ['learning_courses.title', 'preserve_text'],
  description: ['learning_courses.description', 'preserve_nullable_text'],
  category: ['learning_courses.category_key', 'preserve_nullable_text'],
  content_type: ['learning_lessons.content_type', 'review_enum'],
  duration: ['learning_lessons.duration_ms', 'exact_seconds_to_milliseconds'],
  cover: ['learning_courses.cover_locator', 'preserve_locator_requires_verification'],
  gradient: ['learning_courses.gradient_token', 'preserve_presentation_requires_validation'],
  access_level: ['learning_courses.access_level', 'review_access_no_default'],
  status: ['learning_courses.status', 'review_enum_no_default'],
  sort_order: ['learning_courses.sort_order', 'preserve_nullable_integer'],
  created_at: ['learning_courses.created_at_utc', 'review_wall_clock_basis'],
  updated_at: ['learning_courses.updated_at_utc', 'review_wall_clock_basis'],
}
for (const field of ['youtube_id', 'bilibili_id', 'cf_stream_id', 'local_video_path', 'article_url', 'article_object_key']) {
  course[field] = ['learning_media_references.locator', 'preserve_kind_bound_locator']
}
for (const field of ['has_stream_video', 'quiz_count', 'knowledge_count', 'mindmap_count', 'structure_count']) {
  course[field] = ['data_migration_source_rows', 'archive_legacy_projection_rebuild_after_resource_migration']
}
const progress = {
  id: ['learning_progress.id', 'preserve_id'],
  user_id: ['learning_progress.user_id', 'verify_existing_user'],
  episode_id: ['learning_progress.lesson_id', 'resolve_public_episode_exactly'],
  watched_seconds: ['learning_progress.watched_ms', 'exact_seconds_to_milliseconds_no_clamp'],
  total_duration: ['learning_progress.reported_duration_ms', 'exact_seconds_to_milliseconds'],
  completed: ['learning_progress.completed', 'preserve_nullable_flag'],
  quiz_passed: ['learning_progress.quiz_passed', 'preserve_nullable_flag'],
  updated_at: ['learning_progress.updated_at_utc', 'review_wall_clock_basis'],
}
export function learningCoreFieldContract() {
  return Object.entries({ courses: course, progress }).flatMap(([sourceTable, fields]) => Object.entries(fields)
    .map(([sourceField, [target, conversion]]) => ({ sourceTable, sourceField, target, conversion })))
}
