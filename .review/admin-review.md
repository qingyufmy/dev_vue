# Admin.js Code Quality Review — Full Report
File: server/routes/admin.js (763 lines, 16 route handlers)

---

## CRITICAL (5 findings)

### C1. Path Traversal in Upload Filenames — Lines 556-558
The regex `relPath.replace(/^[^/]+\//, '')` only removes the first directory segment. A filename like `../../payload.json` becomes `../payload.json` after stripping. This value feeds into `writeFileSync(join(epDir, baseName), ...)` at lines 612/624/639/675, writing outside the intended epDir. The path is also stored in the database at line 618.
Fix: Use `path.basename()` to strip all directory components. Reject names containing `..` or null bytes.

### C2. Double-Approval Credit Inflation — Lines 399-410
The PATCH handler reads referral data, then writes status and conditionally adds user credit. The SELECT on line 403 does not fetch the current `status`, so an already-approved referral can be "approved" again, doubling the credited amount. No row lock prevents concurrent requests from both passing the guard.
Fix: Wrap in withTransaction, SELECT FOR UPDATE, check current status before crediting.

### C3. Unvalidated finalStatus Corrupts Data — Line 402
When neither `action` nor `status` is provided in the request body, the ternary chain produces `undefined`. MySQL receives this as NULL, setting the referral status column to NULL. Even when `req.body.status` is supplied, no whitelist validates it against allowed values like 'pending'/'approved'/'voided'.
Fix: Validate finalStatus against an enum before executing the UPDATE.

### C4. Missing userId Check in POST /admin-users — Lines 213-229
The handler destructures `userId` from body but never checks it exists. All subsequent UPDATE statements use `WHERE id = NULL`, match zero rows silently, and return `{ ok: true }`. The admin receives a false success confirmation. The sibling PUT handler (line 232) correctly validates this field.
Fix: Add `if (!userId) return res.json({ ok: false, error: '...' })` at the top of the try block.

### C5. Zero Audit Logging for Admin Operations
Despite `admin-audit` existing as a read endpoint (line 311), the entire file never calls `logAudit()`. Every user mutation, role change, course edit, referral approval, and account deletion leaves no audit trail. The `auth.js` module demonstrates the pattern by logging registration and login events.
Fix: Insert `logAudit({ userId: req.user.id, action: '...', ... })` after each destructive operation.

---

## HIGH (6 findings)

### H1. Course ID Race Condition — Lines 479-485
Two concurrent requests both execute `SELECT MAX(episode_id)`, receive the same value, and attempt to INSERT with `maxId + 1`. One fails on duplicate key (or both succeed if no unique constraint exists). No transaction or advisory lock serializes this.
Fix: Use a transaction with `SELECT ... FOR UPDATE`, or rely on an auto-increment column.

### H2. Course Deletion Without Transaction — Lines 500-506
Six sequential DELETE statements remove quiz_questions, course_resources, video_streams, progress, comments, and the course row itself. If any intermediate DELETE fails (constraint violation, connection loss), partial deletion occurs with orphaned related records.
Fix: Wrap the six deletes in withTransaction.

### H3. Referral Rules Batch Update Without Transaction — Lines 424-428
The for-loop executes one INSERT...ON DUPLICATE KEY UPDATE per rule. A failure on the third rule leaves rules 1 and 2 updated but rule 3 (and beyond) untouched, creating an inconsistent configuration state.
Fix: Wrap the loop in withTransaction.

### H4. Silent Failure When POST /admin-users Omitted Fields — Lines 223-226
Even when `userId` IS provided, if none of the optional fields (plan, expiresAt, role, nickname) are present, every `if (field)` guard is false, no queries execute, and the response is `{ ok: true }`. The caller cannot distinguish "nothing to update" from "successfully updated."
Fix: Return `{ ok: true, message: '无变更' }` when no fields were provided, or require at least one field.

### H5. Password Minimum Length Too Weak for Admin Resets — Line 248
`password.length < 6` allows 6-character passwords. For admin-initiated resets on user accounts, this is a security risk. Industry guidance recommends 8+ characters minimum.
Fix: Increase the threshold to at least 8, or 12 for admin operations.

### H6. No Email Format Validation in PUT Handler — Line 245
The `email` field is accepted and written to the database without any format check. A typo like `"notanemail"` would be stored as-is, potentially breaking email-dependent features (login, notifications, verification).
Fix: Validate against a basic email regex before the UPDATE.

---

## MEDIUM (10 findings)

### M1. Unsanitized Bilibili BV ID in URL — Line 459
`bilibiliId` from req.body is interpolated directly into a fetch URL: `https://api.bilibili.com/...?bvid=${bilibiliId}`. No encoding or format validation is performed. Malformed input could inject extra query parameters.
Fix: Validate against `/^BV[a-zA-Z0-9]{10}$/` and use encodeURIComponent.

### M2. Empty catch Block Silences Filename Decode Errors — Line 19
`try { file.originalname = Buffer.from(..., 'latin1').toString('utf8') } catch {}` discards the error completely. If decoding fails, the original (potentially mojibake) filename passes through undetected.
Fix: Log the error and/or fall back to a sanitized default name.

### M3. 12 Catch Blocks Suppress All Error Details — Lines 229/356/396/410/417/431/448/528/715/748/760
A significant number of error handlers follow the pattern `catch (err) { res.json({ ok: false, error: '...' }) }` with no `console.error()`. When these fire in production, the error message is invisible to operators, making debugging nearly impossible.
Fix: Add `console.error('[Admin] <context>:', err)` to each catch block.

### M4. `rate_bps || 1000` Treats Zero as Falsy — Line 427
If an admin intentionally sets `rate_bps` to 0 (meaning zero commission), the `||` operator replaces it with 1000 (10%). This silently overrides a deliberate configuration choice.
Fix: Use `r.rate_bps ?? 1000` to only default on null/undefined.

### M5. Duplicate VALID_PLANS / VALID_ROLES Definitions — Lines 217-218 and 238-239
The identical arrays `['free', 'plus', 'pro']` and `['user', 'admin']` are declared in both the POST and PUT handlers. If the valid values ever change, both locations must be updated in lockstep.
Fix: Move to module-level constants (e.g., `const VALID_PLANS = [...]`).

### M6. Quiz Insertion Logic Duplicated — Lines 573-601 vs 660-671
The code that parses a JSON array of questions, iterates, validates `q.question`/`q.options`, and INSERTs into quiz_questions appears twice: once in the explicit quiz-file branch and again in the auto-detect fallback branch. Any bug fix or feature addition must be applied to both.
Fix: Extract into a helper function like `insertQuizQuestions(episodeId, questions)`.

### M7. Quiz Count Update Pattern Repeated 5 Times
The sequence "SELECT COUNT(*) WHERE episode_id = ?" followed by "UPDATE courses SET quiz_count = ?" appears at lines 599-600, 671, 731-732, 744-745, and 756-757. Five separate copies of identical logic.
Fix: Extract to `async function refreshQuizCount(episodeId)`.

### M8. `limit` Parameter Unbounded — Lines 29/313
Both the admin-users and admin-audit endpoints accept `limit` from query parameters with no upper bound. A request with `limit=999999` forces the database to materialize and return an enormous result set, causing memory pressure and slow responses.
Fix: Clamp `limit` to a maximum (e.g., `Math.min(Number(limit), 200)`).

### M9. Negative Offset Possible — Line 30
If `page=0` or `page=-1`, the offset calculation `(Number(page) - 1) * Number(limit)` produces a negative number. While MySQL treats negative LIMIT/OFFSET as 0, this is undocumented behavior and could change across versions.
Fix: Ensure page >= 1: `const page = Math.max(1, Number(req.query.page || 1))`.

### M10. `episodeId` Could Be Negative — Line 533
`Number(req.body.episodeId)` accepts negative values. The guard `if (!episodeId)` catches NaN and 0, but `-1` passes through, creating a directory named `ep-1` and potentially confusing data.
Fix: Check `if (!episodeId || episodeId < 1)`.

---

## LOW (8 findings)

### L1. Unused Import `readFileSync` — Line 6
`readFileSync` is imported from `'fs'` but never used anywhere in the file.

### L2. Unused Variable `origName` — Line 556
`const origName = file.originalname` is declared but never referenced. The subsequent `relPath` variable (also `file.originalname`) is used instead.

### L3. Confusing Variable Name `uid` — Line 235
`const uid = id || userId` assigns a numeric user ID to a variable named `uid`. Throughout the codebase, `uid` typically refers to the display-style ID like `WS000001`. This creates ambiguity.

### L4. Content Count Query Uses Correlated Subqueries — Lines 99-106
The query `(SELECT COUNT(*) FROM comments WHERE user_id = u.id)` executes per user in the subquery. With 50 users per page, that is 150 additional subquery executions (30 comments, 30 posts, 30 replies). A set-based JOIN approach would be more efficient.

### L5. `pending_credit_cents` Hardcodes 500 — Line 352
`pending * 500` assumes each pending referral is worth exactly 500 cents. The actual value depends on the `referral_rules` table, which could have different rates per plan/period. This produces inaccurate data.

### L6. Commissions Endpoint Has No Pagination — Line 377
`LIMIT 100` is hardcoded with no offset support. If there are more than 100 referral records, the older ones are permanently inaccessible through this API.

### L7. JSON.parse Inside .map() Without Error Handling — Lines 710-712
`JSON.parse(q.options || '[]')` and `JSON.parse(q.explanations || '[]')` execute during the map callback. If any row has malformed JSON in the database that does not match the `'[]'` fallback condition, this throws an unhandled exception, failing the entire endpoint for all records.
Fix: Wrap each parse in try/catch or use a safe parser.

### L8. Large File Upload Capacity — Line 531
`resourceUpload.array('files', 50)` with a 20MB per-file limit allows up to 1GB of uploads in a single request. Combined with `multer.memoryStorage()`, this is held entirely in RAM, creating a denial-of-service vector.
Fix: Consider reducing the max file count, using disk storage, or adding a total size limit.

---

## Summary Statistics
- CRITICAL: 5 (security/data integrity)
- HIGH: 6 (logic errors, missing transactions)
- MEDIUM: 10 (validation, duplication, performance)
- LOW: 8 (dead code, naming, minor inefficiency)
- Total: 29 findings

## Positive Observations
- All SQL uses parameterized queries (no injection risk in query construction)
- User deletion (line 284) correctly uses withTransaction for atomic cascade
- Batch loading of user stats (lines 87-123) avoids N+1 query anti-pattern
- The adminOnly middleware properly gates all routes
- Error handling in the PUT handler (line 267) maps DB error codes to user-friendly messages
