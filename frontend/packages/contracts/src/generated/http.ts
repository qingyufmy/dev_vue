// Generated from contracts/http via openapi-v4.json. Do not edit.
export interface paths {
    "/admin/observer/channels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List observer channels for the current administrator */
        get: operations["listObserverChannelsForAdmin"];
        put?: never;
        /** Create an assigned, inactive observer channel */
        post: operations["createObserverChannel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/observer/channels/{channel_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Replace one observer channel configuration with CAS */
        put: operations["updateObserverChannel"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/observer/channels/{channel_id}/accesses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List explicit observer grants for one channel */
        get: operations["listObserverChannelAccesses"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/observer/channels/{channel_id}/accesses/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Grant or revoke one explicit observer access tombstone
         * @description A revoke removes only the explicit grant; it does not override an all/plus/pro audience rule.
         */
        put: operations["setObserverChannelAccess"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/observer/default-channel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Set or clear the default observer channel with registry CAS */
        put: operations["setObserverDefaultChannel"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/observer/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List observer management operation receipts
         * @description Admin-only audit-safe receipt fields plus the canonical command in audit_json; idempotency keys and request hashes are never returned.
         */
        get: operations["listObserverManagementOperations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/observer/sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List observer sources for the current administrator
         * @description Uses only the admin-web Host-only session. Results are bounded by an opaque stable-id cursor and never expose private bridge credentials.
         */
        get: operations["listObserverSourcesForAdmin"];
        put?: never;
        /** Create a disabled, pending observer source */
        post: operations["createObserverSource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/observer/sources/{source_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Replace one observer source configuration with CAS */
        put: operations["updateObserverSource"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/referrals/rules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read current administrator referral configuration and revisions
         * @description Admin host and admin-web session only. No query parameters. No synthetic default rules; disabled records are returned. Responses use Cache-Control: no-store.
         */
        get: operations["listReferralRules"];
        /**
         * Update referral rules atomically with revision checks and audit receipts
         * @description Admin host and admin-web session only. CSRF and Origin are checked. Reuse the same UUID and complete request after an uncertain result; a changed payload is rejected. Stored rule revisions are strings. This endpoint does not calculate or pay commission.
         */
        put: operations["updateReferralRules"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/settings/value": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read one stored setting with secret redaction
         * @description Admin host and admin-web session only. Only namespace and key query parameters are accepted; value type is resolved by the server registry. Missing rows return 404, NULL and empty remain distinct. Protected credentials omit value entirely. No legacy fallback.
         */
        get: operations["readAdminSystemSetting"];
        /**
         * Update an existing non-secret configuration value with a durable request receipt
         * @description Admin host and admin-web session only; CSRF and Origin checked. No query parameters. Exact string revisions and raw text values. Reuse the same UUID and complete body after an uncertain result. Credentials and service-owned fields are rejected. Domain-dependent settings remain unavailable until their semantic checks are provided. This endpoint does not create settings or migrate legacy values.
         */
        put: operations["updateSystemSetting"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/strategies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Administrator platform strategy listPlatformStrategies */
        get: operations["listPlatformStrategies"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/strategies/{strategy_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Administrator platform strategy getPlatformStrategy */
        get: operations["getPlatformStrategy"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/strategies/{strategy_id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create an administrator-managed platform strategy draft version */
        post: operations["createPlatformStrategyVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/strategies/{strategy_id}/versions/{version_id}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Administrator platform strategy publishPlatformStrategyVersion */
        post: operations["publishPlatformStrategyVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/analysis-jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a manual analysis job
         * @description Retain the original idempotency key and complete body after an uncertain submission. A queued task is not a completed analysis or terminal trade.
         */
        post: operations["createAnalysisJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/audit/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List current-user audit events from authoritative domain records
         * @description Returns a frozen keyset page. The audit feed is a read projection and never stores a duplicate universal log payload.
         */
        get: operations["listAuditEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/audit/events/{source_kind}/{source_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one audit event and its exact execution trace */
        get: operations["getAuditEvent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Authenticate at auth host and continue an Authorization Code + PKCE request */
        post: operations["loginAtIdentityCenter"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Revoke the current identity center session
         * @description Identity center host only. Requires the current auth session CSRF token and exact issuer Origin. Clears the auth cookie; does not revoke other application or Bridge sessions. A repeated request after revocation returns 401.
         */
        post: operations["logoutAuthCenterSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the identity center session
         * @description Identity center host only. Uses the auth session, not an application session. Returns Cache-Control: no-store. Does not provide application permissions.
         */
        get: operations["getAuthCenterSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/connection-capacity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get included, purchased and currently used trading-account connection capacity */
        get: operations["getBridgeConnectionCapacity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/credential-revocations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Idempotently revoke the exact V4 device refresh credential
         * @description The token and device binding identify the exact generation. Confirmation remains available after membership expiry or earlier revocation. Later rotated tokens, accounts, ownership and execution history are unaffected. Routes reject subsequent authorization checks; physical socket closure is asynchronous.
         */
        post: operations["revokeBridgeDeviceCredential"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/installation-authorizations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** startBridgeInstallationAuthorization */
        post: operations["startBridgeInstallationAuthorization"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/installation-authorizations/{authorization_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getBridgeInstallationAuthorization */
        get: operations["getBridgeInstallationAuthorization"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/installation-authorizations/{authorization_id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** decideBridgeInstallationAuthorization */
        post: operations["decideBridgeInstallationAuthorization"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/installation-authorizations/{authorization_id}/poll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** pollBridgeInstallationAuthorization */
        post: operations["pollBridgeInstallationAuthorization"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/installations/profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** registerBridgeInstallationProfile */
        post: operations["registerBridgeInstallationProfile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/installations/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** revokeBridgeInstallation */
        post: operations["revokeBridgeInstallation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/installations/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** getBridgeInstallationStatus */
        post: operations["getBridgeInstallationStatus"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/legacy-credential-exchanges": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rotate a valid V3 refresh credential into a V4 device refresh credential */
        post: operations["exchangeLegacyBridgeCredential"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/pairing-redemptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Bind a client-generated random refresh credential to a one-use pairing code
         * @description The client retains the same installation ID and random credential for lost-response retries. Codes expire after ten minutes; redemption does not grant trading account ownership. Never send secrets through URLs.
         */
        post: operations["redeemBridgePairing"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/pairing-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve a ten-minute pairing code hash for the current trade user */
        post: operations["createBridgePairingRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/session-tokens": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Exchange a V4 device refresh credential for a short-lived Bridge session token */
        post: operations["createBridgeSessionToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/bridge/terminal-profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List replaceable MT4 and MT5 terminal profiles without counting offline profiles as capacity */
        get: operations["listTerminalProfiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/execution-distributions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an asynchronous strategy distribution
         * @description The server resolves and freezes the eligible subscribers for the strategy version. Each target is independently authorized, risk checked and executed. Retain the original key and complete body after an uncertain result.
         */
        post: operations["createExecutionDistribution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/execution-distributions/{distribution_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the frozen targets and current state of an administrator distribution */
        get: operations["getExecutionDistribution"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/execution-distributions/{distribution_id}/close-commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an exact asynchronous close for distribution targets
         * @description Targets are selected only by frozen distribution target IDs. An empty target_ids value means all still-attributable targets; symbol, strategy and ticket filters are not accepted. Retain the original key and complete body after an uncertain result.
         */
        post: operations["createDistributionCloseCommand"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/execution-distributions/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Estimate the currently eligible account scope before distribution confirmation
         * @description This is a read-only estimate. The immutable target set is resolved and frozen again when the distribution is accepted.
         */
        get: operations["previewExecutionDistribution"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/history/executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List personally owned retained historical executions
         * @description Original legacy IDs and UTC times. Authenticated original user only; system owner 0 is not a browser identity. Does not create or retry runtime work.
         */
        get: operations["listArchivedExecutions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/history/executions/{legacy_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get personally owned retained historical executions
         * @description Original legacy IDs and UTC times. Authenticated original user only; system owner 0 is not a browser identity. Does not create or retry runtime work.
         */
        get: operations["getArchivedExecution"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/history/executions/{legacy_id}/deals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List exact retained deals for an originally owned legacy execution
         * @description Original user and legacy account identity only; no ticket/time proximity matching. Decimal values are strings. Empty history is not proof that no trade occurred.
         */
        get: operations["listArchivedExecutionDeals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/history/signals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List personally owned retained historical signals
         * @description Original legacy IDs and UTC times. Authenticated original user only; system owner 0 is not a browser identity. Does not create or retry runtime work.
         */
        get: operations["listArchivedSignals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/history/signals/{legacy_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get personally owned retained historical signals
         * @description Original legacy IDs and UTC times. Authenticated original user only; system owner 0 is not a browser identity. Does not create or retry runtime work.
         */
        get: operations["getArchivedSignal"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/learning/courses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read migrated learning data on www host
         * @description WWW host only. Private no-store. Detail uses only www-web session; locked results contain no lessons, media or progress. Progress is scoped to authenticated user.
         */
        get: operations["listLearningCourses"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/learning/courses/{courseId}/lessons/{lessonId}/completion": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set current user's explicit lesson completion marker
         * @description WWW session, exact Origin and CSRF required. Preserves watched time and quiz status. Same idempotency key and body replay the original receipt; stale revision returns 409. On 503 or network uncertainty retain the original key and body. Revision zero means no existing progress row; unsigned BIGINT overflow is rejected.
         */
        put: operations["setLearningCompletion"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/learning/courses/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read migrated learning data on www host
         * @description WWW host only. Private no-store. Detail uses only www-web session; locked results contain no lessons, media or progress. Progress is scoped to authenticated user.
         */
        get: operations["getLearningCourse"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/manual-review-candidates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List server-attributed manual trades eligible for review */
        get: operations["listManualReviewCandidates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/manual-review-cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Queue a review for frozen manual-trade evidence */
        post: operations["createManualReviewCase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market-analyses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List market-analysis summaries owned by the current system user */
        get: operations["listMarketAnalyses"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market-analyses/{analysis_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one complete market analysis */
        get: operations["getMarketAnalysis"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market-analyses/{analysis_id}/trader-evaluations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Explicitly submit one valid market analysis for one account evaluation
         * @description Retain the original idempotency key and complete body after an uncertain submission. A queued task is not a completed analysis or terminal trade.
         */
        post: operations["createTraderEvaluation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/calendar-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List economic calendar events by schedule and importance */
        get: operations["listEconomicCalendarEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/calendar-events/{event_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one economic calendar event at its latest known revision */
        get: operations["getEconomicCalendarEvent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/candles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List a historical candle window */
        get: operations["listMarketCandles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/macro-series": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List point-in-time macro series observations */
        get: operations["listMacroSeriesPoints"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/macro-snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List published platform macro snapshot summaries with a stable cursor */
        get: operations["listMacroSnapshots"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/macro-snapshots/{snapshot_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one immutable published platform macro snapshot */
        get: operations["getMacroSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/macro-snapshots/latest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the latest compatible published platform macro snapshot */
        get: operations["getLatestMacroSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the latest bounded macro summary and nearby high-impact calendar events */
        get: operations["getMacroMarketOverview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/public-snapshot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the shared administrator market cache without exposing provider accounts */
        get: operations["getPublicMarketSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/public-symbols": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the administrator-managed base-symbol catalog */
        get: operations["listPublicMarketSymbols"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/quotes/{symbol}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current quote for one symbol */
        get: operations["getMarketQuote"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/symbols": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read current owned terminal market data */
        get: operations["listTerminalMarketSymbols"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/market/terminal-window": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read current owned terminal market data */
        get: operations["getTerminalMarketWindow"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-assignments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getModelAssignments"];
        put: operations["setModelAssignments"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-configurations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listModelConfigurations"];
        put?: never;
        post: operations["createModelConfiguration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-configurations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["saveModelConfiguration"];
        post?: never;
        delete: operations["deleteModelConfiguration"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-configurations/{id}/verification": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["verifyModelConfiguration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-selection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read or select an available runtime model */
        get: operations["getModelSelection"];
        /** Read or select an available runtime model */
        put: operations["setModelSelection"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/observer-channels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List observer channels authorized for the current user */
        get: operations["listObserverChannels"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/operations/{operation_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an asynchronous operation */
        get: operations["getOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/personal/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getPersonalNotifications */
        get: operations["getPersonalNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/personal/notifications/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** readPersonalNotification */
        post: operations["readPersonalNotification"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/personal/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getPersonalSettings */
        get: operations["getPersonalSettings"];
        /** savePersonalSettings */
        put: operations["savePersonalSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/positions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List current positions
         * @description Owner-only current position snapshot. Cursor is scoped to the authenticated user, account and snapshot revision; a changed snapshot returns 409 and requires restarting pagination. Tickets are ordered as exact text.
         */
        get: operations["listPositions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/realtime/tickets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a one-time realtime connection ticket
         * @description Sets a short-lived, one-time, HttpOnly realtime ticket cookie.
         */
        post: operations["createRealtimeTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the current user's daily, monthly, manual and single-trade review cases */
        get: operations["listReviewCases"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one evidence-linked review case */
        get: operations["getReviewCase"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm exactly the current immutable review version */
        post: operations["confirmReviewVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}/generations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry with frozen evidence or request a new evidence revision */
        post: operations["requestReviewGeneration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getReviewHistoricalMetadata */
        get: operations["getReviewHistoricalMetadata"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}/history/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读取归档复盘事件 */
        get: operations["listArchivedReviewEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}/history/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读取归档复盘作业 */
        get: operations["listArchivedReviewJobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}/history/stages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读取归档复盘阶段 */
        get: operations["listArchivedReviewStages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}/return": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Return a review version for changes */
        post: operations["returnReviewCase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** listReviewVersions */
        get: operations["listReviewVersions"];
        put?: never;
        /** Create an immutable user-edited review version */
        post: operations["createReviewVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/review-cases/{review_case_id}/versions/{version_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getReviewVersion */
        get: operations["getReviewVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/risk-accounts/{account_id}/manual-release": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the latest audited account risk manual release */
        get: operations["getManualRiskRelease"];
        put?: never;
        /** Acknowledge and release the current account-level risk breach episode */
        post: operations["createManualRiskRelease"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/risk-accounts/{account_id}/manual-release-receipt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Confirm the exact manual release request receipt
         * @description Rechecks current account ownership. An unconfirmed result does not establish transaction failure and must not cause a new idempotency key. Confirmed identifies the stored operation, not current release validity.
         */
        get: operations["getManualRiskReleaseReceipt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/risk-accounts/{account_id}/policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an account risk policy */
        get: operations["getRiskPolicy"];
        /** Replace an account risk policy */
        put: operations["replaceRiskPolicy"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/risk-accounts/{account_id}/policy-receipt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the exact original policy write receipt
         * @description Rechecks current account ownership. An unconfirmed result does not establish transaction failure and must not cause a new idempotency key. Confirmed identifies the stored operation, not current release validity.
         */
        get: operations["getRiskPolicyReceipt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/risk-accounts/{account_id}/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current deterministic account risk summary */
        get: operations["getAccountRiskSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/risk-decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List deterministic risk decisions for one owned account */
        get: operations["listRiskDecisions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/risk-decisions/{risk_decision_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one complete deterministic risk decision */
        get: operations["getRiskDecision"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current Host-only application session */
        get: operations["getApplicationSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/session/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke only the current application session */
        post: operations["logoutCurrentApplication"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/session/logout-web": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke auth, www, trade and admin web sessions without revoking Bridge */
        post: operations["logoutAllWebApplications"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/session/revoke-all": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** After recent authentication, revoke all website and Bridge device sessions */
        post: operations["revokeAllSessionsAndDevices"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List strategies visible to the current user */
        get: operations["listStrategies"];
        put?: never;
        /** Create a user-owned strategy with its first immutable draft version */
        post: operations["createStrategy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategies/{strategy_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one visible strategy and its immutable version history */
        get: operations["getStrategy"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Change user-owned strategy metadata with optimistic concurrency */
        patch: operations["updateStrategyMetadata"];
        trace?: never;
    };
    "/strategies/{strategy_id}/retire": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retire a user-owned strategy while preserving its audit history */
        post: operations["retireStrategy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategies/{strategy_id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a new immutable user-owned strategy version */
        post: operations["createStrategyVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategies/{strategy_id}/versions/{version_id}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish one immutable version as the active strategy version */
        post: operations["publishStrategyVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategies/compile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Validate and normalize a strategy draft without persisting it */
        post: operations["compileStrategy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategy-combinations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create an analysis and trader strategy pair atomically */
        post: operations["createStrategyCombination"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategy-combinations/{analysis_strategy_id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create analysis and trader versions atomically */
        post: operations["createStrategyCombinationVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategy-memories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List one memory library per accessible strategy */
        get: operations["listStrategyMemories"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategy-memories/{memory_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current immutable strategy-memory revision */
        get: operations["getStrategyMemory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategy-memories/{memory_id}/updates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List exact review-derived memory deltas and conflicts */
        get: operations["listStrategyMemoryUpdates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategy-memory-updates/{update_id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Accept, reject or revoke one review-derived memory update with CAS */
        post: operations["decideStrategyMemoryUpdate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategy-subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List strategy subscriptions owned by the current user */
        get: operations["listStrategySubscriptions"];
        put?: never;
        /** Subscribe an owned trading account to active analysis and optional trader strategies */
        post: operations["createStrategySubscription"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/strategy-subscriptions/{subscription_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Change an account strategy subscription with optimistic concurrency */
        patch: operations["updateStrategySubscription"];
        trace?: never;
    };
    "/strategy-subscriptions/trader-control": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Atomically enable or disable account AI trader subscriptions */
        post: operations["setAccountTrader"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trade-decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List AI trader decisions for one owned trading account */
        get: operations["listTradeDecisions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trade-decisions/{decision_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one complete account-level AI trader decision */
        get: operations["getTradeDecision"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trade-history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List one owned account's reconciled terminal trade history
         * @description Returns a frozen keyset page. Date filters use the stored terminal business date; HTTP carries records and chart data while realtime only invalidates this snapshot.
         */
        get: operations["listTradeHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trade-history/{trade_record_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one authoritative record with terminal deals and exact evidence links */
        get: operations["getTradeRecord"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trading-accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List trading accounts owned by the current system user */
        get: operations["listTradingAccounts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trading-accounts/{account_id}/execution-commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create one asynchronous command for an owned trading account
         * @description The server validates authorization, idempotency, optimistic revisions and risk before creating an execution intent. Accepted means durably recorded, not executed by MT. After an uncertain result, retain the same idempotency key and complete request body; do not create a replacement command.
         */
        post: operations["createExecutionCommand"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trading-accounts/{account_id}/execution-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the exact revisions and broker limits required to confirm a user command */
        get: operations["getExecutionCommandContext"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trading-accounts/{account_id}/snapshot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a consistent trading account snapshot */
        get: operations["getTradingAccountSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trading-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current trading context */
        get: operations["getTradingContext"];
        /**
         * Select one owned trading account or an authorized observer channel
         * @description The key and original body/revision identify one command. A replay returns its historical context; read the current context after confirmation.
         */
        put: operations["replaceTradingContext"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trading-context/commands/{request_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the authenticated user historical context command receipt
         * @description Null means no committed receipt is visible yet, not proof that the command failed. Never cache this response.
         */
        get: operations["getTradingContextReceipt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/trading-context/observer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Exit observer mode and restore the first owned account when available
         * @description The key and original body/revision identify one command. A replay returns its historical context; read the current context after confirmation.
         */
        delete: operations["leaveObserverMode"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        AccountRiskSummary: {
            account_id: components["schemas"]["OpaqueId"];
            business_date: string | null;
            /** @enum {string} */
            clock_status: "calibrated" | "observer_bootstrap" | "stale" | "unavailable";
            consecutive_losses: number;
            cooldown_until: components["schemas"]["UtcDateTime"] | null;
            daily_loss_percent: components["schemas"]["Decimal"];
            daily_open_count: number;
            data_complete: boolean;
            drawdown_percent: components["schemas"]["Decimal"];
            equity: components["schemas"]["Decimal"];
            free_margin: components["schemas"]["Decimal"];
            incomplete_reasons: string[];
            last_successful_open_at: components["schemas"]["UtcDateTime"] | null;
            margin_level_percent: components["schemas"]["Decimal"] | null;
            observed_at: components["schemas"]["UtcDateTime"];
            open_positions: number;
            pending_orders: number;
            revision: components["schemas"]["Revision"];
            terminal_timezone_offset_minutes: number | null;
            total_volume: components["schemas"]["Decimal"];
        };
        AccountRiskSummaryResponse: {
            data: components["schemas"]["AccountRiskSummary"];
            meta: components["schemas"]["Meta"];
        };
        AccountSnapshot: {
            balance: components["schemas"]["Decimal"];
            /** @enum {string} */
            bridge_state: "online" | "offline" | "paused" | "replaced" | "unauthorized";
            /** @enum {string} */
            clock_status: "calibrated" | "observer_bootstrap" | "stale" | "unavailable";
            currency: string;
            equity: components["schemas"]["Decimal"];
            floating_profit: components["schemas"]["Decimal"];
            free_margin: components["schemas"]["Decimal"];
            id: components["schemas"]["OpaqueId"];
            last_seen_at: components["schemas"]["UtcDateTime"] | null;
            leverage: number | null;
            login: string;
            margin: components["schemas"]["Decimal"];
            observed_at: components["schemas"]["UtcDateTime"];
            /** @enum {string} */
            platform: "mt4" | "mt5";
            revision: components["schemas"]["Revision"];
            server: string;
            terminal_instance_id: components["schemas"]["OpaqueId"] | null;
            terminal_profile_id: components["schemas"]["OpaqueId"] | null;
            timezone_offset_minutes: number | null;
            trade_permission: boolean;
        };
        AccountSnapshotResponse: {
            data: components["schemas"]["AccountSnapshot"];
            meta: components["schemas"]["Meta"];
        };
        AnalysisJob: {
            analysis_id: components["schemas"]["OpaqueId"];
            created_at: components["schemas"]["UtcDateTime"];
            revision: components["schemas"]["Revision"];
            /** @enum {string} */
            status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
            strategy_id: components["schemas"]["OpaqueId"];
            strategy_version_id: components["schemas"]["OpaqueId"];
            symbol: components["schemas"]["Symbol"];
            /** @enum {string} */
            trigger: "manual" | "scheduled" | "event";
            updated_at: components["schemas"]["UtcDateTime"];
        };
        AnalysisJobCreate: {
            /** @constant */
            mode: "manual";
            strategy_id: components["schemas"]["OpaqueId"];
            symbol: components["schemas"]["Symbol"];
        };
        AnalysisJobResponse: {
            data: components["schemas"]["AnalysisJob"];
            meta: components["schemas"]["Meta"];
        };
        ArchivedExecutionDeal: {
            commission: string;
            deal_ticket: string;
            entry_type: number | null;
            fee: string;
            legacy_id: string;
            legacy_outcome_id: string;
            /** Format: date-time */
            occurred_at_utc: string | null;
            order_ticket: string | null;
            position_id: string | null;
            price: string | null;
            profit: string;
            swap: string;
            volume: string;
        };
        ArchivedExecutionDealsResponse: {
            data: {
                /** @enum {boolean} */
                executable: false;
                /** @enum {string} */
                identity_namespace: "retained-legacy";
                items: components["schemas"]["ArchivedExecutionDeal"][];
                legacy_execution_id: string;
                next_cursor: string | null;
            };
            meta: components["schemas"]["Meta"];
        };
        ArchivedExecutionDetail: {
            action: string;
            /** Format: date-time */
            completed_at_utc: string | null;
            /** Format: date-time */
            created_at_utc: string;
            error_code: string | null;
            /** @enum {boolean} */
            executable: false;
            /** @enum {string} */
            identity_namespace: "retained-legacy";
            legacy_account_id: string | null;
            legacy_id: string;
            pending_ticket: string | null;
            status: string;
            symbol: string | null;
            trade_ticket: string | null;
        };
        ArchivedExecutionSummary: {
            action: string;
            /** Format: date-time */
            created_at_utc: string;
            legacy_account_id: string | null;
            legacy_id: string;
            status: string;
            symbol: string | null;
        };
        ArchivedReviewEvent: {
            id: string;
            job_id: string;
            message_code: string | null;
            /** Format: date-time */
            occurred_at: string;
            original_status: string;
            stage: string | null;
        };
        ArchivedReviewEventPageResponse: {
            data: {
                items: components["schemas"]["ArchivedReviewEvent"][];
                next_offset: number | null;
                total: number;
            };
            meta: components["schemas"]["Meta"];
        };
        ArchivedReviewJob: {
            attempts: number;
            /** Format: date-time */
            completed_at: string | null;
            /** Format: date-time */
            created_at: string;
            error_code: string | null;
            id: string;
            original_status: string;
            source_id: string;
            /** @enum {string} */
            source_table: "period_review_jobs" | "manual_trade_review_jobs";
            stage: string | null;
            /** Format: date-time */
            updated_at: string;
        };
        ArchivedReviewJobPageResponse: {
            data: {
                items: components["schemas"]["ArchivedReviewJob"][];
                next_offset: number | null;
                total: number;
            };
            meta: components["schemas"]["Meta"];
        };
        ArchivedReviewStage: {
            /** Format: date-time */
            completed_at: string | null;
            /** Format: date-time */
            created_at: string;
            error_code: string | null;
            generation: number;
            has_output: boolean;
            id: string;
            input_hash: string | null;
            job_id: string;
            original_status: string;
            output_hash: string | null;
            stage: string;
        };
        ArchivedReviewStagePageResponse: {
            data: {
                items: components["schemas"]["ArchivedReviewStage"][];
                next_offset: number | null;
                total: number;
            };
            meta: components["schemas"]["Meta"];
        };
        ArchivedSignalDetail: {
            analysis: string | null;
            /** Format: date-time */
            created_at_utc: string;
            /** @enum {boolean} */
            executable: false;
            /** @enum {string} */
            identity_namespace: "retained-legacy";
            inference_task_id: string | null;
            legacy_id: string;
            reasoning: string | null;
            signal_type: string;
            symbol: string;
            timeframe: string;
        };
        ArchivedSignalSummary: {
            /** Format: date-time */
            created_at_utc: string;
            legacy_id: string;
            signal_type: string;
            symbol: string;
            timeframe: string;
        };
        /** @enum {string} */
        AuditActor: "ai" | "user" | "system" | "bridge";
        /** @enum {string} */
        AuditCategory: "analysis" | "trading" | "risk" | "execution" | "terminal" | "configuration";
        AuditEvent: {
            account_id: components["schemas"]["OpaqueId"] | null;
            action: string;
            actor: components["schemas"]["AuditActor"];
            category: components["schemas"]["AuditCategory"];
            correlation_id: string | null;
            occurred_at: components["schemas"]["UtcDateTime"];
            reason_code: string | null;
            source_id: components["schemas"]["OpaqueId"];
            source_kind: components["schemas"]["AuditSourceKind"];
            status: components["schemas"]["AuditStatus"];
            summary: string;
            symbol: string | null;
            terminal_timezone_offset_minutes: number | null;
            title: string;
        };
        AuditEventDetailResponse: {
            data: {
                event: components["schemas"]["AuditEvent"];
                evidence: {
                    label: string;
                    value: string;
                }[];
                links: {
                    id: components["schemas"]["OpaqueId"];
                    /** @enum {string} */
                    kind: "analysis" | "trader" | "risk" | "operation" | "trade";
                    label: string;
                }[];
                trace: components["schemas"]["AuditTraceNode"][];
            };
            meta: components["schemas"]["Meta"];
        };
        AuditEventPageResponse: {
            data: {
                captured_end: components["schemas"]["UtcDateTime"];
                has_more: boolean;
                items: components["schemas"]["AuditEvent"][];
                next_cursor: string | null;
                summary: components["schemas"]["AuditSummary"];
            };
            meta: components["schemas"]["Meta"];
        };
        /** @enum {string} */
        AuditSourceKind: "analysis_run" | "trader_run" | "trade_decision" | "risk_decision" | "operation" | "bridge_command" | "risk_policy_change" | "risk_manual_release" | "terminal_trade";
        /** @enum {string} */
        AuditStatus: "queued" | "running" | "succeeded" | "partially_succeeded" | "rejected" | "failed" | "uncertain" | "cancelled" | "info";
        AuditSummary: {
            active: number;
            failed: number;
            rejected: number;
            succeeded: number;
            total: number;
            uncertain: number;
        };
        AuditTraceNode: {
            action_kind?: string | null;
            detail: string;
            intent_id?: string | null;
            occurred_at: components["schemas"]["UtcDateTime"];
            parameters?: {
                price?: string;
                side?: string;
                stop_loss?: string;
                symbol?: string;
                take_profit?: string;
                ticket?: string;
                volume?: string;
            };
            reason_code: string | null;
            source_id: components["schemas"]["OpaqueId"];
            source_kind: string;
            /** @enum {string} */
            stage: "analysis" | "trader" | "risk" | "operation" | "intent" | "bridge" | "terminal";
            status: components["schemas"]["AuditStatus"];
            title: string;
        };
        AuthCenterSessionResponse: {
            data: {
                authenticated_at: components["schemas"]["UtcDateTime"];
                csrf_token: string;
                /** @enum {string} */
                mfa_level: "none" | "otp" | "strong";
                user: components["schemas"]["Session"]["user"];
            };
            meta: components["schemas"]["Meta"];
        };
        AuthLoginRequest: components["schemas"]["AuthorizationFields"] & {
            login: string;
            password: string;
            remember?: boolean;
        };
        AuthLoginResponse: {
            data: {
                /** Format: uri */
                redirect_to: string;
            };
            meta: components["schemas"]["Meta"];
        };
        AuthorizationFields: {
            /** @enum {string} */
            client_id: "www-web" | "trade-web" | "admin-web";
            code_challenge: string;
            /** @constant */
            code_challenge_method: "S256";
            nonce: string;
            /** Format: uri */
            redirect_uri: string;
            /** @constant */
            response_type: "code";
            /** @constant */
            scope: "openid profile";
            state: string;
        };
        AuthorizationRequest: components["schemas"]["AuthorizationFields"];
        BridgeCredentialRevocationResponse: {
            data: {
                /** @constant */
                credential_type: "bridge_revocation";
                generation: number;
                installation_id: components["schemas"]["BridgeDeviceId"];
                profile_id: components["schemas"]["BridgeDeviceId"];
                /** @constant */
                revoked: true;
            };
            meta: components["schemas"]["Meta"];
        };
        BridgeDeviceId: string;
        BridgeInstallationConfirmation: {
            /** Format: uuid */
            authorization_id: string;
            /** Format: date-time */
            created_at: string;
            current_user: components["schemas"]["BridgeInstallationUser"];
            device_name: string;
            /** Format: date-time */
            expires_at: string;
            installation_id: string;
            revision: string;
            /** @enum {unknown} */
            status: "pending" | "approved" | "denied" | "expired" | "revoked";
        };
        BridgeInstallationConfirmationResponse: {
            data: components["schemas"]["BridgeInstallationConfirmation"];
            meta: components["schemas"]["Meta"];
        };
        BridgeInstallationDecision: {
            current_user_id: string;
            /** @enum {unknown} */
            decision: "approved" | "denied";
            expected_revision: string;
        };
        BridgeInstallationPoll: {
            installation_token: string;
            poll_secret: string;
        };
        BridgeInstallationPolled: {
            /** @constant */
            poll_interval_seconds: 5;
            /** @enum {unknown} */
            status: "pending" | "denied" | "expired" | "revoked";
        } | {
            /** @constant */
            authorized: true;
            generation: number;
            installation_id: string;
            /** @constant */
            poll_interval_seconds: 5;
            /** @constant */
            status: "approved";
            user: components["schemas"]["BridgeInstallationUser"];
        };
        BridgeInstallationPolledResponse: {
            data: components["schemas"]["BridgeInstallationPolled"];
            meta: components["schemas"]["Meta"];
        };
        BridgeInstallationProfile: {
            /** @constant */
            credential_type: "bridge_refresh";
            generation: number;
            installation_id: string;
            profile_id: string;
            /** @constant */
            session_token_path: "/api/v4/bridge/session-tokens";
            /** @constant */
            websocket_path: "/bridge/v4/ws";
        };
        BridgeInstallationProfileRequest: {
            installation_id: string;
            installation_token: string;
            refresh_token: string;
            request_key: string;
        };
        BridgeInstallationProfileResponse: {
            data: components["schemas"]["BridgeInstallationProfile"];
            meta: components["schemas"]["Meta"];
        };
        BridgeInstallationProof: {
            installation_id: string;
            installation_token: string;
        };
        BridgeInstallationRevoked: {
            installation_id: string;
            /** @constant */
            revoked: true;
        };
        BridgeInstallationRevokedResponse: {
            data: components["schemas"]["BridgeInstallationRevoked"];
            meta: components["schemas"]["Meta"];
        };
        BridgeInstallationStart: {
            device_name: string;
            installation_id: string;
            installation_token_hash: string;
            poll_secret_hash: string;
            request_key: string;
        };
        BridgeInstallationStarted: {
            /** Format: uuid */
            authorization_id: string;
            confirmation_path: string;
            /** Format: date-time */
            expires_at: string;
            /** @constant */
            poll_interval_seconds: 5;
        };
        BridgeInstallationStartedResponse: {
            data: components["schemas"]["BridgeInstallationStarted"];
            meta: components["schemas"]["Meta"];
        };
        BridgeInstallationStatus: {
            /** @constant */
            authorized: true;
            capacity: {
                active: number;
                available: number;
                included: number;
                purchased: number;
                total: number;
            };
            generation: number;
            installation_id: string;
            user: components["schemas"]["BridgeInstallationUser"];
        };
        BridgeInstallationStatusResponse: {
            data: components["schemas"]["BridgeInstallationStatus"];
            meta: components["schemas"]["Meta"];
        };
        BridgeInstallationUser: {
            display_name: string;
            id: string;
        };
        BridgePairingCredentialResponse: {
            data: {
                /** @constant */
                credential_type: "bridge_refresh";
                generation: number;
                installation_id: components["schemas"]["BridgeDeviceId"];
                profile_id: components["schemas"]["BridgeDeviceId"];
                /** @constant */
                session_token_path: "/api/v4/bridge/session-tokens";
                /** @constant */
                websocket_path: "/bridge/v4/ws";
            };
            meta: components["schemas"]["Meta"];
        };
        BridgePairingRedemption: {
            installation_id: components["schemas"]["BridgeDeviceId"];
            pairing_code: string;
            /** @description Client-generated CSPRNG 48-byte secret. Persist securely before redemption and reuse for retries. */
            refresh_token: string;
        };
        BridgePairingRequest: {
            /** @description SHA-256 of bpc_ plus base64url of 32 cryptographically random bytes, generated in browser memory. */
            code_hash: string;
        };
        BridgePairingResponse: {
            data: {
                /** Format: date-time */
                expires_at: string;
                /** Format: uuid */
                pairing_id: string;
                profile_id: components["schemas"]["BridgeDeviceId"];
            };
            meta: components["schemas"]["Meta"];
        };
        BridgeRefreshCredential: {
            /** @constant */
            credential_type: "bridge_refresh";
            generation: number;
            refresh_token: components["schemas"]["BridgeRefreshToken"];
            /** @constant */
            session_token_path: "/api/v4/bridge/session-tokens";
            /** @constant */
            websocket_path: "/bridge/v4/ws";
        };
        BridgeRefreshCredentialResponse: {
            data: components["schemas"]["BridgeRefreshCredential"];
            meta: components["schemas"]["Meta"];
        };
        BridgeRefreshToken: string;
        BridgeSessionToken: {
            access_token: string;
            /** @constant */
            credential_type: "bridge_session";
            expires_in_seconds: number;
            /** @constant */
            websocket_path: "/bridge/v4/ws";
        };
        BridgeSessionTokenRequest: {
            installation_id: components["schemas"]["BridgeDeviceId"];
            profile_id: components["schemas"]["BridgeDeviceId"];
            refresh_token: components["schemas"]["BridgeRefreshToken"];
        };
        BridgeSessionTokenResponse: {
            data: components["schemas"]["BridgeSessionToken"];
            meta: components["schemas"]["Meta"];
        };
        /** Format: date */
        BusinessDate: string;
        CancelOrderCommand: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            command_type: "cancel_order";
            expected_state: components["schemas"]["ExecutionResourceExpectedState"];
            ticket: components["schemas"]["Ticket"];
        };
        Candle: {
            account_id: components["schemas"]["OpaqueId"];
            close: components["schemas"]["Decimal"];
            closed: boolean;
            high: components["schemas"]["Decimal"];
            low: components["schemas"]["Decimal"];
            open: components["schemas"]["Decimal"];
            open_time: components["schemas"]["UtcDateTime"];
            revision: components["schemas"]["Revision"];
            symbol: components["schemas"]["Symbol"];
            tick_volume: components["schemas"]["Decimal"];
            timeframe: components["schemas"]["Timeframe"];
        };
        CandleListResponse: {
            data: {
                items: components["schemas"]["Candle"][];
            };
            meta: components["schemas"]["Meta"];
        };
        ClosePositionCommand: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            command_type: "close_position";
            expected_state: components["schemas"]["ExecutionResourceExpectedState"];
            ticket: components["schemas"]["Ticket"];
            volume?: components["schemas"]["PositiveDecimal"];
        };
        ConnectionCapacityResponse: {
            data: {
                active: number;
                available: number;
                included: number;
                purchased: number;
                total: number;
            };
            meta: components["schemas"]["Meta"];
        };
        Decimal: string;
        DistributionCloseCommand: {
            expected_revision: components["schemas"]["ExecutionRevision"];
            target_ids: components["schemas"]["OpaqueId"][];
        };
        DistributionMarketOrderCommand: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            command_type: "market_order";
            reference_price: components["schemas"]["PositiveDecimal"];
            /** @enum {string} */
            side: "buy" | "sell";
            stop_loss: components["schemas"]["PositiveDecimal"];
            symbol: components["schemas"]["Symbol"];
            take_profit?: components["schemas"]["PositiveDecimal"];
            volume: components["schemas"]["PositiveDecimal"];
        };
        DistributionPendingOrderCommand: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            command_type: "pending_order";
            /** Format: int64 */
            expiration_utc_msc?: number;
            /** @enum {string} */
            order_type: "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop" | "buy_stop_limit" | "sell_stop_limit";
            price: components["schemas"]["PositiveDecimal"];
            reference_price: components["schemas"]["PositiveDecimal"];
            stop_limit_price?: components["schemas"]["PositiveDecimal"];
            stop_loss: components["schemas"]["PositiveDecimal"];
            symbol: components["schemas"]["Symbol"];
            take_profit?: components["schemas"]["PositiveDecimal"];
            volume: components["schemas"]["PositiveDecimal"];
        };
        EconomicCalendarEvent: {
            actual: components["schemas"]["Decimal"] | null;
            consensus: components["schemas"]["Decimal"] | null;
            country: string;
            currency: string | null;
            id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            importance: "low" | "medium" | "high" | "unknown";
            period: string | null;
            previous: components["schemas"]["Decimal"] | null;
            provider_event_id: string | null;
            provider_updated_at: components["schemas"]["UtcDateTime"] | null;
            revised_previous: components["schemas"]["Decimal"] | null;
            revision: components["schemas"]["Revision"];
            scheduled_at: components["schemas"]["UtcDateTime"];
            /** @enum {string} */
            status: "scheduled" | "released" | "revised" | "delayed" | "cancelled";
            /** @enum {string} */
            time_precision: "exact" | "date_only" | "tentative";
            title: string;
            unit: string | null;
        };
        EconomicCalendarEventListResponse: {
            data: {
                has_more: boolean;
                items: components["schemas"]["EconomicCalendarEvent"][];
                next_cursor: string | null;
            };
            meta: components["schemas"]["Meta"];
        };
        EconomicCalendarEventResponse: {
            data: components["schemas"]["EconomicCalendarEvent"];
            meta: components["schemas"]["Meta"];
        };
        ExecutionCommand: components["schemas"]["MarketOrderCommand"] | components["schemas"]["PendingOrderCommand"] | components["schemas"]["ModifyPositionCommand"] | components["schemas"]["ClosePositionCommand"] | components["schemas"]["ModifyOrderCommand"] | components["schemas"]["CancelOrderCommand"];
        ExecutionCommandContext: {
            account_id: components["schemas"]["OpaqueId"];
            expected_state: components["schemas"]["ExecutionExpectedState"];
            instrument: {
                point: components["schemas"]["PositiveDecimal"];
                tick_size: components["schemas"]["PositiveDecimal"];
                tick_value: components["schemas"]["PositiveDecimal"];
                trade_enabled: boolean;
                volume_max: components["schemas"]["PositiveDecimal"];
                volume_min: components["schemas"]["PositiveDecimal"];
                volume_step: components["schemas"]["PositiveDecimal"];
            } | null;
            quote: {
                ask: components["schemas"]["PositiveDecimal"];
                bid: components["schemas"]["PositiveDecimal"];
                observed_at: components["schemas"]["UtcDateTime"];
            } | null;
            read_only: boolean;
            symbol: components["schemas"]["Symbol"];
            target_revision: components["schemas"]["ExecutionRevision"] | null;
            ticket: string | null;
            trade_permission: boolean;
        };
        ExecutionCommandContextResponse: {
            data: components["schemas"]["ExecutionCommandContext"];
            meta: components["schemas"]["Meta"];
        };
        ExecutionDistribution: {
            command: components["schemas"]["ExecutionDistributionCommand"];
            strategy_id: components["schemas"]["OpaqueId"];
        };
        ExecutionDistributionCommand: components["schemas"]["DistributionMarketOrderCommand"] | components["schemas"]["DistributionPendingOrderCommand"];
        ExecutionDistributionDetail: {
            command: {
                [key: string]: unknown;
            };
            completed_at: components["schemas"]["UtcDateTime"] | null;
            created_at: components["schemas"]["UtcDateTime"];
            id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            kind: "manual_order" | "close";
            operation_id: components["schemas"]["OpaqueId"];
            result_summary: {
                [key: string]: unknown;
            };
            revision: components["schemas"]["ExecutionRevision"];
            source_distribution_id: components["schemas"]["OpaqueId"] | null;
            /** @enum {string} */
            status: "accepted" | "queued" | "running" | "succeeded" | "partially_succeeded" | "rejected" | "failed" | "uncertain" | "cancelled" | "expired";
            strategy_id: components["schemas"]["OpaqueId"];
            strategy_version_id: components["schemas"]["OpaqueId"];
            target_count: number;
            targets: {
                account_id: components["schemas"]["OpaqueId"];
                child_operation_id: components["schemas"]["OpaqueId"] | null;
                error_code: string | null;
                id: components["schemas"]["OpaqueId"];
                revision: components["schemas"]["ExecutionRevision"];
                source_ticket: string | null;
                /** @enum {string} */
                status: "queued" | "running" | "succeeded" | "rejected" | "failed" | "uncertain" | "cancelled" | "expired";
                subscription_id: components["schemas"]["OpaqueId"];
            }[];
            updated_at: components["schemas"]["UtcDateTime"];
        };
        ExecutionDistributionDetailResponse: {
            data: components["schemas"]["ExecutionDistributionDetail"];
            meta: components["schemas"]["Meta"];
        };
        ExecutionDistributionPreview: {
            strategy_id: components["schemas"]["OpaqueId"];
            strategy_revision: components["schemas"]["ExecutionRevision"];
            strategy_version_id: components["schemas"]["OpaqueId"];
            symbol: components["schemas"]["Symbol"];
            target_count: number;
            targets: {
                account_id: components["schemas"]["OpaqueId"];
                missing_resources: ("account" | "positions" | "pending_orders" | "quote" | "contract" | "risk")[];
                ready: boolean;
                subscription_id: components["schemas"]["OpaqueId"];
                trade_permission: boolean;
            }[];
        };
        ExecutionDistributionPreviewResponse: {
            data: components["schemas"]["ExecutionDistributionPreview"];
            meta: components["schemas"]["Meta"];
        };
        ExecutionExpectedState: {
            account_revision: components["schemas"]["ExecutionRevision"];
            contract_revision: components["schemas"]["ExecutionRevision"];
            pending_orders_revision: components["schemas"]["ExecutionRevision"];
            positions_revision: components["schemas"]["ExecutionRevision"];
            quote_revision: components["schemas"]["ExecutionRevision"];
            risk_revision: components["schemas"]["ExecutionRevision"];
        };
        ExecutionResourceExpectedState: {
            account_revision: components["schemas"]["ExecutionRevision"];
            contract_revision: components["schemas"]["ExecutionRevision"];
            pending_orders_revision: components["schemas"]["ExecutionRevision"];
            positions_revision: components["schemas"]["ExecutionRevision"];
            quote_revision: components["schemas"]["ExecutionRevision"];
            resource_revision: components["schemas"]["ExecutionRevision"];
            risk_revision: components["schemas"]["ExecutionRevision"];
        };
        ExecutionRevision: string;
        FieldProblem: {
            code: string;
            field: string;
            message: string;
        };
        getArchivedExecutionResponse: {
            data: components["schemas"]["ArchivedExecutionDetail"];
            meta: components["schemas"]["Meta"];
        };
        getArchivedSignalResponse: {
            data: components["schemas"]["ArchivedSignalDetail"];
            meta: components["schemas"]["Meta"];
        };
        LearningCompletionRequest: {
            completed: boolean;
            /** @description Exact unsigned revision text, at most 18446744073709551614. */
            expected_revision: string;
        };
        LearningCompletionResponse: {
            data: {
                completed: boolean;
                lesson_id: string;
                replayed: boolean;
                revision: string;
                /** Format: date-time */
                updated_at: string;
            };
            meta: components["schemas"]["Meta"];
        };
        LearningCourse: {
            /** @enum {unknown} */
            access_level: "free" | "logged_in" | "plus_pro" | "pro_only" | null;
            category: string | null;
            description: string | null;
            id: string;
            sort_order: number;
            title: string;
            /** Format: date-time */
            updated_at: string | null;
        };
        LearningDetailResponse: {
            data: {
                /** @enum {unknown} */
                access: "allowed" | "login_required" | "membership_required";
                course: components["schemas"]["LearningCourse"];
                lessons: {
                    duration_ms: string | null;
                    id: string;
                    progress: {
                        completed: boolean | null;
                        reported_duration_ms: string | null;
                        revision: string;
                        /** Format: date-time */
                        updated_at: string | null;
                        watched_ms: string | null;
                    } | null;
                    resources: {
                        kind: string;
                        /** Format: uri */
                        url: string;
                    }[];
                    title: string;
                }[];
                lessons_truncated: boolean;
                viewer_user_id: string | null;
            } & unknown;
            meta: {
                /** Format: date-time */
                generated_at: string;
                request_id: string;
            };
        };
        LearningListResponse: {
            data: {
                items: components["schemas"]["LearningCourse"][];
                next_cursor: string | null;
            };
            meta: {
                /** Format: date-time */
                generated_at: string;
                request_id: string;
            };
        };
        LegacyBridgeCredentialExchange: {
            installation_id: components["schemas"]["BridgeDeviceId"];
            legacy_refresh_token: components["schemas"]["BridgeRefreshToken"];
            profile_id: components["schemas"]["BridgeDeviceId"];
            /** @constant */
            schema_version: 1;
            source_fingerprint: string;
        };
        LegacyReviewContent: {
            original_content_hash: string | null;
            raw_text: string;
            /** @constant */
            schema_version: "review.legacy.v1";
            source_id: string;
            source_sha256: string;
            /** @enum {string} */
            source_table: "period_review_versions" | "manual_trade_review_versions" | "trade_review_versions";
        };
        listArchivedExecutionsResponse: {
            data: {
                /** @enum {boolean} */
                executable: false;
                /** @enum {string} */
                identity_namespace: "retained-legacy";
                items: components["schemas"]["ArchivedExecutionSummary"][];
                next_cursor: string | null;
            };
            meta: components["schemas"]["Meta"];
        };
        listArchivedSignalsResponse: {
            data: {
                /** @enum {boolean} */
                executable: false;
                /** @enum {string} */
                identity_namespace: "retained-legacy";
                items: components["schemas"]["ArchivedSignalSummary"][];
                next_cursor: string | null;
            };
            meta: components["schemas"]["Meta"];
        };
        MacroFactor: {
            available_at: components["schemas"]["UtcDateTime"];
            code: string;
            /** @enum {string} */
            freshness: "fresh" | "stale" | "missing" | "disabled" | "invalid";
            /** @enum {string} */
            gold_relation: "supportive" | "adverse" | "neutral" | "uncertain";
            label: string;
            observation_at: components["schemas"]["UtcDateTime"];
            unit: string | null;
            value: components["schemas"]["Decimal"] | null;
        };
        MacroMarketOverviewResponse: {
            data: {
                high_impact_events: components["schemas"]["EconomicCalendarEvent"][];
                snapshot: components["schemas"]["MacroSnapshotSummary"] | null;
            };
            meta: components["schemas"]["Meta"];
        };
        MacroSeriesPoint: {
            available_at: components["schemas"]["UtcDateTime"];
            code: string;
            /** @enum {string} */
            freshness: "fresh" | "stale" | "missing" | "disabled" | "invalid";
            observation_at: components["schemas"]["UtcDateTime"];
            unit: string | null;
            value: components["schemas"]["Decimal"] | null;
        };
        MacroSeriesResponse: {
            data: {
                has_more: boolean;
                items: components["schemas"]["MacroSeriesPoint"][];
                next_cursor: string | null;
            };
            meta: components["schemas"]["Meta"];
        };
        MacroSnapshot: {
            business_date: components["schemas"]["BusinessDate"];
            content_sha256: string;
            data_cutoff_at: components["schemas"]["UtcDateTime"];
            /** @enum {string} */
            direction: "supportive" | "adverse" | "neutral" | "uncertain";
            factors: components["schemas"]["MacroFactor"][];
            /** @constant */
            horizon: "medium_term";
            id: components["schemas"]["OpaqueId"];
            published_at: components["schemas"]["UtcDateTime"];
            revision: components["schemas"]["Revision"];
            schema_version: number;
            /** @enum {string} */
            status: "fresh" | "stale" | "partial" | "unavailable";
            summary: string;
            valid_until: components["schemas"]["UtcDateTime"];
        };
        MacroSnapshotListResponse: {
            data: {
                has_more: boolean;
                items: components["schemas"]["MacroSnapshotSummary"][];
                next_cursor: string | null;
            };
            meta: components["schemas"]["Meta"];
        };
        MacroSnapshotResponse: {
            data: components["schemas"]["MacroSnapshot"];
            meta: components["schemas"]["Meta"];
        };
        MacroSnapshotSummary: {
            business_date: components["schemas"]["BusinessDate"];
            content_sha256: string;
            data_cutoff_at: components["schemas"]["UtcDateTime"];
            /** @enum {string} */
            direction: "supportive" | "adverse" | "neutral" | "uncertain";
            factor_count: number;
            /** @constant */
            horizon: "medium_term";
            id: components["schemas"]["OpaqueId"];
            published_at: components["schemas"]["UtcDateTime"];
            revision: components["schemas"]["Revision"];
            schema_version: number;
            /** @enum {string} */
            status: "fresh" | "stale" | "partial" | "unavailable";
            summary: string;
            valid_until: components["schemas"]["UtcDateTime"];
        };
        ManualReleaseAvailability: {
            available: boolean;
            code: string | null;
            expires_at: components["schemas"]["UtcDateTime"] | null;
            policy_set_revision: components["schemas"]["Revision"];
            risk_state_revision: components["schemas"]["Revision"] | null;
            rules: ("RISK_DAILY_LOSS_LIMIT" | "RISK_DRAWDOWN_LIMIT" | "RISK_DAILY_OPEN_LIMIT" | "RISK_CONSECUTIVE_LOSS_LIMIT" | "RISK_COOLDOWN_ACTIVE")[];
        };
        ManualReviewCandidate: {
            account_label: string;
            closed_at: components["schemas"]["UtcDateTime"];
            /** @enum {string} */
            eligibility_status: "eligible" | "incomplete" | "already_reviewed";
            id: components["schemas"]["OpaqueId"];
            net_profit: components["schemas"]["Decimal"];
            opened_at: components["schemas"]["UtcDateTime"];
            position_id: string | null;
            revision: components["schemas"]["Revision"];
            selection_expires_at: components["schemas"]["UtcDateTime"];
            selection_token: string;
            /** @enum {string} */
            side: "buy" | "sell";
            /** @enum {string} */
            source_classification: "manual" | "system" | "other_ea" | "unknown";
            symbol: string;
            terminal_timezone_offset_minutes: number;
            ticket: string;
            trading_account_id: components["schemas"]["OpaqueId"];
            volume: components["schemas"]["Decimal"];
        };
        ManualReviewCandidateListResponse: {
            data: {
                items: components["schemas"]["ManualReviewCandidate"][];
            };
            meta: components["schemas"]["Meta"];
        };
        ManualReviewCaseInput: {
            candidate_ids: components["schemas"]["OpaqueId"][];
            selection_tokens: string[];
            strategy_id: components["schemas"]["OpaqueId"];
            user_thesis?: string | null;
        };
        ManualRiskRelease: {
            account_id: components["schemas"]["OpaqueId"];
            account_policy_version_id: components["schemas"]["OpaqueId"] | null;
            baseline: components["schemas"]["ManualRiskReleaseBaseline"];
            created_at: components["schemas"]["UtcDateTime"];
            expires_at: components["schemas"]["UtcDateTime"];
            invalidated_at: components["schemas"]["UtcDateTime"] | null;
            invalidation_reason: string | null;
            manual_release_id: components["schemas"]["OpaqueId"];
            platform_policy_version_id: components["schemas"]["OpaqueId"];
            policy_set_revision: components["schemas"]["Revision"];
            reason: string;
            released_rules: ("RISK_DAILY_LOSS_LIMIT" | "RISK_DRAWDOWN_LIMIT" | "RISK_DAILY_OPEN_LIMIT" | "RISK_CONSECUTIVE_LOSS_LIMIT" | "RISK_COOLDOWN_ACTIVE")[];
            revision: components["schemas"]["Revision"];
            risk_state_revision: components["schemas"]["Revision"];
            /** @enum {string} */
            status: "active" | "superseded" | "expired" | "revoked";
        };
        ManualRiskReleaseBaseline: {
            business_date: string;
            consecutive_losses: number;
            cooldown_until: components["schemas"]["UtcDateTime"] | null;
            daily_loss_percent: components["schemas"]["Decimal"];
            daily_open_count: number;
            drawdown_percent: components["schemas"]["Decimal"];
        };
        ManualRiskReleaseCreatedResponse: {
            data: components["schemas"]["ManualRiskRelease"];
            meta: components["schemas"]["Meta"];
        };
        ManualRiskReleaseInput: {
            /** @constant */
            acknowledge_risk: true;
            reason: string;
        };
        ManualRiskReleaseReceiptResponse: {
            data: {
                release: null;
                /** @constant */
                state: "unconfirmed";
            } | {
                release: components["schemas"]["ManualRiskRelease"];
                /** @constant */
                state: "confirmed";
            };
            meta: components["schemas"]["Meta"];
        };
        ManualRiskReleaseResponse: {
            data: components["schemas"]["ManualRiskReleaseState"];
            meta: components["schemas"]["Meta"];
        };
        ManualRiskReleaseState: {
            availability: components["schemas"]["ManualReleaseAvailability"];
            release: components["schemas"]["ManualRiskRelease"] | null;
        };
        MarketAnalysisDetail: {
            analysis_body: string;
            bearish_score?: number | null;
            bullish_score?: number | null;
            chart?: {
                bars: {
                    close: number;
                    closed: boolean;
                    high: number;
                    low: number;
                    open: number;
                    time: string;
                }[];
                lines: {
                    end: number;
                    from: string;
                    kind: string;
                    start: number;
                    to: string;
                }[];
                timeframe: string;
            }[];
            counter_evidence: string[];
            data_gaps: string[];
            input_snapshot_hash: string;
            invalidation: {
                [key: string]: unknown;
            };
            key_levels: {
                [key: string]: unknown;
            };
            market_regime: string;
            summary: components["schemas"]["MarketAnalysisSummary"];
            supporting_evidence: string[];
        };
        MarketAnalysisDetailResponse: {
            data: components["schemas"]["MarketAnalysisDetail"];
            meta: components["schemas"]["Meta"];
        };
        MarketAnalysisListResponse: {
            data: {
                items: components["schemas"]["MarketAnalysisSummary"][];
                next_cursor: string | null;
            };
            meta: components["schemas"]["Meta"];
        };
        MarketAnalysisSummary: {
            analysis_id: components["schemas"]["OpaqueId"];
            analyzed_at: components["schemas"]["UtcDateTime"];
            confidence: number;
            /** @enum {string} */
            market_bias: "bullish" | "bearish" | "neutral" | "uncertain";
            /** @enum {string} */
            opportunity: "none" | "long_setup" | "short_setup";
            revision: components["schemas"]["Revision"];
            strategy_id: components["schemas"]["OpaqueId"];
            strategy_version_id: components["schemas"]["OpaqueId"];
            summary: string;
            symbol: components["schemas"]["Symbol"];
            valid_until: components["schemas"]["UtcDateTime"];
        };
        MarketOrderCommand: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            command_type: "market_order";
            expected_state: components["schemas"]["ExecutionExpectedState"];
            reference_price: components["schemas"]["PositiveDecimal"];
            /** @enum {string} */
            side: "buy" | "sell";
            stop_loss: components["schemas"]["PositiveDecimal"];
            symbol: components["schemas"]["Symbol"];
            take_profit?: components["schemas"]["PositiveDecimal"];
            volume: components["schemas"]["PositiveDecimal"];
        };
        Meta: {
            generated_at: components["schemas"]["UtcDateTime"];
            request_id: components["schemas"]["OpaqueId"];
        };
        ModelAssignmentsResponse: {
            data: {
                analysis: string | null;
                review: string | null;
                revision: string;
                trader: string | null;
            };
            meta: {
                generated_at: string;
                request_id: string;
            };
        };
        ModelConfiguration: {
            base_url: string;
            context_window_tokens?: number | null;
            has_key: boolean;
            id: string;
            max_input_tokens?: number | null;
            max_output_tokens?: number | null;
            max_tokens: number | null;
            name: string;
            /** @enum {string} */
            protocol: "chat_completions" | "responses";
            provider: string;
            /** @enum {string|null} */
            reasoning_effort?: null | "low" | "medium" | "high" | "max";
            request_timeout_ms?: number | null;
            revision: string;
            /** @enum {string} */
            scope: "user" | "platform";
            temperature?: number | null;
            thinking_enabled?: boolean;
            verified: boolean;
        };
        ModelConfigurationListResponse: {
            data: components["schemas"]["ModelConfiguration"][];
            meta: {
                generated_at: string;
                request_id: string;
            };
        };
        ModelConfigurationResponse: {
            data: components["schemas"]["ModelConfiguration"];
            meta: {
                generated_at: string;
                request_id: string;
            };
        };
        ModelDeletedResponse: {
            data: {
                deleted: boolean;
                id: string;
            };
            meta: {
                generated_at: string;
                request_id: string;
            };
        };
        ModelSelectionResponse: {
            data: {
                items: {
                    available: boolean;
                    id: string;
                    name: string;
                    reason: string | null;
                    /** @enum {unknown} */
                    scope: "user" | "platform";
                }[];
                selected_model_profile_id: string | null;
            };
            meta: components["schemas"]["Meta"];
        };
        ModifyOrderCommand: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            command_type: "modify_order";
            expected_state: components["schemas"]["ExecutionResourceExpectedState"];
            /** Format: int64 */
            expiration_utc_msc?: number;
            price?: components["schemas"]["PositiveDecimal"];
            /** @constant */
            remove_expiration?: true;
            /** @constant */
            remove_stop_loss?: true;
            /** @constant */
            remove_take_profit?: true;
            stop_limit_price?: components["schemas"]["PositiveDecimal"];
            stop_loss?: components["schemas"]["PositiveDecimal"];
            take_profit?: components["schemas"]["PositiveDecimal"];
            ticket: components["schemas"]["Ticket"];
        } | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown;
        ModifyPositionCommand: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            command_type: "modify_position";
            expected_state: components["schemas"]["ExecutionResourceExpectedState"];
            /** @constant */
            remove_stop_loss?: true;
            /** @constant */
            remove_take_profit?: true;
            stop_loss?: components["schemas"]["PositiveDecimal"];
            take_profit?: components["schemas"]["PositiveDecimal"];
            ticket: components["schemas"]["Ticket"];
        } | unknown | unknown | unknown | unknown;
        ObserverAccessAdminItem: {
            granted_at_utc: components["schemas"]["UtcDateTime"];
            granted_by_user_id: number | null;
            observer_channel_id: components["schemas"]["ObserverUnsignedId"];
            revision: string;
            revoked_at_utc: components["schemas"]["UtcDateTime"] | null;
            user_id: number;
        };
        ObserverAccessInput: {
            expected_revision: components["schemas"]["ObserverRevisionInput"];
            granted: boolean;
        };
        ObserverAccessPage: {
            items: components["schemas"]["ObserverAccessAdminItem"][];
            next_cursor: components["schemas"]["ObserverUnsignedId"] | null;
            registry_revision: string;
        };
        ObserverAccessPageResponse: {
            data: components["schemas"]["ObserverAccessPage"];
            meta: components["schemas"]["Meta"];
        };
        ObserverChannelAdminItem: {
            active: boolean;
            /** @enum {string} */
            audience: "all" | "plus" | "pro" | "assigned";
            created_at_utc: components["schemas"]["UtcDateTime"];
            description: string | null;
            display_name: string;
            id: components["schemas"]["ObserverUnsignedId"];
            is_default: boolean;
            revision: string;
            slug: string;
            sort_order: number;
            source_id: components["schemas"]["ObserverUnsignedId"] | null;
            source_trading_account_id: components["schemas"]["ObserverUnsignedId"] | null;
            updated_at_utc: components["schemas"]["UtcDateTime"] | null;
        };
        ObserverChannelCreateInput: {
            /**
             * @default false
             * @constant
             */
            active?: false;
            /**
             * @default assigned
             * @enum {string}
             */
            audience?: "all" | "plus" | "pro" | "assigned";
            /** @default null */
            description?: string | null;
            display_name: string;
            slug: string;
            /** @default 0 */
            sort_order?: number;
            /** @default null */
            source_id?: components["schemas"]["ObserverUnsignedId"] | null;
        };
        /** @description Authenticated active users only. Source/channel must be ready and aligned. Audience all, exact effective plus/pro plan, or an explicit active grant authorizes reading; pro does not inherit plus. This never grants trading rights. Observer HTTP reads return a sanitized publication, not operator metadata or private history. */
        ObserverChannelListResponse: {
            data: {
                items: {
                    active: boolean;
                    display_name: string;
                    id: components["schemas"]["OpaqueId"];
                    source_account_id: components["schemas"]["OpaqueId"];
                }[];
            };
            meta: components["schemas"]["Meta"];
        };
        ObserverChannelPage: {
            items: components["schemas"]["ObserverChannelAdminItem"][];
            next_cursor: components["schemas"]["ObserverUnsignedId"] | null;
            registry_revision: string;
        };
        ObserverChannelPageResponse: {
            data: components["schemas"]["ObserverChannelPage"];
            meta: components["schemas"]["Meta"];
        };
        ObserverChannelUpdateInput: {
            active: boolean;
            /** @enum {string} */
            audience: "all" | "plus" | "pro" | "assigned";
            description: string | null;
            display_name: string;
            expected_revision: components["schemas"]["ObserverRevisionInput"];
            slug: string;
            sort_order: number;
            source_id: components["schemas"]["ObserverUnsignedId"] | null;
        };
        ObserverDefaultChannelInput: {
            channel_id: components["schemas"]["ObserverUnsignedId"] | null;
            expected_revision: components["schemas"]["ObserverRevisionInput"];
        };
        ObserverManagementWriteResponse: {
            data: components["schemas"]["ObserverManagementWriteResult"];
            meta: components["schemas"]["Meta"];
        };
        ObserverManagementWriteResult: {
            /** Format: uuid */
            operation_id: string;
            registry_revision: string;
            revision: string;
            target_id: string;
        };
        ObserverOperationAdminItem: {
            action: string;
            actor_user_id: number;
            /** @description Canonical observer-management command; returned only from the admin-only operation endpoint. */
            audit_json: Record<string, never>;
            created_at_utc: components["schemas"]["UtcDateTime"];
            /** Format: uuid */
            id: string;
            result: components["schemas"]["ObserverManagementWriteResult"];
            target_id: string;
        };
        ObserverOperationPage: {
            items: components["schemas"]["ObserverOperationAdminItem"][];
            next_cursor: string | null;
            registry_revision: string;
        };
        ObserverOperationPageResponse: {
            data: components["schemas"]["ObserverOperationPage"];
            meta: components["schemas"]["Meta"];
        };
        /** @description A JSON integer or its decimal string representation. Updates require at least 1; access creation and registry CAS may use 0. */
        ObserverRevisionInput: number | string;
        ObserverSourceAdminItem: {
            analysis_strategy_id: components["schemas"]["ObserverUnsignedId"] | null;
            /** @enum {string} */
            configuration_status: "pending" | "ready";
            created_at_utc: components["schemas"]["UtcDateTime"];
            created_by_user_id: number;
            display_name: string;
            id: components["schemas"]["ObserverUnsignedId"];
            notes: string | null;
            operator_user_id: number;
            revision: string;
            /** @enum {string} */
            status: "active" | "disabled";
            trading_account_id: components["schemas"]["ObserverUnsignedId"] | null;
            updated_at_utc: components["schemas"]["UtcDateTime"];
        };
        ObserverSourceCreateInput: {
            /** @default null */
            analysis_strategy_id?: components["schemas"]["ObserverUnsignedId"] | null;
            display_name: string;
            /** @default null */
            notes?: string | null;
            /**
             * @default disabled
             * @constant
             */
            status?: "disabled";
            /** @default null */
            trading_account_id?: components["schemas"]["ObserverUnsignedId"] | null;
        };
        ObserverSourcePage: {
            items: components["schemas"]["ObserverSourceAdminItem"][];
            next_cursor: components["schemas"]["ObserverUnsignedId"] | null;
            registry_revision: string;
        };
        ObserverSourcePageResponse: {
            data: components["schemas"]["ObserverSourcePage"];
            meta: components["schemas"]["Meta"];
        };
        ObserverSourceUpdateInput: {
            analysis_strategy_id: components["schemas"]["ObserverUnsignedId"] | null;
            display_name: string;
            expected_revision: components["schemas"]["ObserverRevisionInput"];
            notes: string | null;
            /** @enum {string} */
            status: "active" | "disabled";
            trading_account_id: components["schemas"]["ObserverUnsignedId"] | null;
        };
        /** @description Positive decimal identifier bounded by the target unsigned BIGINT range (1..18446744073709551615). */
        ObserverUnsignedId: string;
        OpaqueId: string;
        Operation: {
            accepted_at: components["schemas"]["UtcDateTime"];
            completed_at?: components["schemas"]["UtcDateTime"] | null;
            distribution_id?: components["schemas"]["OpaqueId"] | null;
            error_code?: string | null;
            kind: string;
            operation_id: components["schemas"]["OpaqueId"];
            parent_operation_id?: components["schemas"]["OpaqueId"] | null;
            resource_id?: components["schemas"]["OpaqueId"] | null;
            result_summary?: {
                [key: string]: unknown;
            } | null;
            revision: components["schemas"]["Revision"];
            /** @enum {string} */
            status: "accepted" | "queued" | "running" | "succeeded" | "partially_succeeded" | "rejected" | "failed" | "uncertain" | "cancelled" | "expired";
            updated_at: components["schemas"]["UtcDateTime"];
        };
        OperationResponse: {
            data: components["schemas"]["Operation"];
            meta: components["schemas"]["Meta"];
        };
        PageMeta: {
            generated_at: components["schemas"]["UtcDateTime"];
            has_more: boolean;
            next_cursor: string | null;
            page_size: number;
            request_id: components["schemas"]["OpaqueId"];
        };
        PendingOrder: {
            account_id: components["schemas"]["OpaqueId"];
            created_at: components["schemas"]["UtcDateTime"];
            expires_at: components["schemas"]["UtcDateTime"] | null;
            price: components["schemas"]["Decimal"];
            revision: components["schemas"]["Revision"];
            signal_id: components["schemas"]["OpaqueId"] | null;
            /** @enum {string} */
            source: "manual" | "signal" | "unknown";
            stop_loss: components["schemas"]["Decimal"] | null;
            symbol: components["schemas"]["Symbol"];
            take_profit: components["schemas"]["Decimal"] | null;
            ticket: components["schemas"]["Ticket"];
            /** @enum {string} */
            type: "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop" | "buy_stop_limit" | "sell_stop_limit";
            volume: components["schemas"]["Decimal"];
        };
        PendingOrderCommand: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            command_type: "pending_order";
            expected_state: components["schemas"]["ExecutionExpectedState"];
            /** Format: int64 */
            expiration_utc_msc?: number;
            /** @enum {string} */
            order_type: "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop" | "buy_stop_limit" | "sell_stop_limit";
            price: components["schemas"]["PositiveDecimal"];
            reference_price: components["schemas"]["PositiveDecimal"];
            stop_limit_price?: components["schemas"]["PositiveDecimal"];
            stop_loss: components["schemas"]["PositiveDecimal"];
            symbol: components["schemas"]["Symbol"];
            take_profit?: components["schemas"]["PositiveDecimal"];
            volume: components["schemas"]["PositiveDecimal"];
        };
        Position: {
            account_id: components["schemas"]["OpaqueId"];
            current_price: components["schemas"]["Decimal"];
            floating_profit: components["schemas"]["Decimal"];
            open_price: components["schemas"]["Decimal"];
            opened_at: components["schemas"]["UtcDateTime"];
            revision: components["schemas"]["Revision"];
            /** @enum {string} */
            side: "buy" | "sell";
            signal_id?: components["schemas"]["OpaqueId"] | null;
            /** @enum {string} */
            source: "manual" | "signal" | "unknown";
            stop_loss: components["schemas"]["Decimal"] | null;
            symbol: components["schemas"]["Symbol"];
            take_profit: components["schemas"]["Decimal"] | null;
            ticket: components["schemas"]["Ticket"];
            volume: components["schemas"]["Decimal"];
        };
        PositionListResponse: {
            data: components["schemas"]["Position"][];
            meta: components["schemas"]["PageMeta"];
        };
        PositiveDecimal: string;
        Problem: {
            code: string;
            correlation_id: components["schemas"]["OpaqueId"];
            detail: string;
            errors?: components["schemas"]["FieldProblem"][];
            instance: string;
            retry_after_ms?: number;
            retryable: boolean;
            status: number;
            title: string;
            /** Format: uri-reference */
            type: string;
        };
        PublicMarketCandle: {
            close: components["schemas"]["Decimal"];
            closed: boolean;
            high: components["schemas"]["Decimal"];
            low: components["schemas"]["Decimal"];
            open: components["schemas"]["Decimal"];
            open_time: components["schemas"]["UtcDateTime"];
            revision: components["schemas"]["Revision"];
            tick_volume: components["schemas"]["Decimal"];
        };
        PublicMarketQuote: {
            ask: components["schemas"]["Decimal"];
            bid: components["schemas"]["Decimal"];
            last?: components["schemas"]["Decimal"] | null;
            observed_at: components["schemas"]["UtcDateTime"];
            revision: components["schemas"]["Revision"];
            spread: components["schemas"]["Decimal"];
        };
        PublicMarketSnapshotResponse: {
            data: {
                candles: components["schemas"]["PublicMarketCandle"][];
                quote: components["schemas"]["PublicMarketQuote"] | null;
                source_generation: components["schemas"]["Revision"] | null;
                source_key: string | null;
                /** @enum {string} */
                status: "cached" | "unavailable";
                structure: components["schemas"]["PublicMarketStructure"] | null;
                symbol: components["schemas"]["Symbol"];
                timeframe: components["schemas"]["Timeframe"];
            };
            meta: components["schemas"]["Meta"];
        };
        PublicMarketStructure: {
            /** @enum {string} */
            algorithm: "chan_structure_v8";
            based_on_closed_bars: number;
            lines: components["schemas"]["PublicMarketStructureLine"][];
            /** @enum {string} */
            reliability: "high" | "medium" | "low";
            status: string;
            trend?: {
                /** @enum {string} */
                confidence: "high" | "medium" | "low";
                /** @enum {string} */
                direction: "up" | "down" | "neutral";
                phase: string;
                reason: string;
                state: string;
            } | null;
        };
        PublicMarketStructureLine: {
            end: number;
            from: components["schemas"]["UtcDateTime"];
            /** @enum {string} */
            kind: "bi" | "segment" | "forming_segment" | "center" | "bi_center" | "fractal_top" | "fractal_bottom";
            start: number;
            to: components["schemas"]["UtcDateTime"];
        };
        PublicMarketSymbolsResponse: {
            data: {
                items: string[];
                market_states?: {
                    /** Format: date-time */
                    checked_at: string | null;
                    reason: string;
                    /** @enum {string} */
                    state: "open" | "closed" | "restricted" | "stale" | "unknown";
                    symbol: string;
                }[];
                timezone?: {
                    /** Format: date-time */
                    checked_at: string;
                    offset_minutes: number;
                    /** @enum {string} */
                    status: "calibrated" | "stale";
                } | null;
            };
            meta: components["schemas"]["Meta"];
        };
        Quote: {
            account_id: components["schemas"]["OpaqueId"];
            ask: components["schemas"]["Decimal"];
            bid: components["schemas"]["Decimal"];
            last?: components["schemas"]["Decimal"] | null;
            observed_at: components["schemas"]["UtcDateTime"];
            revision: components["schemas"]["Revision"];
            spread: components["schemas"]["Decimal"];
            symbol: components["schemas"]["Symbol"];
            /** @enum {string} */
            trade_mode?: "full" | "long_only" | "short_only" | "close_only" | "disabled" | "unknown";
        };
        QuoteResponse: {
            data: components["schemas"]["Quote"] | null;
            meta: components["schemas"]["Meta"];
        };
        RealtimeTicket: {
            capabilities: string[];
            expires_at: components["schemas"]["UtcDateTime"];
            /** @constant */
            protocol: "aurum.realtime.v4";
            ws_url: string;
        };
        RealtimeTicketResponse: {
            data: components["schemas"]["RealtimeTicket"];
            meta: components["schemas"]["Meta"];
        };
        ReviewCaseDetail: {
            current_job: {
                [key: string]: unknown;
            } | null;
            current_version: components["schemas"]["ReviewVersion"] | null;
            return_reason: string | null;
            sources: {
                [key: string]: unknown;
            }[];
            summary: components["schemas"]["ReviewCaseSummary"];
        };
        ReviewCaseDetailResponse: {
            data: components["schemas"]["ReviewCaseDetail"];
            meta: components["schemas"]["Meta"];
        };
        ReviewCaseListResponse: {
            data: {
                items: components["schemas"]["ReviewCaseSummary"][];
            };
            meta: components["schemas"]["Meta"];
        };
        ReviewCaseSummary: {
            account_label: string;
            analysis_strategy_id: components["schemas"]["OpaqueId"] | null;
            analysis_strategy_name: string | null;
            confirmed_version_id: components["schemas"]["OpaqueId"] | null;
            current_version_id: components["schemas"]["OpaqueId"] | null;
            evidence_hash: string | null;
            evidence_revision: components["schemas"]["Revision"];
            /** @enum {string} */
            evidence_status: "pending" | "incomplete" | "complete" | "stale";
            id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            kind: "daily" | "monthly" | "manual" | "trade";
            revision: components["schemas"]["Revision"];
            /** @enum {string} */
            status: "awaiting_evidence" | "queued" | "running" | "awaiting_confirmation" | "needs_changes" | "confirmed" | "failed" | "archived";
            subscription_id: components["schemas"]["OpaqueId"] | null;
            subscription_revision: components["schemas"]["Revision"] | null;
            symbol: string | null;
            terminal_period_end: components["schemas"]["UtcDateTime"];
            terminal_period_start: components["schemas"]["UtcDateTime"];
            terminal_timezone_offset_minutes: number;
            trader_strategy_id: components["schemas"]["OpaqueId"] | null;
            trader_strategy_name: string | null;
            trading_account_id: components["schemas"]["OpaqueId"];
            updated_at: components["schemas"]["UtcDateTime"];
            user_id: components["schemas"]["OpaqueId"];
        };
        ReviewContent: {
            /** @enum {string} */
            conclusion: "effective" | "mixed" | "ineffective" | "insufficient_evidence" | "manual_trade_reviewed";
            counterexamples: {
                [key: string]: unknown;
            }[];
            evidence_refs: components["schemas"]["OpaqueId"][];
            full_analysis_text: string;
            headline: string;
            memory_candidates: components["schemas"]["ReviewMemoryCandidate"][];
            metrics: {
                net_profit: components["schemas"]["Decimal"] | null;
                profit_factor: components["schemas"]["Decimal"] | null;
                trade_count: number;
                win_rate_percent: components["schemas"]["Decimal"] | null;
            };
            roles: {
                analyst: components["schemas"]["ReviewRoleResult"];
                execution: components["schemas"]["ReviewRoleResult"];
                risk: components["schemas"]["ReviewRoleResult"];
                trader: components["schemas"]["ReviewRoleResult"];
            };
            /** @constant */
            schema_version: "review.v4.1";
            summary: string;
            trade_episodes: {
                [key: string]: unknown;
            }[];
        };
        ReviewHistoricalMetadata: {
            review_case_id: string;
            source_evidence_status: string;
            source_id: string;
            source_status: string;
            source_strategy_id: string | null;
            source_strategy_version: string | null;
            source_table: string;
            /** @enum {string} */
            timezone_source: "legacy_evidence" | "legacy_case" | "default_utc_plus_3";
        };
        ReviewHistoricalMetadataResponse: {
            data: components["schemas"]["ReviewHistoricalMetadata"] | null;
            meta: components["schemas"]["Meta"];
        };
        ReviewMemoryCandidate: {
            content: string;
            evidence_refs: components["schemas"]["OpaqueId"][];
            memory_key: string;
            strategy_id: components["schemas"]["OpaqueId"];
            title: string;
            /** @enum {string} */
            update_kind: "short_term" | "long_term_candidate" | "monthly_summary" | "platform_candidate";
        };
        ReviewRoleResult: {
            /** @enum {string} */
            assessment: "effective" | "mixed" | "problem" | "insufficient_evidence" | "not_applicable";
            evidence_refs: components["schemas"]["OpaqueId"][];
            summary: string;
        };
        ReviewVersion: {
            /** @enum {string} */
            author_kind: "ai" | "user";
            /** @enum {string|null} */
            conclusion: "effective" | "mixed" | "ineffective" | "insufficient_evidence" | "manual_trade_reviewed" | null;
            content: components["schemas"]["ReviewContent"] | components["schemas"]["LegacyReviewContent"];
            created_at: components["schemas"]["UtcDateTime"];
            id: components["schemas"]["OpaqueId"];
            review_case_id: components["schemas"]["OpaqueId"];
            version: number;
        } & ({
            conclusion?: null;
            content?: components["schemas"]["LegacyReviewContent"];
        } | {
            conclusion?: string;
            content?: components["schemas"]["ReviewContent"];
        });
        ReviewVersionHistoryResponse: {
            data: {
                items: components["schemas"]["ReviewVersionSummary"][];
                next_before_version: number | null;
            };
            meta: components["schemas"]["Meta"];
        };
        ReviewVersionResponse: {
            data: components["schemas"]["ReviewVersion"];
            meta: components["schemas"]["Meta"];
        };
        ReviewVersionSummary: {
            /** @enum {string} */
            author_kind: "ai" | "user";
            /** @enum {string|null} */
            conclusion: "effective" | "mixed" | "ineffective" | "insufficient_evidence" | "manual_trade_reviewed" | null;
            created_at: components["schemas"]["UtcDateTime"];
            id: components["schemas"]["OpaqueId"];
            review_case_id: components["schemas"]["OpaqueId"];
            version: number;
        };
        Revision: string;
        RiskDecisionDetail: {
            approved_actions: {
                action_id: components["schemas"]["OpaqueId"];
                expected_state: {
                    [key: string]: unknown;
                };
                /** @enum {string} */
                kind: "market_order" | "pending_order" | "modify_position" | "close_position" | "modify_order" | "cancel_order";
                parameters: {
                    [key: string]: unknown;
                };
            }[];
            evaluated_at: components["schemas"]["UtcDateTime"];
            policy_hash: string;
            rules: {
                action_id: components["schemas"]["OpaqueId"] | null;
                code: string;
                details: {
                    [key: string]: unknown;
                };
                /** @enum {string} */
                outcome: "passed" | "rejected" | "not_applicable";
            }[];
            summary: components["schemas"]["RiskDecisionSummary"];
        };
        RiskDecisionDetailResponse: {
            data: components["schemas"]["RiskDecisionDetail"];
            meta: components["schemas"]["Meta"];
        };
        RiskDecisionListResponse: {
            data: {
                items: components["schemas"]["RiskDecisionSummary"][];
            };
            meta: components["schemas"]["Meta"];
        };
        RiskDecisionSummary: {
            account_id: components["schemas"]["OpaqueId"];
            account_policy_version_id: components["schemas"]["OpaqueId"] | null;
            account_risk_revision: components["schemas"]["Revision"];
            created_at: components["schemas"]["UtcDateTime"];
            manual_release_id: components["schemas"]["OpaqueId"] | null;
            platform_policy_version_id: components["schemas"]["OpaqueId"];
            reject_code: string | null;
            revision: components["schemas"]["Revision"];
            risk_decision_id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            status: "approved" | "rejected";
            trade_decision_id: components["schemas"]["OpaqueId"];
        };
        RiskPolicy: {
            account_id: components["schemas"]["OpaqueId"];
            account_kill_switch: boolean;
            account_policy_version_id: components["schemas"]["OpaqueId"] | null;
            readonly allowed_symbols: string[];
            consecutive_loss_limit: number;
            editable_fields: string[];
            /** @constant */
            readonly fail_closed_on_incomplete_data: true;
            readonly global_kill_switch: boolean;
            loss_cooldown_minutes: number;
            readonly manual_release_consecutive_loss_limit: number;
            readonly manual_release_enabled: boolean;
            readonly manual_release_max_daily_loss_percent: components["schemas"]["Decimal"];
            readonly manual_release_max_daily_open_count: number;
            readonly manual_release_max_drawdown_percent: components["schemas"]["Decimal"];
            max_daily_loss_percent: components["schemas"]["Decimal"];
            max_daily_open_count: number;
            readonly max_decision_age_seconds: number;
            max_drawdown_percent: components["schemas"]["Decimal"];
            max_open_positions: number;
            max_order_volume?: components["schemas"]["Decimal"];
            max_pending_orders: number;
            readonly max_price_deviation_percent: components["schemas"]["Decimal"];
            readonly max_quote_age_seconds: number;
            max_risk_per_trade_percent: components["schemas"]["Decimal"];
            readonly max_risk_summary_age_seconds: number;
            max_spread_points: components["schemas"]["Decimal"];
            max_total_volume: components["schemas"]["Decimal"];
            min_open_interval_seconds: number;
            numeric_controls?: {
                [key: string]: {
                    allowed_max: components["schemas"]["Decimal"];
                    allowed_min: components["schemas"]["Decimal"];
                    locked_value: components["schemas"]["Decimal"] | null;
                    user_editable: boolean;
                };
            };
            /** @description System-only pending-order price tolerance in ATR units. Optional for older V4 responses; not an account-editable field. */
            pending_dedup_atr_multiplier?: string;
            pending_valid_minutes: number;
            platform_policy_version_id: components["schemas"]["OpaqueId"];
            /** @constant */
            require_stop_loss: true;
            revision: components["schemas"]["Revision"];
            trade_send_enabled: boolean;
            updated_at: components["schemas"]["UtcDateTime"];
            weekend_close_minutes: number;
        };
        RiskPolicyInput: {
            account_kill_switch?: boolean;
            consecutive_loss_limit?: number;
            loss_cooldown_minutes?: number;
            max_daily_loss_percent?: components["schemas"]["Decimal"];
            max_daily_open_count?: number;
            max_drawdown_percent?: components["schemas"]["Decimal"];
            max_open_positions?: number;
            max_order_volume?: components["schemas"]["Decimal"];
            max_pending_orders?: number;
            max_risk_per_trade_percent?: components["schemas"]["Decimal"];
            max_spread_points?: components["schemas"]["Decimal"];
            max_total_volume?: components["schemas"]["Decimal"];
            min_open_interval_seconds?: number;
            pending_valid_minutes?: number;
            reason: string;
            trade_send_enabled?: boolean;
            weekend_close_minutes?: number;
        };
        RiskPolicyReceiptResponse: {
            data: {
                policy: null;
                /** @constant */
                state: "unconfirmed";
            } | {
                policy: components["schemas"]["RiskPolicy"];
                /** @constant */
                state: "confirmed";
            };
            meta: components["schemas"]["Meta"];
        };
        RiskPolicyResponse: {
            data: components["schemas"]["RiskPolicy"];
            meta: components["schemas"]["Meta"];
        };
        Session: {
            /** @enum {string} */
            app: "www" | "trade" | "admin";
            authenticated_at: components["schemas"]["UtcDateTime"];
            csrf_token: string;
            /** @enum {string} */
            mfa_level: "none" | "otp" | "strong";
            permissions: string[];
            user: {
                /** Format: uri-reference */
                avatar_url: string | null;
                display_name: string;
                id: components["schemas"]["OpaqueId"];
            };
        };
        SessionResponse: {
            data: components["schemas"]["Session"];
            meta: components["schemas"]["Meta"];
        };
        StrategyCombinationCreate: {
            analysis_config: {
                [key: string]: unknown;
            };
            analysis_prompt_text: string;
            description: string;
            name: string;
            trader_config: {
                [key: string]: unknown;
            };
            trader_prompt_text: string;
        };
        StrategyCombinationVersionCreate: {
            analysis_config: {
                [key: string]: unknown;
            };
            analysis_prompt_text: string;
            description: string;
            name: string;
            /** @enum {string} */
            status: "draft" | "active";
            trader_config: {
                [key: string]: unknown;
            };
            trader_expected_revision: number | null;
            trader_prompt_text: string;
        };
        StrategyCompile: {
            config: {
                [key: string]: unknown;
            };
            /** @enum {string} */
            kind: "analysis" | "trader";
            prompt_text: string;
        };
        StrategyCompileIssue: {
            code: string;
            /** @enum {string} */
            level: "error" | "warning";
            message: string;
            path: string | null;
        };
        StrategyCompileResponse: {
            data: components["schemas"]["StrategyCompileResult"];
            meta: components["schemas"]["Meta"];
        };
        StrategyCompileResult: {
            input_contract_version: string;
            issues: components["schemas"]["StrategyCompileIssue"][];
            /** @enum {string} */
            kind: "analysis" | "trader";
            normalized_config: {
                [key: string]: unknown;
            };
            output_contract_version: string;
            prompt_hash: string;
            valid: boolean;
        };
        StrategyCreate: {
            config: {
                [key: string]: unknown;
            };
            description: string;
            /** @enum {string} */
            kind: "analysis" | "trader";
            name: string;
            prompt_text: string;
        };
        StrategyDetail: {
            active_version_id: components["schemas"]["OpaqueId"] | null;
            description: string;
            id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            kind: "analysis" | "trader";
            name: string;
            owner_user_id: components["schemas"]["OpaqueId"] | null;
            paired_trader_strategy: components["schemas"]["StrategyPairedTrader"] | null;
            performance: components["schemas"]["StrategyPerformance"];
            revision: components["schemas"]["Revision"];
            /** @enum {string} */
            scope: "platform" | "user";
            /** @enum {string} */
            status: "draft" | "active" | "retired";
            versions: components["schemas"]["StrategyVersion"][];
        };
        StrategyDetailResponse: {
            data: components["schemas"]["StrategyDetail"];
            meta: components["schemas"]["Meta"];
        };
        StrategyListResponse: {
            data: {
                items: components["schemas"]["StrategySummary"][];
            };
            meta: components["schemas"]["Meta"];
        };
        StrategyMemoryConflict: {
            memory_key: string;
            prior_update_id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            type: "same_key_content_changed";
        };
        StrategyMemoryDetailResponse: {
            data: components["schemas"]["StrategyMemoryFields"] & {
                content_hash: string | null;
                content_text: string;
                current_revision_id: string | null;
                max_context_tokens: number;
            };
            meta: components["schemas"]["Meta"];
        };
        StrategyMemoryFields: {
            current_version: number;
            id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            mode: "off" | "shadow" | "active";
            owner_user_id: components["schemas"]["OpaqueId"] | null;
            pending_count: number;
            revision: components["schemas"]["Revision"];
            /** @enum {string} */
            status: "active" | "revalidating" | "retired";
            strategy_id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            strategy_kind: "analysis" | "trader";
            strategy_name: string;
            updated_at: components["schemas"]["UtcDateTime"];
        };
        StrategyMemoryListResponse: {
            data: {
                items: components["schemas"]["StrategyMemorySummary"][];
            };
            meta: components["schemas"]["Meta"];
        };
        StrategyMemoryProposal: {
            content: string;
            evidence_refs: string[];
            memory_key: string;
            title: string;
        };
        StrategyMemorySummary: components["schemas"]["StrategyMemoryFields"];
        StrategyMemoryUpdate: {
            conflicts: components["schemas"]["StrategyMemoryConflict"][];
            created_at: components["schemas"]["UtcDateTime"];
            diff_preview_text: string;
            expected_library_revision: components["schemas"]["Revision"];
            id: components["schemas"]["OpaqueId"];
            library_id: components["schemas"]["OpaqueId"];
            proposal: components["schemas"]["StrategyMemoryProposal"];
            revision: components["schemas"]["Revision"];
            source_review_case_id: components["schemas"]["OpaqueId"];
            source_review_version_id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            status: "collecting_evidence" | "awaiting_confirmation" | "accepted" | "rejected" | "merged" | "superseded";
            /** @enum {string} */
            update_kind: "short_term" | "long_term_candidate" | "monthly_summary" | "platform_candidate";
        };
        StrategyMemoryUpdateListResponse: {
            data: {
                items: components["schemas"]["StrategyMemoryUpdate"][];
            };
            meta: components["schemas"]["Meta"];
        };
        StrategyMemoryUpdateResponse: {
            data: components["schemas"]["StrategyMemoryUpdate"];
            meta: components["schemas"]["Meta"];
        };
        StrategyMetadataPatch: {
            description: string;
            name: string;
        };
        StrategyPairedTrader: {
            active_version_id: components["schemas"]["OpaqueId"] | null;
            id: components["schemas"]["OpaqueId"];
            name: string;
            /** @enum {string} */
            status: "draft" | "active" | "retired";
        };
        StrategyPerformance: {
            currencies: string[];
            currency: string | null;
            max_drawdown: components["schemas"]["Decimal"] | null;
            max_drawdown_percent: components["schemas"]["Decimal"] | null;
            net_profit: components["schemas"]["Decimal"] | null;
            period_end: components["schemas"]["UtcDateTime"] | null;
            period_start: components["schemas"]["UtcDateTime"] | null;
            profit_factor: components["schemas"]["Decimal"] | null;
            return_percent: components["schemas"]["Decimal"] | null;
            /** @enum {string} */
            status: "available" | "insufficient" | "mixed_currency";
            trade_count: number;
            win_rate_percent: components["schemas"]["Decimal"] | null;
        };
        StrategySubscription: {
            analysis_enabled: boolean;
            analysis_strategy_id: components["schemas"]["OpaqueId"];
            analysis_strategy_version_id: components["schemas"]["OpaqueId"];
            created_at: components["schemas"]["UtcDateTime"];
            id: components["schemas"]["OpaqueId"];
            revision: components["schemas"]["Revision"];
            schedule: components["schemas"]["StrategySubscriptionSchedule"];
            /** @enum {string} */
            status: "active" | "paused" | "ended";
            symbol: components["schemas"]["Symbol"];
            trade_send_enabled: boolean;
            trader_enabled: boolean;
            trader_strategy_id: components["schemas"]["OpaqueId"] | null;
            trader_strategy_version_id: components["schemas"]["OpaqueId"] | null;
            trading_account_id: components["schemas"]["OpaqueId"];
            updated_at: components["schemas"]["UtcDateTime"];
            user_id: components["schemas"]["OpaqueId"];
        };
        StrategySubscriptionCreate: {
            /** @default true */
            analysis_enabled?: boolean;
            analysis_strategy_id: components["schemas"]["OpaqueId"];
            receive_window?: {
                /** @constant */
                enabled: false;
            } | {
                enabled: boolean;
                /** @enum {string} */
                outsideBehavior: "pause_all" | "signals_only";
                /** @constant */
                timezone: "terminal_server";
                /** @constant */
                version: 1;
                weekdays: number[];
                windows: {
                    end: string;
                    start: string;
                }[];
            };
            /**
             * @default active
             * @enum {string}
             */
            status?: "active" | "paused";
            symbol: components["schemas"]["Symbol"];
            /** @default false */
            trade_send_enabled?: boolean;
            /** @default false */
            trader_enabled?: boolean;
            trader_strategy_id?: components["schemas"]["OpaqueId"] | null;
            trading_account_id: components["schemas"]["OpaqueId"];
        };
        StrategySubscriptionListResponse: {
            data: {
                items: components["schemas"]["StrategySubscription"][];
            };
            meta: components["schemas"]["Meta"];
        };
        StrategySubscriptionPatch: {
            analysis_enabled?: boolean;
            analysis_strategy_id?: components["schemas"]["OpaqueId"];
            receive_window?: {
                /** @constant */
                enabled: false;
            } | {
                enabled: boolean;
                /** @enum {string} */
                outsideBehavior: "pause_all" | "signals_only";
                /** @constant */
                timezone: "terminal_server";
                /** @constant */
                version: 1;
                weekdays: number[];
                windows: {
                    end: string;
                    start: string;
                }[];
            };
            /** @enum {string} */
            status?: "active" | "paused" | "ended";
            symbol?: components["schemas"]["Symbol"];
            trade_send_enabled?: boolean;
            trader_enabled?: boolean;
            trader_strategy_id?: components["schemas"]["OpaqueId"] | null;
        };
        StrategySubscriptionResponse: {
            data: components["schemas"]["StrategySubscription"];
            meta: components["schemas"]["Meta"];
        };
        StrategySubscriptionSchedule: {
            cadence_seconds: number;
            next_due_at: components["schemas"]["UtcDateTime"] | null;
            receive_timezone: string;
            receive_window: {
                [key: string]: unknown;
            };
            revision: components["schemas"]["Revision"];
        };
        StrategySummary: {
            active_version_id: components["schemas"]["OpaqueId"] | null;
            description: string;
            id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            kind: "analysis" | "trader";
            name: string;
            owner_user_id: components["schemas"]["OpaqueId"] | null;
            paired_trader_strategy: components["schemas"]["StrategyPairedTrader"] | null;
            revision: components["schemas"]["Revision"];
            /** @enum {string} */
            scope: "platform" | "user";
            /** @enum {string} */
            status: "draft" | "active" | "retired";
        };
        StrategyVersion: {
            config: {
                [key: string]: unknown;
            };
            created_at: components["schemas"]["UtcDateTime"];
            created_by_user_id: components["schemas"]["OpaqueId"];
            id: components["schemas"]["OpaqueId"];
            input_contract_version: string;
            /** @enum {string} */
            kind: "analysis" | "trader";
            output_contract_version: string;
            prompt_hash: string;
            prompt_text: string;
            strategy_id: components["schemas"]["OpaqueId"];
            version: number;
        };
        StrategyVersionCreate: {
            config: {
                [key: string]: unknown;
            };
            description?: string;
            name?: string;
            prompt_text: string;
            /** @enum {string} */
            status?: "draft" | "active";
        };
        Symbol: string;
        TerminalMarketSymbol: {
            currency_base: string | null;
            currency_profit: string | null;
            description: string;
            selected: boolean;
            symbol: string;
            trade_mode: number | null;
            visible: boolean;
        };
        TerminalMarketSymbolsResponse: {
            data: {
                items: components["schemas"]["TerminalMarketSymbol"][];
                next_cursor: string | null;
                /** Format: date-time */
                observed_at: string;
            };
            meta: components["schemas"]["Meta"];
        };
        TerminalMarketWindowResponse: {
            data: {
                before: string;
                items: components["schemas"]["Candle"][];
                structure: components["schemas"]["PublicMarketStructure"] | null;
            };
            meta: components["schemas"]["Meta"];
        };
        TerminalProfileListResponse: {
            data: {
                items: {
                    account_id: components["schemas"]["OpaqueId"] | null;
                    /** @enum {string} */
                    connection_state: "online" | "offline" | "paused";
                    display_name: string;
                    id: components["schemas"]["OpaqueId"];
                    installation_id: components["schemas"]["OpaqueId"];
                    last_seen_at: components["schemas"]["UtcDateTime"] | null;
                    /** @enum {string} */
                    platform: "mt4" | "mt5";
                }[];
            };
            meta: components["schemas"]["Meta"];
        };
        Ticket: string;
        /** @enum {string} */
        Timeframe: "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";
        TradeDecisionDetail: {
            actions: {
                action_id: components["schemas"]["OpaqueId"];
                expected_state: {
                    [key: string]: unknown;
                };
                /** @enum {string} */
                kind: "market_order" | "pending_order" | "modify_position" | "close_position" | "modify_order" | "cancel_order";
                parameters: {
                    [key: string]: unknown;
                };
            }[];
            input_snapshot_hash: string;
            reasoning: string;
            summary: components["schemas"]["TradeDecisionSummary"];
        };
        TradeDecisionDetailResponse: {
            data: components["schemas"]["TradeDecisionDetail"];
            meta: components["schemas"]["Meta"];
        };
        TradeDecisionListResponse: {
            data: {
                items: components["schemas"]["TradeDecisionSummary"][];
            };
            meta: components["schemas"]["Meta"];
        };
        TradeDecisionSummary: {
            /** @enum {string} */
            action: "hold" | "market_order" | "pending_order" | "modify_position" | "close_position" | "modify_order" | "cancel_order";
            analysis_id: components["schemas"]["OpaqueId"];
            confidence: number;
            created_at: components["schemas"]["UtcDateTime"];
            decision_id: components["schemas"]["OpaqueId"];
            revision: components["schemas"]["Revision"];
            /** @enum {string|null} */
            side: "buy" | "sell" | null;
            stale_reason: string | null;
            /** @enum {string} */
            status: "proposed" | "stale" | "risk_rejected" | "accepted";
            strategy_id: components["schemas"]["OpaqueId"];
            strategy_version_id: components["schemas"]["OpaqueId"];
            summary: string;
            trading_account_id: components["schemas"]["OpaqueId"];
        };
        TradeHistoryPageResponse: {
            data: {
                captured_end: components["schemas"]["UtcDateTime"];
                daily: {
                    business_date: components["schemas"]["BusinessDate"];
                    cumulative_net_profit: components["schemas"]["Decimal"] | null;
                    net_profit: components["schemas"]["Decimal"] | null;
                    trade_count: number;
                }[];
                freshness: {
                    fresh_through: components["schemas"]["UtcDateTime"] | null;
                    history_revision: components["schemas"]["Revision"];
                    last_success_at: components["schemas"]["UtcDateTime"] | null;
                    /** @enum {string} */
                    status: "empty" | "syncing" | "ready" | "stale" | "failed";
                };
                has_more: boolean;
                items: components["schemas"]["TradeHistoryRecord"][];
                next_cursor: string | null;
                summary: components["schemas"]["TradeHistorySummary"];
            };
            meta: components["schemas"]["Meta"];
        };
        TradeHistoryRecord: components["schemas"]["TradeHistoryRecordFields"];
        TradeHistoryRecordFields: {
            account_currency: string | null;
            account_id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            attribution_status: "exact" | "partial" | "conflicted" | "unresolved";
            closed_at: components["schemas"]["UtcDateTime"] | null;
            commission: components["schemas"]["Decimal"];
            /** @enum {string} */
            currency_evidence: "unknown" | "explicit_record";
            entry_price: components["schemas"]["Decimal"];
            /** @enum {string} */
            evidence_status: "complete" | "partial" | "conflicted";
            exit_price: components["schemas"]["Decimal"] | null;
            fee: components["schemas"]["Decimal"];
            gross_profit: components["schemas"]["Decimal"];
            id: components["schemas"]["OpaqueId"];
            net_profit: components["schemas"]["Decimal"];
            opened_at: components["schemas"]["UtcDateTime"];
            /** @enum {string} */
            platform: "mt4" | "mt5";
            position_id: string | null;
            primary_ticket: string;
            revision: components["schemas"]["Revision"];
            /** @enum {string} */
            side: "buy" | "sell";
            /** @enum {string} */
            source: "system" | "manual" | "other_ea" | "mixed" | "unknown";
            /** @enum {string} */
            status: "open" | "closed" | "partial" | "unknown";
            stop_loss: components["schemas"]["Decimal"] | null;
            swap: components["schemas"]["Decimal"];
            symbol: components["schemas"]["Symbol"];
            take_profit: components["schemas"]["Decimal"] | null;
            terminal_timezone_offset_minutes: number;
            volume: components["schemas"]["Decimal"];
        };
        TradeHistorySummary: {
            account_currency: string | null;
            breakeven_count: number;
            commission: components["schemas"]["Decimal"] | null;
            fee: components["schemas"]["Decimal"] | null;
            gross_profit: components["schemas"]["Decimal"] | null;
            losing_count: number;
            /** @enum {string} */
            money_status: "comparable" | "unknown" | "mixed" | "empty";
            net_profit: components["schemas"]["Decimal"] | null;
            profit_factor: components["schemas"]["Decimal"] | null;
            swap: components["schemas"]["Decimal"] | null;
            trade_count: number;
            win_rate_percent: components["schemas"]["Decimal"] | null;
            winning_count: number;
        } & (unknown & unknown);
        TradeRecordAttribution: {
            /** @enum {string} */
            kind: "market_analysis" | "trade_decision" | "risk_decision" | "execution_intent" | "execution_outcome" | "bridge_command" | "review_case";
            /** @enum {string} */
            proof_kind: "terminal_ticket" | "terminal_order" | "terminal_deal" | "distribution_target" | "legacy_mapping";
            /** @enum {string} */
            relation: "opened" | "modified" | "closed" | "cancelled" | "reviewed" | "related";
            source_id: components["schemas"]["OpaqueId"];
        };
        TradeRecordDeal: {
            account_currency: string | null;
            commission: components["schemas"]["Decimal"];
            /** @enum {string} */
            currency_evidence: "unknown" | "explicit_record";
            deal_ticket: string;
            /** @enum {string} */
            entry_kind: "in" | "out" | "inout" | "out_by" | "none" | "unknown";
            fee: components["schemas"]["Decimal"];
            gross_profit: components["schemas"]["Decimal"];
            id: components["schemas"]["OpaqueId"];
            occurred_at: components["schemas"]["UtcDateTime"];
            order_ticket: string | null;
            price: components["schemas"]["Decimal"] | null;
            /** @enum {string} */
            role: "entry" | "exit" | "fee" | "adjustment" | "unknown";
            /** @enum {string} */
            side: "buy" | "sell" | "none" | "unknown";
            swap: components["schemas"]["Decimal"];
            volume: components["schemas"]["Decimal"] | null;
        };
        TradeRecordDetailResponse: {
            data: components["schemas"]["TradeHistoryRecordFields"] & {
                attributions: components["schemas"]["TradeRecordAttribution"][];
                deals: components["schemas"]["TradeRecordDeal"][];
                evidence_hash: string;
            };
            meta: components["schemas"]["Meta"];
        };
        TraderEvaluationCreate: {
            subscription_id: components["schemas"]["OpaqueId"];
            subscription_revision: components["schemas"]["Revision"];
            trader_strategy_id: components["schemas"]["OpaqueId"];
            trader_strategy_version_id: components["schemas"]["OpaqueId"];
            trading_account_id: components["schemas"]["OpaqueId"];
        };
        TraderRun: {
            analysis_id: components["schemas"]["OpaqueId"];
            created_at: components["schemas"]["UtcDateTime"];
            revision: components["schemas"]["Revision"];
            /** @enum {string} */
            status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
            strategy_id: components["schemas"]["OpaqueId"];
            strategy_version_id: components["schemas"]["OpaqueId"];
            /** @enum {string} */
            task_mode: "entry" | "manage" | "both";
            trader_run_id: components["schemas"]["OpaqueId"];
            trading_account_id: components["schemas"]["OpaqueId"];
            updated_at: components["schemas"]["UtcDateTime"];
        };
        TraderRunResponse: {
            data: components["schemas"]["TraderRun"];
            meta: components["schemas"]["Meta"];
        };
        TradingAccount: {
            /** @enum {string} */
            bridge_state: "online" | "offline" | "paused" | "replaced" | "unauthorized";
            currency: string;
            id: components["schemas"]["OpaqueId"];
            last_seen_at: components["schemas"]["UtcDateTime"] | null;
            login: string;
            /** @enum {string} */
            platform: "mt4" | "mt5";
            server: string;
            terminal_instance_id: components["schemas"]["OpaqueId"] | null;
            terminal_profile_id: components["schemas"]["OpaqueId"] | null;
            trade_permission: boolean;
        };
        TradingAccountListResponse: {
            data: {
                items: components["schemas"]["TradingAccount"][];
            };
            meta: components["schemas"]["Meta"];
        };
        TradingContext: {
            account_id: components["schemas"]["OpaqueId"] | null;
            /** @enum {string} */
            mode: "full" | "observer" | "blocked";
            observer_channel_id: components["schemas"]["OpaqueId"] | null;
            read_only: boolean;
            revision: components["schemas"]["Revision"];
            user_id: components["schemas"]["OpaqueId"];
        };
        TradingContextInput: {
            account_id?: components["schemas"]["OpaqueId"] | null;
            expected_revision: string;
            /** @enum {string} */
            mode: "full" | "observer";
            observer_channel_id?: components["schemas"]["OpaqueId"] | null;
        } & ({
            account_id: components["schemas"]["OpaqueId"];
            /** @constant */
            mode?: "full";
            observer_channel_id?: null;
        } | {
            account_id?: null;
            /** @constant */
            mode?: "observer";
            observer_channel_id: components["schemas"]["OpaqueId"];
        });
        TradingContextReceipt: {
            /** @enum {string} */
            action: "select_account" | "enter_observer" | "leave_observer";
            prior_revision: components["schemas"]["Revision"];
            recorded_at: components["schemas"]["UtcDateTime"];
            replayed: boolean;
            request_id: string;
            result: components["schemas"]["TradingContext"];
            target_id: components["schemas"]["OpaqueId"] | null;
        };
        TradingContextReceiptResponse: {
            data: components["schemas"]["TradingContextReceipt"] | null;
            meta: components["schemas"]["Meta"];
        };
        TradingContextResponse: {
            data: components["schemas"]["TradingContext"];
            meta: components["schemas"]["Meta"];
        };
        TradingWorkspaceResponse: {
            data: {
                account: components["schemas"]["TradingAccount"];
                pending_orders: {
                    items: components["schemas"]["PendingOrder"][];
                    revision: components["schemas"]["Revision"];
                };
                positions: {
                    items: components["schemas"]["Position"][];
                    revision: components["schemas"]["Revision"];
                };
                snapshot: components["schemas"]["AccountSnapshot"] | null;
                symbols: components["schemas"]["Symbol"][];
            };
            meta: components["schemas"]["Meta"];
        };
        /** Format: date-time */
        UtcDateTime: string;
    };
    responses: {
        /** @description Identity center problem details. Current transport uses application/json. Codes include auth_session_required, auth_session_invalid, auth_csrf_invalid, auth_host_invalid and auth_service_unavailable. */
        AuthCenterProblem: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Problem"];
            };
        };
        /** @description Problem details */
        Problem: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        AccountId: components["schemas"]["OpaqueId"];
        AccountIdQuery: components["schemas"]["OpaqueId"];
        AnalysisId: components["schemas"]["OpaqueId"];
        CandlePageSize: number;
        CsrfToken: string;
        Cursor: string | null;
        DecisionId: components["schemas"]["OpaqueId"];
        DistributionId: components["schemas"]["OpaqueId"];
        ExpectedRevisionQuery: components["schemas"]["Revision"];
        IdempotencyKey: string;
        IfMatch: string;
        MemoryId: components["schemas"]["OpaqueId"];
        MemoryUpdateId: components["schemas"]["OpaqueId"];
        /** @description Stable positive decimal ID cursor for source, channel or access pages. */
        ObserverAdminCursor: string;
        ObserverAdminIdempotencyKey: string;
        ObserverAdminLimit: number;
        ObserverChannelId: string;
        /** @description Authorized observer channel required when reading an account the current user does not own. */
        ObserverChannelIdQuery: components["schemas"]["OpaqueId"];
        /** @description Stable UUID cursor for operation pages. */
        ObserverOperationCursor: string;
        ObserverSourceId: string;
        ObserverUserId: string;
        OperationId: components["schemas"]["OpaqueId"];
        PageSize: number;
        ReviewCaseId: components["schemas"]["OpaqueId"];
        Symbol: components["schemas"]["Symbol"];
        SymbolQuery: components["schemas"]["Symbol"];
        SymbolQueryOptional: components["schemas"]["Symbol"];
        Ticket: components["schemas"]["Ticket"];
        Timeframe: components["schemas"]["Timeframe"];
    };
    requestBodies: never;
    headers: {
        /** @description Opaque resource revision as an HTTP entity tag */
        ETag: string;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listObserverChannelsForAdmin: {
        parameters: {
            query?: {
                /** @description Stable positive decimal ID cursor for source, channel or access pages. */
                cursor?: components["parameters"]["ObserverAdminCursor"];
                limit?: components["parameters"]["ObserverAdminLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Observer channel page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverChannelPageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createObserverChannel: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["ObserverAdminIdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ObserverChannelCreateInput"];
            };
        };
        responses: {
            /** @description Observer channel operation receipt */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverManagementWriteResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    updateObserverChannel: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["ObserverAdminIdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                channel_id: components["parameters"]["ObserverChannelId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ObserverChannelUpdateInput"];
            };
        };
        responses: {
            /** @description Observer channel operation receipt */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverManagementWriteResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listObserverChannelAccesses: {
        parameters: {
            query?: {
                /** @description Stable positive decimal ID cursor for source, channel or access pages. */
                cursor?: components["parameters"]["ObserverAdminCursor"];
                limit?: components["parameters"]["ObserverAdminLimit"];
            };
            header?: never;
            path: {
                channel_id: components["parameters"]["ObserverChannelId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Observer access page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverAccessPageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    setObserverChannelAccess: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["ObserverAdminIdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                channel_id: components["parameters"]["ObserverChannelId"];
                user_id: components["parameters"]["ObserverUserId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ObserverAccessInput"];
            };
        };
        responses: {
            /** @description Observer access operation receipt */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverManagementWriteResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    setObserverDefaultChannel: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["ObserverAdminIdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ObserverDefaultChannelInput"];
            };
        };
        responses: {
            /** @description Observer default operation receipt */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverManagementWriteResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listObserverManagementOperations: {
        parameters: {
            query?: {
                /** @description Stable UUID cursor for operation pages. */
                cursor?: components["parameters"]["ObserverOperationCursor"];
                limit?: components["parameters"]["ObserverAdminLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Observer operation page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverOperationPageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listObserverSourcesForAdmin: {
        parameters: {
            query?: {
                /** @description Stable positive decimal ID cursor for source, channel or access pages. */
                cursor?: components["parameters"]["ObserverAdminCursor"];
                limit?: components["parameters"]["ObserverAdminLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Observer source page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverSourcePageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createObserverSource: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["ObserverAdminIdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ObserverSourceCreateInput"];
            };
        };
        responses: {
            /** @description Observer source operation receipt */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverManagementWriteResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    updateObserverSource: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["ObserverAdminIdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                source_id: components["parameters"]["ObserverSourceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ObserverSourceUpdateInput"];
            };
        };
        responses: {
            /** @description Observer source operation receipt */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverManagementWriteResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listReferralRules: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current configuration */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            rules: {
                                enabled: boolean;
                                /** @enum {string} */
                                period: "monthly" | "yearly";
                                /** @enum {string} */
                                plan: "plus" | "pro";
                                rate_bps: number;
                                revision: string;
                                rule_id: string;
                            }[];
                        };
                        meta: {
                            /** Format: date-time */
                            generated_at: string;
                            request_id: string;
                        };
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            421: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    updateReferralRules: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Unique rule IDs; duplicates are rejected. */
                    changes: {
                        enabled: boolean;
                        /** @description Unsigned BIGINT revision below 18446744073709551615. */
                        expected_revision: string;
                        rate_bps: number;
                        /** @description Positive signed INT ID, at most 2147483647. */
                        rule_id: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Committed result or verified replay */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            replayed: boolean;
                            rules: {
                                revision: string;
                                rule_id: string;
                            }[];
                        };
                        meta: {
                            /** Format: date-time */
                            generated_at: string;
                            request_id: string;
                        };
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            421: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    readAdminSystemSetting: {
        parameters: {
            query: {
                key: string;
                namespace: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Stored value or protected credential metadata; no synthetic defaults */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            key: string;
                            namespace: string;
                            /** @constant */
                            protected: true;
                            revision: string;
                            /** @enum {string} */
                            sensitivity: "public" | "restricted" | "secret";
                            setting_id: string;
                            /** @enum {string} */
                            value_state: "null" | "empty" | "text";
                            /** @enum {string} */
                            value_type: "string" | "boolean" | "integer" | "enum" | "json_array" | "credential";
                        } | {
                            key: string;
                            namespace: string;
                            /** @constant */
                            protected: false;
                            revision: string;
                            /** @enum {string} */
                            sensitivity: "public" | "restricted";
                            setting_id: string;
                            value: string | null;
                            /** @enum {string} */
                            value_state: "null" | "empty" | "text";
                            /** @enum {string} */
                            value_type: "string" | "boolean" | "integer" | "enum" | "json_array";
                        };
                        meta: {
                            /** Format: date-time */
                            generated_at: string;
                            request_id: string;
                        };
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            /** @description Known configuration key has no stored row */
            404: components["responses"]["Problem"];
            421: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    updateSystemSetting: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expected_revision: string;
                    key: string;
                    namespace: string;
                    /** @description Original text; no implicit coercion, trimming or defaults. */
                    value: string;
                    /** @enum {string} */
                    value_type: "string" | "boolean" | "integer" | "enum" | "json_array";
                };
            };
        };
        responses: {
            /** @description Original durable result or newly committed version */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            replayed: boolean;
                            revision: string;
                            setting_id: string;
                        };
                        meta: {
                            /** Format: date-time */
                            generated_at: string;
                            request_id: string;
                        };
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            421: components["responses"]["Problem"];
            /** @description Configuration policy rejected */
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listPlatformStrategies: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Strategy catalog */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getPlatformStrategy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                strategy_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Strategy detail */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createPlatformStrategyVersion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                strategy_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StrategyVersionCreate"];
            };
        };
        responses: {
            /** @description Version created */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    publishPlatformStrategyVersion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                strategy_id: components["schemas"]["OpaqueId"];
                version_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Version published */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createAnalysisJob: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AnalysisJobCreate"];
            };
        };
        responses: {
            /** @description Analysis accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnalysisJobResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listAuditEvents: {
        parameters: {
            query?: {
                account_id?: components["schemas"]["OpaqueId"];
                actor?: components["schemas"]["AuditActor"];
                category?: components["schemas"]["AuditCategory"];
                cursor?: components["parameters"]["Cursor"];
                from?: components["schemas"]["UtcDateTime"];
                page_size?: number;
                q?: string;
                status?: components["schemas"]["AuditStatus"];
                to?: components["schemas"]["UtcDateTime"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Frozen audit event page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEventPageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getAuditEvent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                source_id: components["schemas"]["OpaqueId"];
                source_kind: components["schemas"]["AuditSourceKind"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Audit event and exact trace */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEventDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    loginAtIdentityCenter: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AuthLoginRequest"];
            };
        };
        responses: {
            /** @description Authentication succeeded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthLoginResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    logoutAuthCenterSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Must equal the configured identity center issuer origin. */
                Origin: string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current auth session revoked; empty body */
            204: {
                headers: {
                    /** @description Expires the host-only auth session cookie with Max-Age=0. */
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getAuthCenterSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Identity center session */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthCenterSessionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getBridgeConnectionCapacity: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Connection capacity */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionCapacityResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    revokeBridgeDeviceCredential: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgeSessionTokenRequest"];
            };
        };
        responses: {
            /** @description The exact device credential is revoked */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeCredentialRevocationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    startBridgeInstallationAuthorization: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgeInstallationStart"];
            };
        };
        responses: {
            /** @description Authoritative installation result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeInstallationStartedResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getBridgeInstallationAuthorization: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                authorization_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authoritative installation result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeInstallationConfirmationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    decideBridgeInstallationAuthorization: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                authorization_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgeInstallationDecision"];
            };
        };
        responses: {
            /** @description Authoritative installation result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeInstallationConfirmationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    pollBridgeInstallationAuthorization: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                authorization_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgeInstallationPoll"];
            };
        };
        responses: {
            /** @description Authoritative installation result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeInstallationPolledResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    registerBridgeInstallationProfile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgeInstallationProfileRequest"];
            };
        };
        responses: {
            /** @description Authoritative installation result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeInstallationProfileResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    revokeBridgeInstallation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgeInstallationProof"];
            };
        };
        responses: {
            /** @description Authoritative installation result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeInstallationRevokedResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getBridgeInstallationStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgeInstallationProof"];
            };
        };
        responses: {
            /** @description Authoritative installation result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeInstallationStatusResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    exchangeLegacyBridgeCredential: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LegacyBridgeCredentialExchange"];
            };
        };
        responses: {
            /** @description V4 device refresh credential issued; the V3 credential remains valid for rollback */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeRefreshCredentialResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    redeemBridgePairing: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgePairingRedemption"];
            };
        };
        responses: {
            /** @description Credential bound, or identical redemption replayed while still valid */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgePairingCredentialResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createBridgePairingRequest: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgePairingRequest"];
            };
        };
        responses: {
            /** @description Pairing registered; no account ownership or connection quota granted */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgePairingResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createBridgeSessionToken: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BridgeSessionTokenRequest"];
            };
        };
        responses: {
            /** @description Short-lived, one-time Bridge session token created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BridgeSessionTokenResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listTerminalProfiles: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Terminal profiles */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalProfileListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createExecutionDistribution: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionDistribution"];
            };
        };
        responses: {
            /** @description Distribution durably accepted, not necessarily executed by MT */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getExecutionDistribution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                distribution_id: components["parameters"]["DistributionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Frozen distribution detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionDistributionDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createDistributionCloseCommand: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                distribution_id: components["parameters"]["DistributionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DistributionCloseCommand"];
            };
        };
        responses: {
            /** @description Distribution close durably accepted, not necessarily executed by MT */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    previewExecutionDistribution: {
        parameters: {
            query: {
                strategy_id: components["schemas"]["OpaqueId"];
                symbol: components["schemas"]["Symbol"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current distribution estimate */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionDistributionPreviewResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listArchivedExecutions: {
        parameters: {
            query?: {
                cursor?: string;
                page_size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical data only */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listArchivedExecutionsResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getArchivedExecution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                legacy_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical data only */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["getArchivedExecutionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listArchivedExecutionDeals: {
        parameters: {
            query?: {
                cursor?: string;
                page_size?: number;
            };
            header?: never;
            path: {
                legacy_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical deals */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ArchivedExecutionDealsResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listArchivedSignals: {
        parameters: {
            query?: {
                cursor?: string;
                page_size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical data only */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listArchivedSignalsResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getArchivedSignal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                legacy_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical data only */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["getArchivedSignalResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listLearningCourses: {
        parameters: {
            query?: {
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Learning data */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LearningListResponse"];
                };
            };
            /** @description Invalid cursor */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Invalid www session */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Course not published or absent */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Wrong application host */
            421: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Read unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    setLearningCompletion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                courseId: string;
                lessonId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LearningCompletionRequest"];
            };
        };
        responses: {
            /** @description Saved or replayed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LearningCompletionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            421: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getLearningCourse: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Learning data */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LearningDetailResponse"];
                };
            };
            /** @description Invalid cursor */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Invalid www session */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Course not published or absent */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Wrong application host */
            421: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Read unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listManualReviewCandidates: {
        parameters: {
            query?: {
                account_id?: components["schemas"]["OpaqueId"];
                page_size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Manual review candidates */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManualReviewCandidateListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createManualReviewCase: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ManualReviewCaseInput"];
            };
        };
        responses: {
            /** @description Manual review queued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewCaseDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listMarketAnalyses: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                page_size?: components["parameters"]["PageSize"];
                strategy_id?: components["schemas"]["OpaqueId"];
                symbol?: components["parameters"]["SymbolQueryOptional"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Market-analysis summaries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MarketAnalysisListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getMarketAnalysis: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                analysis_id: components["parameters"]["AnalysisId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Complete structured analysis and user-facing reasoning */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MarketAnalysisDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createTraderEvaluation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                analysis_id: components["parameters"]["AnalysisId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TraderEvaluationCreate"];
            };
        };
        responses: {
            /** @description Account evaluation durably queued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TraderRunResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listEconomicCalendarEvents: {
        parameters: {
            query: {
                cursor?: components["parameters"]["Cursor"];
                from: components["schemas"]["UtcDateTime"];
                importance?: "low" | "medium" | "high" | "unknown";
                limit?: number;
                to: components["schemas"]["UtcDateTime"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Economic calendar events */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EconomicCalendarEventListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getEconomicCalendarEvent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                event_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Economic calendar event */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EconomicCalendarEventResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listMarketCandles: {
        parameters: {
            query: {
                account_id: components["parameters"]["AccountIdQuery"];
                /** @description Authorized observer channel required when reading an account the current user does not own. */
                observer_channel_id?: components["parameters"]["ObserverChannelIdQuery"];
                page_size?: components["parameters"]["CandlePageSize"];
                symbol: components["parameters"]["SymbolQuery"];
                timeframe: components["parameters"]["Timeframe"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical candle window */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CandleListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listMacroSeriesPoints: {
        parameters: {
            query: {
                code: string;
                cursor?: components["parameters"]["Cursor"];
                from?: components["schemas"]["UtcDateTime"];
                limit?: number;
                to?: components["schemas"]["UtcDateTime"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Macro series observations */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MacroSeriesResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            /** @description Series data or dependency unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listMacroSnapshots: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Macro snapshot summaries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MacroSnapshotListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getMacroSnapshot: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                snapshot_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Macro snapshot detail */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MacroSnapshotResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getLatestMacroSnapshot: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Latest macro snapshot */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MacroSnapshotResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getMacroMarketOverview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Macro market overview */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MacroMarketOverviewResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getPublicMarketSnapshot: {
        parameters: {
            query: {
                /** @description Read candles strictly before this UTC timestamp. */
                before?: string;
                page_size?: components["parameters"]["CandlePageSize"];
                symbol: components["parameters"]["SymbolQuery"];
                timeframe: components["parameters"]["Timeframe"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical candle window */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicMarketSnapshotResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listPublicMarketSymbols: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Shared base symbols */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicMarketSymbolsResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getMarketQuote: {
        parameters: {
            query: {
                account_id: components["parameters"]["AccountIdQuery"];
                /** @description Authorized observer channel required when reading an account the current user does not own. */
                observer_channel_id?: components["parameters"]["ObserverChannelIdQuery"];
            };
            header?: never;
            path: {
                symbol: components["parameters"]["Symbol"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current quote snapshot */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuoteResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listTerminalMarketSymbols: {
        parameters: {
            query: {
                account_id: components["parameters"]["AccountIdQuery"];
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical candle window */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalMarketSymbolsResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getTerminalMarketWindow: {
        parameters: {
            query: {
                account_id: components["parameters"]["AccountIdQuery"];
                before: string;
                page_size?: components["parameters"]["CandlePageSize"];
                symbol: components["parameters"]["SymbolQuery"];
                timeframe: components["parameters"]["Timeframe"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical candle window */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalMarketWindowResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getModelAssignments: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Model configuration */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelAssignmentsResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    setModelAssignments: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    analysis: string | null;
                    review: string | null;
                    revision: string;
                    trader: string | null;
                };
            };
        };
        responses: {
            /** @description Model configuration */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelAssignmentsResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listModelConfigurations: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Model configuration */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelConfigurationListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createModelConfiguration: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    api_key: string;
                    base_url: string;
                    context_window_tokens?: number | null;
                    max_input_tokens?: number | null;
                    max_output_tokens: number | null;
                    name: string;
                    /** @enum {string} */
                    protocol: "chat_completions" | "responses";
                    /** @enum {string} */
                    provider: "volcengine_agent_plan" | "deepseek" | "openai_compatible";
                    /** @enum {string|null} */
                    reasoning_effort?: null | "low" | "medium" | "high" | "max";
                    request_timeout_ms?: number | null;
                    /** @enum {string} */
                    scope: "user" | "platform";
                    temperature?: number | null;
                    thinking_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Model configuration */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelConfigurationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    saveModelConfiguration: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    api_key?: string;
                    base_url: string;
                    context_window_tokens?: number | null;
                    expected_revision: string;
                    max_input_tokens?: number | null;
                    max_output_tokens?: number | null;
                    /**
                     * @deprecated
                     * @description Legacy compatibility only; requests use max_output_tokens from model capabilities.
                     */
                    max_tokens?: number | null;
                    name: string;
                    /** @enum {string} */
                    protocol: "chat_completions" | "responses";
                    /** @enum {string|null} */
                    reasoning_effort?: null | "low" | "medium" | "high" | "max";
                    request_timeout_ms?: number | null;
                    temperature?: number | null;
                    thinking_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Model configuration */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelConfigurationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    deleteModelConfiguration: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expected_revision: string;
                };
            };
        };
        responses: {
            /** @description Model configuration */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelDeletedResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    verifyModelConfiguration: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expected_revision: string;
                };
            };
        };
        responses: {
            /** @description Model configuration */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelConfigurationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getModelSelection: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Model selection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelSelectionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    setModelSelection: {
        parameters: {
            query?: never;
            header: {
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expected_model_profile_id: string | null;
                    model_profile_id: string;
                };
            };
        };
        responses: {
            /** @description Model selection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelSelectionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listObserverChannels: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized observer channels */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObserverChannelListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operation_id: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current operation state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getPersonalNotifications: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            items: {
                                actionable: boolean;
                                createdAt: string;
                                id: string;
                                /** @enum {string} */
                                kind: "analysis" | "decision";
                                read: boolean;
                                resourceId: string;
                                summary: string;
                                title: string;
                            }[];
                            unread: number;
                        };
                        meta: Record<string, never>;
                    };
                };
            };
        };
    };
    readPersonalNotification: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {boolean} */
                    all?: true;
                    id?: string;
                } & (unknown | unknown);
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            read: boolean;
                        };
                        meta: Record<string, never>;
                    };
                };
            };
        };
    };
    getPersonalSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            emailAvailable: boolean;
                            hasFeishu: boolean;
                            nickname: string;
                            preferences: {
                                /** @enum {string} */
                                analysis: "off" | "effective" | "all";
                                /** @enum {string} */
                                analysisSound: "off" | "bell" | "chime" | "pulse";
                                /** @enum {string} */
                                decision: "off" | "effective" | "all";
                                /** @enum {string} */
                                decisionSound: "off" | "bell" | "chime" | "pulse";
                                emailEnabled: boolean;
                                feishuEnabled: boolean;
                            };
                            revision: number;
                        };
                        meta: Record<string, never>;
                    };
                };
            };
        };
    };
    savePersonalSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    feishuSecret?: string;
                    feishuWebhook?: string;
                    nickname: string;
                    preferences: {
                        /** @enum {string} */
                        analysis: "off" | "effective" | "all";
                        /** @enum {string} */
                        analysisSound: "off" | "bell" | "chime" | "pulse";
                        /** @enum {string} */
                        decision: "off" | "effective" | "all";
                        /** @enum {string} */
                        decisionSound: "off" | "bell" | "chime" | "pulse";
                        emailEnabled: boolean;
                        feishuEnabled: boolean;
                    };
                    revision: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            revision: number;
                        };
                        meta: Record<string, never>;
                    };
                };
            };
        };
    };
    listPositions: {
        parameters: {
            query: {
                account_id: components["parameters"]["AccountIdQuery"];
                cursor?: components["parameters"]["Cursor"];
                page_size?: components["parameters"]["PageSize"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current positions */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PositionListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createRealtimeTicket: {
        parameters: {
            query?: never;
            header: {
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Realtime ticket created */
            201: {
                headers: {
                    /** @description Short-lived one-time ticket restricted to /realtime/v4 */
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RealtimeTicketResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listReviewCases: {
        parameters: {
            query?: {
                account_id?: components["schemas"]["OpaqueId"];
                kind?: "daily" | "monthly" | "manual" | "trade";
                page_size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review cases */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewCaseListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getReviewCase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review case */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewCaseDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    confirmReviewVersion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version_id: components["schemas"]["OpaqueId"];
                };
            };
        };
        responses: {
            /** @description Review confirmed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewCaseDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    requestReviewGeneration: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    mode: "retry" | "refresh_evidence";
                };
            };
        };
        responses: {
            /** @description Generation queued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewCaseDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getReviewHistoricalMetadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review case */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewHistoricalMetadataResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listArchivedReviewEvents: {
        parameters: {
            query?: {
                offset?: number;
                page_size?: number;
            };
            header?: never;
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review case */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ArchivedReviewEventPageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listArchivedReviewJobs: {
        parameters: {
            query?: {
                offset?: number;
                page_size?: number;
            };
            header?: never;
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review case */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ArchivedReviewJobPageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listArchivedReviewStages: {
        parameters: {
            query?: {
                offset?: number;
                page_size?: number;
            };
            header?: never;
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review case */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ArchivedReviewStagePageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    returnReviewCase: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Review returned */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewCaseDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listReviewVersions: {
        parameters: {
            query?: {
                before_version?: number;
                page_size?: number;
            };
            header?: never;
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review case */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewVersionHistoryResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createReviewVersion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content: components["schemas"]["ReviewContent"];
                };
            };
        };
        responses: {
            /** @description Immutable version created */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewCaseDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getReviewVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                review_case_id: components["parameters"]["ReviewCaseId"];
                version_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review case */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewVersionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getManualRiskRelease: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Latest release and server-owned release availability */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManualRiskReleaseResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createManualRiskRelease: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ManualRiskReleaseInput"];
            };
        };
        responses: {
            /** @description Manual release created */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManualRiskReleaseCreatedResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getManualRiskReleaseReceipt: {
        parameters: {
            query: {
                idempotency_key: string;
            };
            header?: never;
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Exact receipt or unconfirmed result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManualRiskReleaseReceiptResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getRiskPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Risk policy */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RiskPolicyResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    replaceRiskPolicy: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RiskPolicyInput"];
            };
        };
        responses: {
            /** @description Risk policy replaced */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RiskPolicyResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getRiskPolicyReceipt: {
        parameters: {
            query: {
                idempotency_key: string;
            };
            header?: never;
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Exact receipt or unconfirmed result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RiskPolicyReceiptResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getAccountRiskSummary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Account risk summary */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountRiskSummaryResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listRiskDecisions: {
        parameters: {
            query: {
                account_id: components["parameters"]["AccountIdQuery"];
                page_size?: components["parameters"]["PageSize"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Risk decision summaries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RiskDecisionListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getRiskDecision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                risk_decision_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Complete risk decision */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RiskDecisionDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getApplicationSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    logoutCurrentApplication: {
        parameters: {
            query?: never;
            header: {
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current application session revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    logoutAllWebApplications: {
        parameters: {
            query?: never;
            header: {
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description All website sessions revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    revokeAllSessionsAndDevices: {
        parameters: {
            query?: never;
            header: {
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description All website and device sessions revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listStrategies: {
        parameters: {
            query?: {
                kind?: "analysis" | "trader";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Strategy catalog */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createStrategy: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StrategyCreate"];
            };
        };
        responses: {
            /** @description Strategy created */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getStrategy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                strategy_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Strategy detail */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    updateStrategyMetadata: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                strategy_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StrategyMetadataPatch"];
            };
        };
        responses: {
            /** @description Metadata updated */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    retireStrategy: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                strategy_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Strategy retired */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createStrategyVersion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                strategy_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StrategyVersionCreate"];
            };
        };
        responses: {
            /** @description Version created */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    publishStrategyVersion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                strategy_id: components["schemas"]["OpaqueId"];
                version_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Version published */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    compileStrategy: {
        parameters: {
            query?: never;
            header: {
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StrategyCompile"];
            };
        };
        responses: {
            /** @description Compile result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyCompileResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createStrategyCombination: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StrategyCombinationCreate"];
            };
        };
        responses: {
            /** @description Strategy combination created */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createStrategyCombinationVersion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                analysis_strategy_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StrategyCombinationVersionCreate"];
            };
        };
        responses: {
            /** @description Strategy combination versions created */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listStrategyMemories: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Strategy memories */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyMemoryListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getStrategyMemory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                memory_id: components["parameters"]["MemoryId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Strategy memory */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyMemoryDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listStrategyMemoryUpdates: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                memory_id: components["parameters"]["MemoryId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pending and decided memory updates */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyMemoryUpdateListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    decideStrategyMemoryUpdate: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                update_id: components["parameters"]["MemoryUpdateId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    decision: "accept" | "reject" | "revoke";
                };
            };
        };
        responses: {
            /** @description Memory decision persisted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyMemoryUpdateResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listStrategySubscriptions: {
        parameters: {
            query?: {
                account_id?: components["schemas"]["OpaqueId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Strategy subscriptions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategySubscriptionListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createStrategySubscription: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StrategySubscriptionCreate"];
            };
        };
        responses: {
            /** @description Subscription created */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategySubscriptionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    updateStrategySubscription: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "If-Match": components["parameters"]["IfMatch"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                subscription_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StrategySubscriptionPatch"];
            };
        };
        responses: {
            /** @description Subscription updated */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategySubscriptionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    setAccountTrader: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    account_id: components["schemas"]["OpaqueId"];
                    enabled: boolean;
                    expected: {
                        id: components["schemas"]["OpaqueId"];
                        revision: number;
                    }[];
                };
            };
        };
        responses: {
            /** @description Account trader updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            enabled: boolean;
                        };
                        meta: components["schemas"]["Meta"];
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listTradeDecisions: {
        parameters: {
            query: {
                account_id: components["parameters"]["AccountIdQuery"];
                page_size?: components["parameters"]["PageSize"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Account decision summaries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradeDecisionListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getTradeDecision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                decision_id: components["parameters"]["DecisionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Complete trader decision */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradeDecisionDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listTradeHistory: {
        parameters: {
            query: {
                account_id: components["parameters"]["AccountIdQuery"];
                cursor?: components["parameters"]["Cursor"];
                /** @description Inclusive terminal business date */
                from_date?: components["schemas"]["BusinessDate"];
                outcome?: "profit" | "loss" | "breakeven";
                page_size?: components["parameters"]["PageSize"];
                /** @description Exact ticket, position ID or symbol */
                q?: string;
                side?: "buy" | "sell";
                source?: "system" | "manual" | "other_ea" | "mixed" | "unknown";
                symbol?: components["parameters"]["SymbolQueryOptional"];
                /** @description Inclusive terminal business date */
                to_date?: components["schemas"]["BusinessDate"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Frozen trade history page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradeHistoryPageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    getTradeRecord: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                trade_record_id: components["schemas"]["OpaqueId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Trade record detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradeRecordDetailResponse"];
                };
            };
            401: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    listTradingAccounts: {
        parameters: {
            query?: {
                access?: "current" | "history";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Owned trading accounts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradingAccountListResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createExecutionCommand: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionCommand"];
            };
        };
        responses: {
            /** @description Command durably accepted, not necessarily executed by MT */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getExecutionCommandContext: {
        parameters: {
            query?: {
                symbol?: components["schemas"]["Symbol"];
                ticket?: string;
            };
            header?: never;
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authoritative command confirmation context */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionCommandContextResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getTradingAccountSnapshot: {
        parameters: {
            query?: {
                /** @description Authorized observer channel required when reading an account the current user does not own. */
                observer_channel_id?: components["parameters"]["ObserverChannelIdQuery"];
            };
            header?: never;
            path: {
                account_id: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Consistent account snapshot */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradingWorkspaceResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getTradingContext: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current user trading scope */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradingContextResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    replaceTradingContext: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TradingContextInput"];
            };
        };
        responses: {
            /** @description Trading context replaced */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradingContextResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getTradingContextReceipt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                request_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Historical receipt or no visible receipt */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradingContextReceiptResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    leaveObserverMode: {
        parameters: {
            query: {
                expected_revision: string;
            };
            header: {
                "Idempotency-Key": string;
                "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Observer mode exited */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TradingContextResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
}
