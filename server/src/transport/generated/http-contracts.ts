// Generated from contracts/http. Do not edit.
import type { HttpRuntimeContracts } from '../http-contract.js'

export const httpRuntimeContracts: HttpRuntimeContracts = {
  "components": {
    "schemas": {
      "AccountRiskSummary": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "business_date": {
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
            "type": [
              "string",
              "null"
            ]
          },
          "clock_status": {
            "enum": [
              "calibrated",
              "observer_bootstrap",
              "stale",
              "unavailable"
            ],
            "type": "string"
          },
          "consecutive_losses": {
            "minimum": 0,
            "type": "integer"
          },
          "cooldown_until": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "daily_loss_percent": {
            "$ref": "#/components/schemas/Decimal"
          },
          "daily_open_count": {
            "minimum": 0,
            "type": "integer"
          },
          "data_complete": {
            "type": "boolean"
          },
          "drawdown_percent": {
            "$ref": "#/components/schemas/Decimal"
          },
          "equity": {
            "$ref": "#/components/schemas/Decimal"
          },
          "free_margin": {
            "$ref": "#/components/schemas/Decimal"
          },
          "incomplete_reasons": {
            "items": {
              "maxLength": 128,
              "type": "string"
            },
            "type": "array",
            "uniqueItems": true
          },
          "last_successful_open_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "margin_level_percent": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "observed_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "open_positions": {
            "minimum": 0,
            "type": "integer"
          },
          "pending_orders": {
            "minimum": 0,
            "type": "integer"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "terminal_timezone_offset_minutes": {
            "maximum": 840,
            "minimum": -840,
            "type": [
              "integer",
              "null"
            ]
          },
          "total_volume": {
            "$ref": "#/components/schemas/Decimal"
          }
        },
        "required": [
          "account_id",
          "business_date",
          "equity",
          "free_margin",
          "margin_level_percent",
          "daily_loss_percent",
          "drawdown_percent",
          "open_positions",
          "pending_orders",
          "total_volume",
          "daily_open_count",
          "consecutive_losses",
          "terminal_timezone_offset_minutes",
          "clock_status",
          "last_successful_open_at",
          "cooldown_until",
          "data_complete",
          "incomplete_reasons",
          "observed_at",
          "revision"
        ],
        "type": "object"
      },
      "AccountRiskSummaryResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/AccountRiskSummary"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "AccountSnapshot": {
        "additionalProperties": false,
        "properties": {
          "balance": {
            "$ref": "#/components/schemas/Decimal"
          },
          "bridge_state": {
            "enum": [
              "online",
              "offline",
              "paused",
              "replaced",
              "unauthorized"
            ],
            "type": "string"
          },
          "clock_status": {
            "enum": [
              "calibrated",
              "observer_bootstrap",
              "stale",
              "unavailable"
            ],
            "type": "string"
          },
          "currency": {
            "maxLength": 12,
            "minLength": 3,
            "type": "string"
          },
          "equity": {
            "$ref": "#/components/schemas/Decimal"
          },
          "floating_profit": {
            "$ref": "#/components/schemas/Decimal"
          },
          "free_margin": {
            "$ref": "#/components/schemas/Decimal"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "last_seen_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "leverage": {
            "minimum": 1,
            "type": [
              "integer",
              "null"
            ]
          },
          "login": {
            "maxLength": 64,
            "type": "string"
          },
          "margin": {
            "$ref": "#/components/schemas/Decimal"
          },
          "observed_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "platform": {
            "enum": [
              "mt4",
              "mt5"
            ],
            "type": "string"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "server": {
            "maxLength": 191,
            "type": "string"
          },
          "terminal_instance_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "terminal_profile_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "timezone_offset_minutes": {
            "maximum": 840,
            "minimum": -840,
            "type": [
              "integer",
              "null"
            ]
          },
          "trade_permission": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "platform",
          "login",
          "server",
          "currency",
          "terminal_profile_id",
          "terminal_instance_id",
          "bridge_state",
          "trade_permission",
          "last_seen_at",
          "balance",
          "equity",
          "margin",
          "free_margin",
          "floating_profit",
          "leverage",
          "timezone_offset_minutes",
          "clock_status",
          "observed_at",
          "revision"
        ],
        "type": "object"
      },
      "AnalysisJob": {
        "additionalProperties": false,
        "properties": {
          "analysis_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "status": {
            "enum": [
              "queued",
              "running",
              "succeeded",
              "failed",
              "cancelled",
              "expired"
            ],
            "type": "string"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "strategy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "trigger": {
            "enum": [
              "manual",
              "scheduled",
              "event"
            ],
            "type": "string"
          },
          "updated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "analysis_id",
          "strategy_id",
          "strategy_version_id",
          "symbol",
          "trigger",
          "status",
          "created_at",
          "updated_at",
          "revision"
        ],
        "type": "object"
      },
      "AnalysisJobCreate": {
        "additionalProperties": false,
        "properties": {
          "mode": {
            "const": "manual"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          }
        },
        "required": [
          "strategy_id",
          "symbol",
          "mode"
        ],
        "type": "object"
      },
      "AnalysisJobResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/AnalysisJob"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ArchivedExecutionDeal": {
        "additionalProperties": false,
        "properties": {
          "commission": {
            "pattern": "^-?[0-9]+(\\.[0-9]+)?$",
            "type": "string"
          },
          "deal_ticket": {
            "type": "string"
          },
          "entry_type": {
            "type": [
              "integer",
              "null"
            ]
          },
          "fee": {
            "pattern": "^-?[0-9]+(\\.[0-9]+)?$",
            "type": "string"
          },
          "legacy_id": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          },
          "legacy_outcome_id": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          },
          "occurred_at_utc": {
            "format": "date-time",
            "type": [
              "string",
              "null"
            ]
          },
          "order_ticket": {
            "type": [
              "string",
              "null"
            ]
          },
          "position_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "price": {
            "pattern": "^-?[0-9]+(\\.[0-9]+)?$",
            "type": [
              "string",
              "null"
            ]
          },
          "profit": {
            "pattern": "^-?[0-9]+(\\.[0-9]+)?$",
            "type": "string"
          },
          "swap": {
            "pattern": "^-?[0-9]+(\\.[0-9]+)?$",
            "type": "string"
          },
          "volume": {
            "pattern": "^-?[0-9]+(\\.[0-9]+)?$",
            "type": "string"
          }
        },
        "required": [
          "legacy_id",
          "legacy_outcome_id",
          "deal_ticket",
          "position_id",
          "order_ticket",
          "entry_type",
          "volume",
          "price",
          "profit",
          "commission",
          "swap",
          "fee",
          "occurred_at_utc"
        ],
        "type": "object"
      },
      "ArchivedExecutionDealsResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "executable": {
                "enum": [
                  false
                ],
                "type": "boolean"
              },
              "identity_namespace": {
                "enum": [
                  "retained-legacy"
                ],
                "type": "string"
              },
              "items": {
                "items": {
                  "$ref": "#/components/schemas/ArchivedExecutionDeal"
                },
                "maxItems": 100,
                "type": "array"
              },
              "legacy_execution_id": {
                "pattern": "^[1-9][0-9]{0,18}$",
                "type": "string"
              },
              "next_cursor": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "items",
              "next_cursor",
              "legacy_execution_id",
              "identity_namespace",
              "executable"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ArchivedExecutionDetail": {
        "additionalProperties": false,
        "properties": {
          "action": {
            "type": "string"
          },
          "completed_at_utc": {
            "format": "date-time",
            "type": [
              "string",
              "null"
            ]
          },
          "created_at_utc": {
            "format": "date-time",
            "type": "string"
          },
          "error_code": {
            "type": [
              "string",
              "null"
            ]
          },
          "executable": {
            "enum": [
              false
            ],
            "type": "boolean"
          },
          "identity_namespace": {
            "enum": [
              "retained-legacy"
            ],
            "type": "string"
          },
          "legacy_account_id": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": [
              "string",
              "null"
            ]
          },
          "legacy_id": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          },
          "pending_ticket": {
            "type": [
              "string",
              "null"
            ]
          },
          "status": {
            "type": "string"
          },
          "symbol": {
            "type": [
              "string",
              "null"
            ]
          },
          "trade_ticket": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "legacy_id",
          "legacy_account_id",
          "symbol",
          "action",
          "status",
          "created_at_utc",
          "trade_ticket",
          "pending_ticket",
          "error_code",
          "completed_at_utc",
          "identity_namespace",
          "executable"
        ],
        "type": "object"
      },
      "ArchivedExecutionSummary": {
        "additionalProperties": false,
        "properties": {
          "action": {
            "type": "string"
          },
          "created_at_utc": {
            "format": "date-time",
            "type": "string"
          },
          "legacy_account_id": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": [
              "string",
              "null"
            ]
          },
          "legacy_id": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "symbol": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "legacy_id",
          "legacy_account_id",
          "symbol",
          "action",
          "status",
          "created_at_utc"
        ],
        "type": "object"
      },
      "ArchivedReviewEvent": {
        "additionalProperties": false,
        "properties": {
          "id": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "job_id": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "message_code": {
            "maxLength": 191,
            "type": [
              "string",
              "null"
            ]
          },
          "occurred_at": {
            "format": "date-time",
            "type": "string"
          },
          "original_status": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "stage": {
            "maxLength": 191,
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "job_id",
          "stage",
          "original_status",
          "message_code",
          "occurred_at"
        ],
        "type": "object"
      },
      "ArchivedReviewEventPageResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/ArchivedReviewEvent"
                },
                "maxItems": 100,
                "type": "array"
              },
              "next_offset": {
                "maximum": 10000,
                "minimum": 0,
                "type": [
                  "integer",
                  "null"
                ]
              },
              "total": {
                "maximum": 10000,
                "minimum": 0,
                "type": "integer"
              }
            },
            "required": [
              "items",
              "total",
              "next_offset"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ArchivedReviewJob": {
        "additionalProperties": false,
        "properties": {
          "attempts": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "completed_at": {
            "format": "date-time",
            "type": [
              "string",
              "null"
            ]
          },
          "created_at": {
            "format": "date-time",
            "type": "string"
          },
          "error_code": {
            "maxLength": 191,
            "type": [
              "string",
              "null"
            ]
          },
          "id": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "original_status": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "source_id": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "source_table": {
            "enum": [
              "period_review_jobs",
              "manual_trade_review_jobs"
            ],
            "type": "string"
          },
          "stage": {
            "maxLength": 191,
            "type": [
              "string",
              "null"
            ]
          },
          "updated_at": {
            "format": "date-time",
            "type": "string"
          }
        },
        "required": [
          "id",
          "source_table",
          "source_id",
          "original_status",
          "stage",
          "attempts",
          "error_code",
          "created_at",
          "updated_at",
          "completed_at"
        ],
        "type": "object"
      },
      "ArchivedReviewJobPageResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/ArchivedReviewJob"
                },
                "maxItems": 100,
                "type": "array"
              },
              "next_offset": {
                "maximum": 10000,
                "minimum": 0,
                "type": [
                  "integer",
                  "null"
                ]
              },
              "total": {
                "maximum": 10000,
                "minimum": 0,
                "type": "integer"
              }
            },
            "required": [
              "items",
              "total",
              "next_offset"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ArchivedReviewStage": {
        "additionalProperties": false,
        "properties": {
          "completed_at": {
            "format": "date-time",
            "type": [
              "string",
              "null"
            ]
          },
          "created_at": {
            "format": "date-time",
            "type": "string"
          },
          "error_code": {
            "maxLength": 191,
            "type": [
              "string",
              "null"
            ]
          },
          "generation": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "has_output": {
            "type": "boolean"
          },
          "id": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "input_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": [
              "string",
              "null"
            ]
          },
          "job_id": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "original_status": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "output_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": [
              "string",
              "null"
            ]
          },
          "stage": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "id",
          "job_id",
          "generation",
          "stage",
          "original_status",
          "input_hash",
          "output_hash",
          "has_output",
          "error_code",
          "created_at",
          "completed_at"
        ],
        "type": "object"
      },
      "ArchivedReviewStagePageResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/ArchivedReviewStage"
                },
                "maxItems": 100,
                "type": "array"
              },
              "next_offset": {
                "maximum": 10000,
                "minimum": 0,
                "type": [
                  "integer",
                  "null"
                ]
              },
              "total": {
                "maximum": 10000,
                "minimum": 0,
                "type": "integer"
              }
            },
            "required": [
              "items",
              "total",
              "next_offset"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ArchivedSignalDetail": {
        "additionalProperties": false,
        "properties": {
          "analysis": {
            "type": [
              "string",
              "null"
            ]
          },
          "created_at_utc": {
            "format": "date-time",
            "type": "string"
          },
          "executable": {
            "enum": [
              false
            ],
            "type": "boolean"
          },
          "identity_namespace": {
            "enum": [
              "retained-legacy"
            ],
            "type": "string"
          },
          "inference_task_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "legacy_id": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          },
          "reasoning": {
            "type": [
              "string",
              "null"
            ]
          },
          "signal_type": {
            "type": "string"
          },
          "symbol": {
            "type": "string"
          },
          "timeframe": {
            "type": "string"
          }
        },
        "required": [
          "legacy_id",
          "symbol",
          "timeframe",
          "signal_type",
          "created_at_utc",
          "analysis",
          "reasoning",
          "inference_task_id",
          "identity_namespace",
          "executable"
        ],
        "type": "object"
      },
      "ArchivedSignalSummary": {
        "additionalProperties": false,
        "properties": {
          "created_at_utc": {
            "format": "date-time",
            "type": "string"
          },
          "legacy_id": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          },
          "signal_type": {
            "type": "string"
          },
          "symbol": {
            "type": "string"
          },
          "timeframe": {
            "type": "string"
          }
        },
        "required": [
          "legacy_id",
          "symbol",
          "timeframe",
          "signal_type",
          "created_at_utc"
        ],
        "type": "object"
      },
      "AuditActor": {
        "enum": [
          "ai",
          "user",
          "system",
          "bridge"
        ],
        "type": "string"
      },
      "AuditCategory": {
        "enum": [
          "analysis",
          "trading",
          "risk",
          "execution",
          "terminal",
          "configuration"
        ],
        "type": "string"
      },
      "AuditEvent": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "action": {
            "maxLength": 128,
            "minLength": 1,
            "type": "string"
          },
          "actor": {
            "$ref": "#/components/schemas/AuditActor"
          },
          "category": {
            "$ref": "#/components/schemas/AuditCategory"
          },
          "correlation_id": {
            "maxLength": 191,
            "type": [
              "string",
              "null"
            ]
          },
          "occurred_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "reason_code": {
            "maxLength": 128,
            "type": [
              "string",
              "null"
            ]
          },
          "source_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "source_kind": {
            "$ref": "#/components/schemas/AuditSourceKind"
          },
          "status": {
            "$ref": "#/components/schemas/AuditStatus"
          },
          "summary": {
            "maxLength": 2000,
            "minLength": 1,
            "type": "string"
          },
          "symbol": {
            "maxLength": 64,
            "type": [
              "string",
              "null"
            ]
          },
          "terminal_timezone_offset_minutes": {
            "maximum": 840,
            "minimum": -840,
            "type": [
              "integer",
              "null"
            ]
          },
          "title": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "source_kind",
          "source_id",
          "account_id",
          "category",
          "actor",
          "action",
          "status",
          "title",
          "summary",
          "reason_code",
          "symbol",
          "occurred_at",
          "terminal_timezone_offset_minutes",
          "correlation_id"
        ],
        "type": "object"
      },
      "AuditEventDetailResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "event": {
                "$ref": "#/components/schemas/AuditEvent"
              },
              "evidence": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "label": {
                      "maxLength": 64,
                      "minLength": 1,
                      "type": "string"
                    },
                    "value": {
                      "maxLength": 2000,
                      "minLength": 1,
                      "type": "string"
                    }
                  },
                  "required": [
                    "label",
                    "value"
                  ],
                  "type": "object"
                },
                "type": "array"
              },
              "links": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "$ref": "#/components/schemas/OpaqueId"
                    },
                    "kind": {
                      "enum": [
                        "analysis",
                        "trader",
                        "risk",
                        "operation",
                        "trade"
                      ],
                      "type": "string"
                    },
                    "label": {
                      "maxLength": 64,
                      "minLength": 1,
                      "type": "string"
                    }
                  },
                  "required": [
                    "kind",
                    "id",
                    "label"
                  ],
                  "type": "object"
                },
                "type": "array"
              },
              "trace": {
                "items": {
                  "$ref": "#/components/schemas/AuditTraceNode"
                },
                "type": "array"
              }
            },
            "required": [
              "event",
              "trace",
              "evidence",
              "links"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "AuditEventPageResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "captured_end": {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              "has_more": {
                "type": "boolean"
              },
              "items": {
                "items": {
                  "$ref": "#/components/schemas/AuditEvent"
                },
                "type": "array"
              },
              "next_cursor": {
                "maxLength": 2048,
                "type": [
                  "string",
                  "null"
                ]
              },
              "summary": {
                "$ref": "#/components/schemas/AuditSummary"
              }
            },
            "required": [
              "captured_end",
              "items",
              "next_cursor",
              "has_more",
              "summary"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "AuditSourceKind": {
        "enum": [
          "analysis_run",
          "trader_run",
          "trade_decision",
          "risk_decision",
          "operation",
          "bridge_command",
          "risk_policy_change",
          "risk_manual_release",
          "terminal_trade"
        ],
        "type": "string"
      },
      "AuditStatus": {
        "enum": [
          "queued",
          "running",
          "succeeded",
          "partially_succeeded",
          "rejected",
          "failed",
          "uncertain",
          "cancelled",
          "info"
        ],
        "type": "string"
      },
      "AuditSummary": {
        "additionalProperties": false,
        "properties": {
          "active": {
            "minimum": 0,
            "type": "integer"
          },
          "failed": {
            "minimum": 0,
            "type": "integer"
          },
          "rejected": {
            "minimum": 0,
            "type": "integer"
          },
          "succeeded": {
            "minimum": 0,
            "type": "integer"
          },
          "total": {
            "minimum": 0,
            "type": "integer"
          },
          "uncertain": {
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": [
          "total",
          "succeeded",
          "rejected",
          "failed",
          "uncertain",
          "active"
        ],
        "type": "object"
      },
      "AuditTraceNode": {
        "additionalProperties": false,
        "properties": {
          "action_kind": {
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "detail": {
            "maxLength": 2000,
            "minLength": 1,
            "type": "string"
          },
          "intent_id": {
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "occurred_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "parameters": {
            "additionalProperties": false,
            "properties": {
              "price": {
                "maxLength": 128,
                "type": "string"
              },
              "side": {
                "maxLength": 128,
                "type": "string"
              },
              "stop_loss": {
                "maxLength": 128,
                "type": "string"
              },
              "symbol": {
                "maxLength": 128,
                "type": "string"
              },
              "take_profit": {
                "maxLength": 128,
                "type": "string"
              },
              "ticket": {
                "maxLength": 128,
                "type": "string"
              },
              "volume": {
                "maxLength": 128,
                "type": "string"
              }
            },
            "type": "object"
          },
          "reason_code": {
            "maxLength": 128,
            "type": [
              "string",
              "null"
            ]
          },
          "source_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "source_kind": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "stage": {
            "enum": [
              "analysis",
              "trader",
              "risk",
              "operation",
              "intent",
              "bridge",
              "terminal"
            ],
            "type": "string"
          },
          "status": {
            "$ref": "#/components/schemas/AuditStatus"
          },
          "title": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "stage",
          "status",
          "source_kind",
          "source_id",
          "title",
          "detail",
          "reason_code",
          "occurred_at"
        ],
        "type": "object"
      },
      "AuthCenterSessionResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "authenticated_at": {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              "csrf_token": {
                "maxLength": 256,
                "minLength": 16,
                "type": "string"
              },
              "mfa_level": {
                "enum": [
                  "none",
                  "otp",
                  "strong"
                ],
                "type": "string"
              },
              "user": {
                "$ref": "#/components/schemas/Session/properties/user"
              }
            },
            "required": [
              "user",
              "authenticated_at",
              "mfa_level",
              "csrf_token"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "AuthLoginRequest": {
        "allOf": [
          {
            "$ref": "#/components/schemas/AuthorizationFields"
          },
          {
            "properties": {
              "login": {
                "maxLength": 255,
                "minLength": 1,
                "type": "string"
              },
              "password": {
                "maxLength": 1024,
                "minLength": 1,
                "type": "string",
                "writeOnly": true
              },
              "remember": {
                "type": "boolean"
              }
            },
            "required": [
              "login",
              "password"
            ],
            "type": "object"
          }
        ],
        "unevaluatedProperties": false
      },
      "AuthLoginResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "redirect_to": {
                "format": "uri",
                "type": "string"
              }
            },
            "required": [
              "redirect_to"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "AuthorizationFields": {
        "properties": {
          "client_id": {
            "enum": [
              "www-web",
              "trade-web",
              "admin-web"
            ],
            "type": "string"
          },
          "code_challenge": {
            "pattern": "^[A-Za-z0-9_-]{43}$",
            "type": "string"
          },
          "code_challenge_method": {
            "const": "S256"
          },
          "nonce": {
            "maxLength": 128,
            "minLength": 24,
            "type": "string"
          },
          "redirect_uri": {
            "format": "uri",
            "type": "string"
          },
          "response_type": {
            "const": "code"
          },
          "scope": {
            "const": "openid profile"
          },
          "state": {
            "maxLength": 128,
            "minLength": 24,
            "type": "string"
          }
        },
        "required": [
          "client_id",
          "redirect_uri",
          "response_type",
          "scope",
          "state",
          "nonce",
          "code_challenge",
          "code_challenge_method"
        ],
        "type": "object"
      },
      "BridgeCredentialRevocationResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "credential_type": {
                "const": "bridge_revocation"
              },
              "generation": {
                "minimum": 1,
                "type": "integer"
              },
              "installation_id": {
                "$ref": "#/components/schemas/BridgeDeviceId"
              },
              "profile_id": {
                "$ref": "#/components/schemas/BridgeDeviceId"
              },
              "revoked": {
                "const": true
              }
            },
            "required": [
              "credential_type",
              "installation_id",
              "profile_id",
              "generation",
              "revoked"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgeDeviceId": {
        "maxLength": 128,
        "minLength": 1,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "type": "string"
      },
      "BridgeInstallationConfirmation": {
        "additionalProperties": false,
        "properties": {
          "authorization_id": {
            "format": "uuid",
            "type": "string"
          },
          "created_at": {
            "format": "date-time",
            "type": "string"
          },
          "current_user": {
            "$ref": "#/components/schemas/BridgeInstallationUser"
          },
          "device_name": {
            "type": "string"
          },
          "expires_at": {
            "format": "date-time",
            "type": "string"
          },
          "installation_id": {
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            "type": "string"
          },
          "revision": {
            "pattern": "^[0-9]+$",
            "type": "string"
          },
          "status": {
            "enum": [
              "pending",
              "approved",
              "denied",
              "expired",
              "revoked"
            ]
          }
        },
        "required": [
          "authorization_id",
          "installation_id",
          "device_name",
          "status",
          "revision",
          "created_at",
          "expires_at",
          "current_user"
        ],
        "type": "object"
      },
      "BridgeInstallationConfirmationResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/BridgeInstallationConfirmation"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgeInstallationDecision": {
        "additionalProperties": false,
        "properties": {
          "current_user_id": {
            "pattern": "^[1-9][0-9]*$",
            "type": "string"
          },
          "decision": {
            "enum": [
              "approved",
              "denied"
            ]
          },
          "expected_revision": {
            "pattern": "^[0-9]+$",
            "type": "string"
          }
        },
        "required": [
          "decision",
          "expected_revision",
          "current_user_id"
        ],
        "type": "object"
      },
      "BridgeInstallationPoll": {
        "additionalProperties": false,
        "properties": {
          "installation_token": {
            "pattern": "^bi4_[A-Za-z0-9_-]{64}$",
            "type": "string"
          },
          "poll_secret": {
            "pattern": "^bip_[A-Za-z0-9_-]{43}$",
            "type": "string"
          }
        },
        "required": [
          "poll_secret",
          "installation_token"
        ],
        "type": "object"
      },
      "BridgeInstallationPolled": {
        "oneOf": [
          {
            "additionalProperties": false,
            "properties": {
              "poll_interval_seconds": {
                "const": 5
              },
              "status": {
                "enum": [
                  "pending",
                  "denied",
                  "expired",
                  "revoked"
                ]
              }
            },
            "required": [
              "status",
              "poll_interval_seconds"
            ],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "authorized": {
                "const": true
              },
              "generation": {
                "minimum": 1,
                "type": "integer"
              },
              "installation_id": {
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
                "type": "string"
              },
              "poll_interval_seconds": {
                "const": 5
              },
              "status": {
                "const": "approved"
              },
              "user": {
                "$ref": "#/components/schemas/BridgeInstallationUser"
              }
            },
            "required": [
              "status",
              "poll_interval_seconds",
              "installation_id",
              "user",
              "generation",
              "authorized"
            ],
            "type": "object"
          }
        ]
      },
      "BridgeInstallationPolledResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/BridgeInstallationPolled"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgeInstallationProfile": {
        "additionalProperties": false,
        "properties": {
          "credential_type": {
            "const": "bridge_refresh"
          },
          "generation": {
            "minimum": 1,
            "type": "integer"
          },
          "installation_id": {
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            "type": "string"
          },
          "profile_id": {
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            "type": "string"
          },
          "session_token_path": {
            "const": "/api/v4/bridge/session-tokens"
          },
          "websocket_path": {
            "const": "/bridge/v4/ws"
          }
        },
        "required": [
          "credential_type",
          "installation_id",
          "profile_id",
          "generation",
          "session_token_path",
          "websocket_path"
        ],
        "type": "object"
      },
      "BridgeInstallationProfileRequest": {
        "additionalProperties": false,
        "properties": {
          "installation_id": {
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            "type": "string"
          },
          "installation_token": {
            "pattern": "^bi4_[A-Za-z0-9_-]{64}$",
            "type": "string"
          },
          "refresh_token": {
            "pattern": "^br4_[A-Za-z0-9_-]{64}$",
            "type": "string"
          },
          "request_key": {
            "pattern": "^[A-Za-z0-9._:-]{16,128}$",
            "type": "string"
          }
        },
        "required": [
          "installation_id",
          "installation_token",
          "request_key",
          "refresh_token"
        ],
        "type": "object"
      },
      "BridgeInstallationProfileResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/BridgeInstallationProfile"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgeInstallationProof": {
        "additionalProperties": false,
        "properties": {
          "installation_id": {
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            "type": "string"
          },
          "installation_token": {
            "pattern": "^bi4_[A-Za-z0-9_-]{64}$",
            "type": "string"
          }
        },
        "required": [
          "installation_id",
          "installation_token"
        ],
        "type": "object"
      },
      "BridgeInstallationRevoked": {
        "additionalProperties": false,
        "properties": {
          "installation_id": {
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            "type": "string"
          },
          "revoked": {
            "const": true
          }
        },
        "required": [
          "installation_id",
          "revoked"
        ],
        "type": "object"
      },
      "BridgeInstallationRevokedResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/BridgeInstallationRevoked"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgeInstallationStart": {
        "additionalProperties": false,
        "properties": {
          "device_name": {
            "maxLength": 120,
            "minLength": 1,
            "pattern": "^[^\\u0000-\\u001f\\u007f]+$",
            "type": "string"
          },
          "installation_id": {
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            "type": "string"
          },
          "installation_token_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "poll_secret_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "request_key": {
            "pattern": "^[A-Za-z0-9._:-]{16,128}$",
            "type": "string"
          }
        },
        "required": [
          "installation_id",
          "device_name",
          "poll_secret_hash",
          "installation_token_hash",
          "request_key"
        ],
        "type": "object"
      },
      "BridgeInstallationStarted": {
        "additionalProperties": false,
        "properties": {
          "authorization_id": {
            "format": "uuid",
            "type": "string"
          },
          "confirmation_path": {
            "pattern": "^/bridge/authorize\\?request=[a-f0-9-]{36}$",
            "type": "string"
          },
          "expires_at": {
            "format": "date-time",
            "type": "string"
          },
          "poll_interval_seconds": {
            "const": 5
          }
        },
        "required": [
          "authorization_id",
          "confirmation_path",
          "expires_at",
          "poll_interval_seconds"
        ],
        "type": "object"
      },
      "BridgeInstallationStartedResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/BridgeInstallationStarted"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgeInstallationStatus": {
        "additionalProperties": false,
        "properties": {
          "authorized": {
            "const": true
          },
          "capacity": {
            "additionalProperties": false,
            "properties": {
              "active": {
                "minimum": 0,
                "type": "integer"
              },
              "available": {
                "minimum": 0,
                "type": "integer"
              },
              "included": {
                "minimum": 0,
                "type": "integer"
              },
              "purchased": {
                "minimum": 0,
                "type": "integer"
              },
              "total": {
                "minimum": 0,
                "type": "integer"
              }
            },
            "required": [
              "included",
              "purchased",
              "total",
              "active",
              "available"
            ],
            "type": "object"
          },
          "generation": {
            "minimum": 1,
            "type": "integer"
          },
          "installation_id": {
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            "type": "string"
          },
          "user": {
            "$ref": "#/components/schemas/BridgeInstallationUser"
          }
        },
        "required": [
          "installation_id",
          "user",
          "generation",
          "authorized",
          "capacity"
        ],
        "type": "object"
      },
      "BridgeInstallationStatusResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/BridgeInstallationStatus"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgeInstallationUser": {
        "additionalProperties": false,
        "properties": {
          "display_name": {
            "type": "string"
          },
          "id": {
            "pattern": "^[1-9][0-9]*$",
            "type": "string"
          }
        },
        "required": [
          "id",
          "display_name"
        ],
        "type": "object"
      },
      "BridgePairingCredentialResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "credential_type": {
                "const": "bridge_refresh"
              },
              "generation": {
                "minimum": 1,
                "type": "integer"
              },
              "installation_id": {
                "$ref": "#/components/schemas/BridgeDeviceId"
              },
              "profile_id": {
                "$ref": "#/components/schemas/BridgeDeviceId"
              },
              "session_token_path": {
                "const": "/api/v4/bridge/session-tokens"
              },
              "websocket_path": {
                "const": "/bridge/v4/ws"
              }
            },
            "required": [
              "credential_type",
              "installation_id",
              "profile_id",
              "generation",
              "session_token_path",
              "websocket_path"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgePairingRedemption": {
        "additionalProperties": false,
        "properties": {
          "installation_id": {
            "$ref": "#/components/schemas/BridgeDeviceId"
          },
          "pairing_code": {
            "maxLength": 47,
            "minLength": 47,
            "pattern": "^bpc_[A-Za-z0-9_-]{43}$",
            "type": "string"
          },
          "refresh_token": {
            "description": "Client-generated CSPRNG 48-byte secret. Persist securely before redemption and reuse for retries.",
            "maxLength": 68,
            "minLength": 68,
            "pattern": "^br4_[A-Za-z0-9_-]{64}$",
            "type": "string"
          }
        },
        "required": [
          "pairing_code",
          "installation_id",
          "refresh_token"
        ],
        "type": "object"
      },
      "BridgePairingRequest": {
        "additionalProperties": false,
        "properties": {
          "code_hash": {
            "description": "SHA-256 of bpc_ plus base64url of 32 cryptographically random bytes, generated in browser memory.",
            "maxLength": 64,
            "minLength": 64,
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          }
        },
        "required": [
          "code_hash"
        ],
        "type": "object"
      },
      "BridgePairingResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "expires_at": {
                "format": "date-time",
                "type": "string"
              },
              "pairing_id": {
                "format": "uuid",
                "type": "string"
              },
              "profile_id": {
                "$ref": "#/components/schemas/BridgeDeviceId"
              }
            },
            "required": [
              "pairing_id",
              "profile_id",
              "expires_at"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgeRefreshCredential": {
        "additionalProperties": false,
        "properties": {
          "credential_type": {
            "const": "bridge_refresh"
          },
          "generation": {
            "minimum": 1,
            "type": "integer"
          },
          "refresh_token": {
            "$ref": "#/components/schemas/BridgeRefreshToken"
          },
          "session_token_path": {
            "const": "/api/v4/bridge/session-tokens"
          },
          "websocket_path": {
            "const": "/bridge/v4/ws"
          }
        },
        "required": [
          "credential_type",
          "refresh_token",
          "generation",
          "session_token_path",
          "websocket_path"
        ],
        "type": "object"
      },
      "BridgeRefreshCredentialResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/BridgeRefreshCredential"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BridgeRefreshToken": {
        "maxLength": 512,
        "minLength": 40,
        "pattern": "^\\S+$",
        "type": "string"
      },
      "BridgeSessionToken": {
        "additionalProperties": false,
        "properties": {
          "access_token": {
            "maxLength": 128,
            "minLength": 40,
            "type": "string"
          },
          "credential_type": {
            "const": "bridge_session"
          },
          "expires_in_seconds": {
            "maximum": 60,
            "minimum": 1,
            "type": "integer"
          },
          "websocket_path": {
            "const": "/bridge/v4/ws"
          }
        },
        "required": [
          "credential_type",
          "access_token",
          "expires_in_seconds",
          "websocket_path"
        ],
        "type": "object"
      },
      "BridgeSessionTokenRequest": {
        "additionalProperties": false,
        "properties": {
          "installation_id": {
            "$ref": "#/components/schemas/BridgeDeviceId"
          },
          "profile_id": {
            "$ref": "#/components/schemas/BridgeDeviceId"
          },
          "refresh_token": {
            "$ref": "#/components/schemas/BridgeRefreshToken"
          }
        },
        "required": [
          "refresh_token",
          "installation_id",
          "profile_id"
        ],
        "type": "object"
      },
      "BridgeSessionTokenResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/BridgeSessionToken"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "BusinessDate": {
        "format": "date",
        "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "CancelOrderCommand": {
        "additionalProperties": false,
        "properties": {
          "command_type": {
            "const": "cancel_order"
          },
          "expected_state": {
            "$ref": "#/components/schemas/ExecutionResourceExpectedState"
          },
          "ticket": {
            "$ref": "#/components/schemas/Ticket"
          }
        },
        "required": [
          "command_type",
          "ticket",
          "expected_state"
        ],
        "type": "object"
      },
      "Candle": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "close": {
            "$ref": "#/components/schemas/Decimal"
          },
          "closed": {
            "type": "boolean"
          },
          "high": {
            "$ref": "#/components/schemas/Decimal"
          },
          "low": {
            "$ref": "#/components/schemas/Decimal"
          },
          "open": {
            "$ref": "#/components/schemas/Decimal"
          },
          "open_time": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "tick_volume": {
            "$ref": "#/components/schemas/Decimal"
          },
          "timeframe": {
            "$ref": "#/components/schemas/Timeframe"
          }
        },
        "required": [
          "account_id",
          "symbol",
          "timeframe",
          "open_time",
          "open",
          "high",
          "low",
          "close",
          "tick_volume",
          "closed",
          "revision"
        ],
        "type": "object"
      },
      "CandleListResponse": {
        "properties": {
          "data": {
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/Candle"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ClosePositionCommand": {
        "additionalProperties": false,
        "properties": {
          "command_type": {
            "const": "close_position"
          },
          "expected_state": {
            "$ref": "#/components/schemas/ExecutionResourceExpectedState"
          },
          "ticket": {
            "$ref": "#/components/schemas/Ticket"
          },
          "volume": {
            "$ref": "#/components/schemas/PositiveDecimal"
          }
        },
        "required": [
          "command_type",
          "ticket",
          "expected_state"
        ],
        "type": "object"
      },
      "ConnectionCapacityResponse": {
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "active": {
                "minimum": 0,
                "type": "integer"
              },
              "available": {
                "minimum": 0,
                "type": "integer"
              },
              "included": {
                "minimum": 0,
                "type": "integer"
              },
              "purchased": {
                "minimum": 0,
                "type": "integer"
              },
              "total": {
                "minimum": 0,
                "type": "integer"
              }
            },
            "required": [
              "included",
              "purchased",
              "total",
              "active",
              "available"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "Decimal": {
        "pattern": "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
        "type": "string"
      },
      "DistributionCloseCommand": {
        "additionalProperties": false,
        "properties": {
          "expected_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "target_ids": {
            "items": {
              "$ref": "#/components/schemas/OpaqueId"
            },
            "maxItems": 10000,
            "type": "array",
            "uniqueItems": true
          }
        },
        "required": [
          "expected_revision",
          "target_ids"
        ],
        "type": "object"
      },
      "DistributionMarketOrderCommand": {
        "additionalProperties": false,
        "properties": {
          "command_type": {
            "const": "market_order"
          },
          "reference_price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "side": {
            "enum": [
              "buy",
              "sell"
            ],
            "type": "string"
          },
          "stop_loss": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "take_profit": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "volume": {
            "$ref": "#/components/schemas/PositiveDecimal"
          }
        },
        "required": [
          "command_type",
          "side",
          "symbol",
          "volume",
          "stop_loss",
          "reference_price"
        ],
        "type": "object"
      },
      "DistributionPendingOrderCommand": {
        "additionalProperties": false,
        "properties": {
          "command_type": {
            "const": "pending_order"
          },
          "expiration_utc_msc": {
            "format": "int64",
            "minimum": 1,
            "type": "integer"
          },
          "order_type": {
            "enum": [
              "buy_limit",
              "sell_limit",
              "buy_stop",
              "sell_stop",
              "buy_stop_limit",
              "sell_stop_limit"
            ],
            "type": "string"
          },
          "price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "reference_price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "stop_limit_price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "stop_loss": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "take_profit": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "volume": {
            "$ref": "#/components/schemas/PositiveDecimal"
          }
        },
        "required": [
          "command_type",
          "order_type",
          "symbol",
          "volume",
          "stop_loss",
          "reference_price",
          "price"
        ],
        "type": "object"
      },
      "EconomicCalendarEvent": {
        "additionalProperties": false,
        "properties": {
          "actual": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "consensus": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "country": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "currency": {
            "maxLength": 16,
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "importance": {
            "enum": [
              "low",
              "medium",
              "high",
              "unknown"
            ],
            "type": "string"
          },
          "period": {
            "maxLength": 128,
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "previous": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "provider_event_id": {
            "maxLength": 191,
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "provider_updated_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "revised_previous": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "scheduled_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "status": {
            "enum": [
              "scheduled",
              "released",
              "revised",
              "delayed",
              "cancelled"
            ],
            "type": "string"
          },
          "time_precision": {
            "enum": [
              "exact",
              "date_only",
              "tentative"
            ],
            "type": "string"
          },
          "title": {
            "maxLength": 300,
            "minLength": 1,
            "type": "string"
          },
          "unit": {
            "maxLength": 64,
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "provider_event_id",
          "country",
          "currency",
          "title",
          "scheduled_at",
          "time_precision",
          "importance",
          "period",
          "unit",
          "previous",
          "consensus",
          "actual",
          "revised_previous",
          "status",
          "provider_updated_at",
          "revision"
        ],
        "type": "object"
      },
      "EconomicCalendarEventListResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "has_more": {
                "type": "boolean"
              },
              "items": {
                "items": {
                  "$ref": "#/components/schemas/EconomicCalendarEvent"
                },
                "type": "array"
              },
              "next_cursor": {
                "maxLength": 2048,
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "items",
              "next_cursor",
              "has_more"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "EconomicCalendarEventResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/EconomicCalendarEvent"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ExecutionCommand": {
        "discriminator": {
          "mapping": {
            "cancel_order": "#/components/schemas/CancelOrderCommand",
            "close_position": "#/components/schemas/ClosePositionCommand",
            "market_order": "#/components/schemas/MarketOrderCommand",
            "modify_order": "#/components/schemas/ModifyOrderCommand",
            "modify_position": "#/components/schemas/ModifyPositionCommand",
            "pending_order": "#/components/schemas/PendingOrderCommand"
          },
          "propertyName": "command_type"
        },
        "oneOf": [
          {
            "$ref": "#/components/schemas/MarketOrderCommand"
          },
          {
            "$ref": "#/components/schemas/PendingOrderCommand"
          },
          {
            "$ref": "#/components/schemas/ModifyPositionCommand"
          },
          {
            "$ref": "#/components/schemas/ClosePositionCommand"
          },
          {
            "$ref": "#/components/schemas/ModifyOrderCommand"
          },
          {
            "$ref": "#/components/schemas/CancelOrderCommand"
          }
        ],
        "unevaluatedProperties": false
      },
      "ExecutionCommandContext": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "expected_state": {
            "$ref": "#/components/schemas/ExecutionExpectedState"
          },
          "instrument": {
            "oneOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "point": {
                    "$ref": "#/components/schemas/PositiveDecimal"
                  },
                  "tick_size": {
                    "$ref": "#/components/schemas/PositiveDecimal"
                  },
                  "tick_value": {
                    "$ref": "#/components/schemas/PositiveDecimal"
                  },
                  "trade_enabled": {
                    "type": "boolean"
                  },
                  "volume_max": {
                    "$ref": "#/components/schemas/PositiveDecimal"
                  },
                  "volume_min": {
                    "$ref": "#/components/schemas/PositiveDecimal"
                  },
                  "volume_step": {
                    "$ref": "#/components/schemas/PositiveDecimal"
                  }
                },
                "required": [
                  "point",
                  "tick_size",
                  "tick_value",
                  "volume_min",
                  "volume_max",
                  "volume_step",
                  "trade_enabled"
                ],
                "type": "object"
              },
              {
                "type": "null"
              }
            ]
          },
          "quote": {
            "oneOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "ask": {
                    "$ref": "#/components/schemas/PositiveDecimal"
                  },
                  "bid": {
                    "$ref": "#/components/schemas/PositiveDecimal"
                  },
                  "observed_at": {
                    "$ref": "#/components/schemas/UtcDateTime"
                  }
                },
                "required": [
                  "bid",
                  "ask",
                  "observed_at"
                ],
                "type": "object"
              },
              {
                "type": "null"
              }
            ]
          },
          "read_only": {
            "type": "boolean"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "target_revision": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ExecutionRevision"
              },
              {
                "type": "null"
              }
            ]
          },
          "ticket": {
            "maxLength": 64,
            "type": [
              "string",
              "null"
            ]
          },
          "trade_permission": {
            "type": "boolean"
          }
        },
        "required": [
          "account_id",
          "symbol",
          "ticket",
          "read_only",
          "trade_permission",
          "expected_state",
          "target_revision",
          "quote",
          "instrument"
        ],
        "type": "object"
      },
      "ExecutionCommandContextResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ExecutionCommandContext"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ExecutionDistribution": {
        "additionalProperties": false,
        "properties": {
          "command": {
            "$ref": "#/components/schemas/ExecutionDistributionCommand"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "strategy_id",
          "command"
        ],
        "type": "object"
      },
      "ExecutionDistributionCommand": {
        "discriminator": {
          "mapping": {
            "market_order": "#/components/schemas/DistributionMarketOrderCommand",
            "pending_order": "#/components/schemas/DistributionPendingOrderCommand"
          },
          "propertyName": "command_type"
        },
        "oneOf": [
          {
            "$ref": "#/components/schemas/DistributionMarketOrderCommand"
          },
          {
            "$ref": "#/components/schemas/DistributionPendingOrderCommand"
          }
        ]
      },
      "ExecutionDistributionDetail": {
        "additionalProperties": false,
        "properties": {
          "command": {
            "additionalProperties": true,
            "type": "object"
          },
          "completed_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "kind": {
            "enum": [
              "manual_order",
              "close"
            ],
            "type": "string"
          },
          "operation_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "result_summary": {
            "additionalProperties": true,
            "type": "object"
          },
          "revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "source_distribution_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "status": {
            "enum": [
              "accepted",
              "queued",
              "running",
              "succeeded",
              "partially_succeeded",
              "rejected",
              "failed",
              "uncertain",
              "cancelled",
              "expired"
            ],
            "type": "string"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "strategy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "target_count": {
            "minimum": 0,
            "type": "integer"
          },
          "targets": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "account_id": {
                  "$ref": "#/components/schemas/OpaqueId"
                },
                "child_operation_id": {
                  "oneOf": [
                    {
                      "$ref": "#/components/schemas/OpaqueId"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "error_code": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "id": {
                  "$ref": "#/components/schemas/OpaqueId"
                },
                "revision": {
                  "$ref": "#/components/schemas/ExecutionRevision"
                },
                "source_ticket": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "status": {
                  "enum": [
                    "queued",
                    "running",
                    "succeeded",
                    "rejected",
                    "failed",
                    "uncertain",
                    "cancelled",
                    "expired"
                  ],
                  "type": "string"
                },
                "subscription_id": {
                  "$ref": "#/components/schemas/OpaqueId"
                }
              },
              "required": [
                "id",
                "account_id",
                "subscription_id",
                "child_operation_id",
                "source_ticket",
                "status",
                "error_code",
                "revision"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "updated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "id",
          "operation_id",
          "strategy_id",
          "strategy_version_id",
          "kind",
          "source_distribution_id",
          "command",
          "status",
          "target_count",
          "result_summary",
          "created_at",
          "updated_at",
          "completed_at",
          "revision",
          "targets"
        ],
        "type": "object"
      },
      "ExecutionDistributionDetailResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ExecutionDistributionDetail"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ExecutionDistributionPreview": {
        "additionalProperties": false,
        "properties": {
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "strategy_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "strategy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "target_count": {
            "minimum": 0,
            "type": "integer"
          },
          "targets": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "account_id": {
                  "$ref": "#/components/schemas/OpaqueId"
                },
                "missing_resources": {
                  "items": {
                    "enum": [
                      "account",
                      "positions",
                      "pending_orders",
                      "quote",
                      "contract",
                      "risk"
                    ],
                    "type": "string"
                  },
                  "type": "array"
                },
                "ready": {
                  "type": "boolean"
                },
                "subscription_id": {
                  "$ref": "#/components/schemas/OpaqueId"
                },
                "trade_permission": {
                  "type": "boolean"
                }
              },
              "required": [
                "account_id",
                "subscription_id",
                "trade_permission",
                "ready",
                "missing_resources"
              ],
              "type": "object"
            },
            "type": "array"
          }
        },
        "required": [
          "strategy_id",
          "strategy_version_id",
          "strategy_revision",
          "symbol",
          "target_count",
          "targets"
        ],
        "type": "object"
      },
      "ExecutionDistributionPreviewResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ExecutionDistributionPreview"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ExecutionExpectedState": {
        "additionalProperties": false,
        "properties": {
          "account_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "contract_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "pending_orders_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "positions_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "quote_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "risk_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          }
        },
        "required": [
          "account_revision",
          "positions_revision",
          "pending_orders_revision",
          "quote_revision",
          "contract_revision",
          "risk_revision"
        ],
        "type": "object"
      },
      "ExecutionResourceExpectedState": {
        "additionalProperties": false,
        "properties": {
          "account_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "contract_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "pending_orders_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "positions_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "quote_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          },
          "resource_revision": {
            "allOf": [
              {
                "$ref": "#/components/schemas/ExecutionRevision"
              }
            ],
            "pattern": "^[1-9][0-9]*$"
          },
          "risk_revision": {
            "$ref": "#/components/schemas/ExecutionRevision"
          }
        },
        "required": [
          "account_revision",
          "positions_revision",
          "pending_orders_revision",
          "quote_revision",
          "contract_revision",
          "risk_revision",
          "resource_revision"
        ],
        "type": "object"
      },
      "ExecutionRevision": {
        "maxLength": 128,
        "minLength": 1,
        "pattern": "^[0-9]+$",
        "type": "string"
      },
      "FieldProblem": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "maxLength": 128,
            "type": "string"
          },
          "field": {
            "maxLength": 256,
            "type": "string"
          },
          "message": {
            "maxLength": 512,
            "type": "string"
          }
        },
        "required": [
          "field",
          "code",
          "message"
        ],
        "type": "object"
      },
      "LearningCompletionRequest": {
        "additionalProperties": false,
        "properties": {
          "completed": {
            "type": "boolean"
          },
          "expected_revision": {
            "description": "Exact unsigned revision text, at most 18446744073709551614.",
            "maxLength": 20,
            "not": {
              "pattern": "[^0-9]"
            },
            "pattern": "^(?:0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|18446744073709550[0-9]{3}|18446744073709551[0-5][0-9]{2}|1844674407370955160[0-9]{1}|1844674407370955161[0-3]|18446744073709551614)$",
            "type": "string"
          }
        },
        "required": [
          "completed",
          "expected_revision"
        ],
        "type": "object"
      },
      "LearningCompletionResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "completed": {
                "type": "boolean"
              },
              "lesson_id": {
                "pattern": "^[1-9][0-9]*$",
                "type": "string"
              },
              "replayed": {
                "type": "boolean"
              },
              "revision": {
                "maxLength": 20,
                "not": {
                  "pattern": "[^0-9]"
                },
                "pattern": "^[1-9][0-9]*$",
                "type": "string"
              },
              "updated_at": {
                "format": "date-time",
                "pattern": "Z$",
                "type": "string"
              }
            },
            "required": [
              "lesson_id",
              "completed",
              "revision",
              "updated_at",
              "replayed"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "LearningCourse": {
        "additionalProperties": false,
        "properties": {
          "access_level": {
            "enum": [
              "free",
              "logged_in",
              "plus_pro",
              "pro_only",
              null
            ]
          },
          "category": {
            "type": [
              "string",
              "null"
            ]
          },
          "description": {
            "type": [
              "string",
              "null"
            ]
          },
          "id": {
            "pattern": "^[1-9][0-9]*$",
            "type": "string"
          },
          "sort_order": {
            "type": "integer"
          },
          "title": {
            "type": "string"
          },
          "updated_at": {
            "format": "date-time",
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "title",
          "description",
          "category",
          "access_level",
          "updated_at",
          "sort_order"
        ],
        "type": "object"
      },
      "LearningDetailResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "access": {
                      "enum": [
                        "login_required",
                        "membership_required"
                      ]
                    }
                  }
                },
                "then": {
                  "properties": {
                    "lessons": {
                      "maxItems": 0
                    }
                  }
                }
              }
            ],
            "properties": {
              "access": {
                "enum": [
                  "allowed",
                  "login_required",
                  "membership_required"
                ]
              },
              "course": {
                "$ref": "#/components/schemas/LearningCourse"
              },
              "lessons": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "duration_ms": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "id": {
                      "type": "string"
                    },
                    "progress": {
                      "additionalProperties": false,
                      "properties": {
                        "completed": {
                          "type": [
                            "boolean",
                            "null"
                          ]
                        },
                        "reported_duration_ms": {
                          "type": [
                            "string",
                            "null"
                          ]
                        },
                        "revision": {
                          "maxLength": 20,
                          "not": {
                            "pattern": "[^0-9]"
                          },
                          "pattern": "^[1-9][0-9]*$",
                          "type": "string"
                        },
                        "updated_at": {
                          "format": "date-time",
                          "type": [
                            "string",
                            "null"
                          ]
                        },
                        "watched_ms": {
                          "type": [
                            "string",
                            "null"
                          ]
                        }
                      },
                      "required": [
                        "watched_ms",
                        "reported_duration_ms",
                        "completed",
                        "updated_at",
                        "revision"
                      ],
                      "type": [
                        "object",
                        "null"
                      ]
                    },
                    "resources": {
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "kind": {
                            "type": "string"
                          },
                          "url": {
                            "format": "uri",
                            "pattern": "^https://",
                            "type": "string"
                          }
                        },
                        "required": [
                          "kind",
                          "url"
                        ],
                        "type": "object"
                      },
                      "type": "array"
                    },
                    "title": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "id",
                    "title",
                    "duration_ms",
                    "progress",
                    "resources"
                  ],
                  "type": "object"
                },
                "maxItems": 100,
                "type": "array"
              },
              "lessons_truncated": {
                "type": "boolean"
              },
              "viewer_user_id": {
                "pattern": "^[1-9][0-9]*$",
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "course",
              "access",
              "lessons",
              "lessons_truncated",
              "viewer_user_id"
            ],
            "type": "object"
          },
          "meta": {
            "additionalProperties": false,
            "properties": {
              "generated_at": {
                "format": "date-time",
                "type": "string"
              },
              "request_id": {
                "type": "string"
              }
            },
            "required": [
              "request_id",
              "generated_at"
            ],
            "type": "object"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "LearningListResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/LearningCourse"
                },
                "maxItems": 20,
                "type": "array"
              },
              "next_cursor": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "items",
              "next_cursor"
            ],
            "type": "object"
          },
          "meta": {
            "additionalProperties": false,
            "properties": {
              "generated_at": {
                "format": "date-time",
                "type": "string"
              },
              "request_id": {
                "type": "string"
              }
            },
            "required": [
              "request_id",
              "generated_at"
            ],
            "type": "object"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "LegacyBridgeCredentialExchange": {
        "additionalProperties": false,
        "properties": {
          "installation_id": {
            "$ref": "#/components/schemas/BridgeDeviceId"
          },
          "legacy_refresh_token": {
            "$ref": "#/components/schemas/BridgeRefreshToken"
          },
          "profile_id": {
            "$ref": "#/components/schemas/BridgeDeviceId"
          },
          "schema_version": {
            "const": 1
          },
          "source_fingerprint": {
            "pattern": "^sha256:[0-9a-f]{64}$",
            "type": "string"
          }
        },
        "required": [
          "schema_version",
          "legacy_refresh_token",
          "installation_id",
          "profile_id",
          "source_fingerprint"
        ],
        "type": "object"
      },
      "LegacyReviewContent": {
        "additionalProperties": false,
        "properties": {
          "original_content_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": [
              "string",
              "null"
            ]
          },
          "raw_text": {
            "maxLength": 16777215,
            "type": "string"
          },
          "schema_version": {
            "const": "review.legacy.v1",
            "type": "string"
          },
          "source_id": {
            "pattern": "^[1-9][0-9]{0,19}$",
            "type": "string"
          },
          "source_sha256": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "source_table": {
            "enum": [
              "period_review_versions",
              "manual_trade_review_versions",
              "trade_review_versions"
            ],
            "type": "string"
          }
        },
        "required": [
          "schema_version",
          "source_table",
          "source_id",
          "source_sha256",
          "original_content_hash",
          "raw_text"
        ],
        "type": "object"
      },
      "MacroFactor": {
        "additionalProperties": false,
        "properties": {
          "available_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "code": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "freshness": {
            "enum": [
              "fresh",
              "stale",
              "missing",
              "disabled",
              "invalid"
            ],
            "type": "string"
          },
          "gold_relation": {
            "enum": [
              "supportive",
              "adverse",
              "neutral",
              "uncertain"
            ],
            "type": "string"
          },
          "label": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "observation_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "unit": {
            "maxLength": 64,
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "value": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "code",
          "label",
          "value",
          "unit",
          "observation_at",
          "available_at",
          "freshness",
          "gold_relation"
        ],
        "type": "object"
      },
      "MacroMarketOverviewResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "high_impact_events": {
                "items": {
                  "$ref": "#/components/schemas/EconomicCalendarEvent"
                },
                "maxItems": 20,
                "type": "array"
              },
              "snapshot": {
                "oneOf": [
                  {
                    "$ref": "#/components/schemas/MacroSnapshotSummary"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "snapshot",
              "high_impact_events"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "MacroSeriesPoint": {
        "additionalProperties": false,
        "properties": {
          "available_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "code": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "freshness": {
            "enum": [
              "fresh",
              "stale",
              "missing",
              "disabled",
              "invalid"
            ],
            "type": "string"
          },
          "observation_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "unit": {
            "maxLength": 64,
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "value": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "code",
          "observation_at",
          "available_at",
          "value",
          "unit",
          "freshness"
        ],
        "type": "object"
      },
      "MacroSeriesResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "has_more": {
                "type": "boolean"
              },
              "items": {
                "items": {
                  "$ref": "#/components/schemas/MacroSeriesPoint"
                },
                "type": "array"
              },
              "next_cursor": {
                "maxLength": 2048,
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "items",
              "next_cursor",
              "has_more"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "MacroSnapshot": {
        "additionalProperties": false,
        "properties": {
          "business_date": {
            "$ref": "#/components/schemas/BusinessDate"
          },
          "content_sha256": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "data_cutoff_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "direction": {
            "enum": [
              "supportive",
              "adverse",
              "neutral",
              "uncertain"
            ],
            "type": "string"
          },
          "factors": {
            "items": {
              "$ref": "#/components/schemas/MacroFactor"
            },
            "maxItems": 128,
            "type": "array"
          },
          "horizon": {
            "const": "medium_term"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "published_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "schema_version": {
            "minimum": 1,
            "type": "integer"
          },
          "status": {
            "enum": [
              "fresh",
              "stale",
              "partial",
              "unavailable"
            ],
            "type": "string"
          },
          "summary": {
            "maxLength": 5000,
            "minLength": 1,
            "type": "string"
          },
          "valid_until": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "id",
          "schema_version",
          "revision",
          "business_date",
          "horizon",
          "data_cutoff_at",
          "published_at",
          "valid_until",
          "status",
          "direction",
          "summary",
          "factors",
          "content_sha256"
        ],
        "type": "object"
      },
      "MacroSnapshotListResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "has_more": {
                "type": "boolean"
              },
              "items": {
                "items": {
                  "$ref": "#/components/schemas/MacroSnapshotSummary"
                },
                "type": "array"
              },
              "next_cursor": {
                "maxLength": 2048,
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "items",
              "next_cursor",
              "has_more"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "MacroSnapshotResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/MacroSnapshot"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "MacroSnapshotSummary": {
        "additionalProperties": false,
        "properties": {
          "business_date": {
            "$ref": "#/components/schemas/BusinessDate"
          },
          "content_sha256": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "data_cutoff_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "direction": {
            "enum": [
              "supportive",
              "adverse",
              "neutral",
              "uncertain"
            ],
            "type": "string"
          },
          "factor_count": {
            "maximum": 128,
            "minimum": 0,
            "type": "integer"
          },
          "horizon": {
            "const": "medium_term"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "published_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "schema_version": {
            "minimum": 1,
            "type": "integer"
          },
          "status": {
            "enum": [
              "fresh",
              "stale",
              "partial",
              "unavailable"
            ],
            "type": "string"
          },
          "summary": {
            "maxLength": 5000,
            "minLength": 1,
            "type": "string"
          },
          "valid_until": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "id",
          "schema_version",
          "revision",
          "business_date",
          "horizon",
          "data_cutoff_at",
          "published_at",
          "valid_until",
          "status",
          "direction",
          "summary",
          "factor_count",
          "content_sha256"
        ],
        "type": "object"
      },
      "ManualReleaseAvailability": {
        "additionalProperties": false,
        "properties": {
          "available": {
            "type": "boolean"
          },
          "code": {
            "maxLength": 128,
            "type": [
              "string",
              "null"
            ]
          },
          "expires_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "policy_set_revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "risk_state_revision": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Revision"
              },
              {
                "type": "null"
              }
            ]
          },
          "rules": {
            "items": {
              "enum": [
                "RISK_DAILY_LOSS_LIMIT",
                "RISK_DRAWDOWN_LIMIT",
                "RISK_DAILY_OPEN_LIMIT",
                "RISK_CONSECUTIVE_LOSS_LIMIT",
                "RISK_COOLDOWN_ACTIVE"
              ],
              "type": "string"
            },
            "type": "array",
            "uniqueItems": true
          }
        },
        "required": [
          "available",
          "code",
          "rules",
          "expires_at",
          "policy_set_revision",
          "risk_state_revision"
        ],
        "type": "object"
      },
      "ManualReviewCandidate": {
        "additionalProperties": false,
        "properties": {
          "account_label": {
            "type": "string"
          },
          "closed_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "eligibility_status": {
            "enum": [
              "eligible",
              "incomplete",
              "already_reviewed"
            ],
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "net_profit": {
            "$ref": "#/components/schemas/Decimal"
          },
          "opened_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "position_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "selection_expires_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "selection_token": {
            "minLength": 24,
            "type": "string"
          },
          "side": {
            "enum": [
              "buy",
              "sell"
            ],
            "type": "string"
          },
          "source_classification": {
            "enum": [
              "manual",
              "system",
              "other_ea",
              "unknown"
            ],
            "type": "string"
          },
          "symbol": {
            "type": "string"
          },
          "terminal_timezone_offset_minutes": {
            "maximum": 840,
            "minimum": -840,
            "type": "integer"
          },
          "ticket": {
            "type": "string"
          },
          "trading_account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "volume": {
            "$ref": "#/components/schemas/Decimal"
          }
        },
        "required": [
          "id",
          "trading_account_id",
          "account_label",
          "ticket",
          "position_id",
          "symbol",
          "side",
          "volume",
          "opened_at",
          "closed_at",
          "net_profit",
          "terminal_timezone_offset_minutes",
          "source_classification",
          "eligibility_status",
          "selection_token",
          "selection_expires_at",
          "revision"
        ],
        "type": "object"
      },
      "ManualReviewCandidateListResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/ManualReviewCandidate"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ManualReviewCaseInput": {
        "additionalProperties": false,
        "properties": {
          "candidate_ids": {
            "items": {
              "$ref": "#/components/schemas/OpaqueId"
            },
            "maxItems": 20,
            "minItems": 1,
            "type": "array"
          },
          "selection_tokens": {
            "items": {
              "minLength": 24,
              "type": "string"
            },
            "maxItems": 20,
            "minItems": 1,
            "type": "array"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "user_thesis": {
            "maxLength": 2000,
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "candidate_ids",
          "selection_tokens",
          "strategy_id"
        ],
        "type": "object"
      },
      "ManualRiskRelease": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "account_policy_version_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "baseline": {
            "$ref": "#/components/schemas/ManualRiskReleaseBaseline"
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "expires_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "invalidated_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "invalidation_reason": {
            "maxLength": 128,
            "type": [
              "string",
              "null"
            ]
          },
          "manual_release_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "platform_policy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "policy_set_revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "reason": {
            "maxLength": 500,
            "minLength": 3,
            "type": "string"
          },
          "released_rules": {
            "items": {
              "enum": [
                "RISK_DAILY_LOSS_LIMIT",
                "RISK_DRAWDOWN_LIMIT",
                "RISK_DAILY_OPEN_LIMIT",
                "RISK_CONSECUTIVE_LOSS_LIMIT",
                "RISK_COOLDOWN_ACTIVE"
              ],
              "type": "string"
            },
            "minItems": 1,
            "type": "array",
            "uniqueItems": true
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "risk_state_revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "status": {
            "enum": [
              "active",
              "superseded",
              "expired",
              "revoked"
            ],
            "type": "string"
          }
        },
        "required": [
          "manual_release_id",
          "account_id",
          "platform_policy_version_id",
          "account_policy_version_id",
          "policy_set_revision",
          "status",
          "released_rules",
          "baseline",
          "risk_state_revision",
          "reason",
          "expires_at",
          "created_at",
          "invalidated_at",
          "invalidation_reason",
          "revision"
        ],
        "type": "object"
      },
      "ManualRiskReleaseBaseline": {
        "additionalProperties": false,
        "properties": {
          "business_date": {
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
            "type": "string"
          },
          "consecutive_losses": {
            "minimum": 0,
            "type": "integer"
          },
          "cooldown_until": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "daily_loss_percent": {
            "$ref": "#/components/schemas/Decimal"
          },
          "daily_open_count": {
            "minimum": 0,
            "type": "integer"
          },
          "drawdown_percent": {
            "$ref": "#/components/schemas/Decimal"
          }
        },
        "required": [
          "business_date",
          "daily_loss_percent",
          "drawdown_percent",
          "daily_open_count",
          "consecutive_losses",
          "cooldown_until"
        ],
        "type": "object"
      },
      "ManualRiskReleaseCreatedResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ManualRiskRelease"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ManualRiskReleaseInput": {
        "additionalProperties": false,
        "properties": {
          "acknowledge_risk": {
            "const": true
          },
          "reason": {
            "maxLength": 500,
            "minLength": 3,
            "type": "string"
          }
        },
        "required": [
          "acknowledge_risk",
          "reason"
        ],
        "type": "object"
      },
      "ManualRiskReleaseReceiptResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "oneOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "release": {
                    "type": "null"
                  },
                  "state": {
                    "const": "unconfirmed"
                  }
                },
                "required": [
                  "state",
                  "release"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "release": {
                    "$ref": "#/components/schemas/ManualRiskRelease"
                  },
                  "state": {
                    "const": "confirmed"
                  }
                },
                "required": [
                  "state",
                  "release"
                ],
                "type": "object"
              }
            ]
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ManualRiskReleaseResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ManualRiskReleaseState"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ManualRiskReleaseState": {
        "additionalProperties": false,
        "properties": {
          "availability": {
            "$ref": "#/components/schemas/ManualReleaseAvailability"
          },
          "release": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ManualRiskRelease"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "release",
          "availability"
        ],
        "type": "object"
      },
      "MarketAnalysisDetail": {
        "additionalProperties": false,
        "properties": {
          "analysis_body": {
            "type": "string"
          },
          "bearish_score": {
            "maximum": 100,
            "minimum": 0,
            "type": [
              "number",
              "null"
            ]
          },
          "bullish_score": {
            "maximum": 100,
            "minimum": 0,
            "type": [
              "number",
              "null"
            ]
          },
          "chart": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "bars": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "close": {
                        "type": "number"
                      },
                      "closed": {
                        "type": "boolean"
                      },
                      "high": {
                        "type": "number"
                      },
                      "low": {
                        "type": "number"
                      },
                      "open": {
                        "type": "number"
                      },
                      "time": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "time",
                      "open",
                      "high",
                      "low",
                      "close",
                      "closed"
                    ],
                    "type": "object"
                  },
                  "type": "array"
                },
                "lines": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "end": {
                        "type": "number"
                      },
                      "from": {
                        "type": "string"
                      },
                      "kind": {
                        "type": "string"
                      },
                      "start": {
                        "type": "number"
                      },
                      "to": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "kind",
                      "from",
                      "to",
                      "start",
                      "end"
                    ],
                    "type": "object"
                  },
                  "type": "array"
                },
                "timeframe": {
                  "type": "string"
                }
              },
              "required": [
                "timeframe",
                "bars",
                "lines"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "counter_evidence": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "data_gaps": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "input_snapshot_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "invalidation": {
            "additionalProperties": true,
            "type": "object"
          },
          "key_levels": {
            "additionalProperties": true,
            "type": "object"
          },
          "market_regime": {
            "maxLength": 128,
            "type": "string"
          },
          "summary": {
            "$ref": "#/components/schemas/MarketAnalysisSummary"
          },
          "supporting_evidence": {
            "items": {
              "type": "string"
            },
            "type": "array"
          }
        },
        "required": [
          "summary",
          "market_regime",
          "supporting_evidence",
          "counter_evidence",
          "key_levels",
          "invalidation",
          "data_gaps",
          "analysis_body",
          "input_snapshot_hash"
        ],
        "type": "object"
      },
      "MarketAnalysisDetailResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/MarketAnalysisDetail"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "MarketAnalysisListResponse": {
        "properties": {
          "data": {
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/MarketAnalysisSummary"
                },
                "type": "array"
              },
              "next_cursor": {
                "maxLength": 2048,
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "items",
              "next_cursor"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "MarketAnalysisSummary": {
        "additionalProperties": false,
        "properties": {
          "analysis_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "analyzed_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "confidence": {
            "maximum": 100,
            "minimum": 0,
            "type": "number"
          },
          "market_bias": {
            "enum": [
              "bullish",
              "bearish",
              "neutral",
              "uncertain"
            ],
            "type": "string"
          },
          "opportunity": {
            "enum": [
              "none",
              "long_setup",
              "short_setup"
            ],
            "type": "string"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "strategy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "summary": {
            "maxLength": 2000,
            "type": "string"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "valid_until": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "analysis_id",
          "strategy_id",
          "strategy_version_id",
          "symbol",
          "market_bias",
          "opportunity",
          "confidence",
          "summary",
          "analyzed_at",
          "valid_until",
          "revision"
        ],
        "type": "object"
      },
      "MarketOrderCommand": {
        "additionalProperties": false,
        "properties": {
          "command_type": {
            "const": "market_order"
          },
          "expected_state": {
            "$ref": "#/components/schemas/ExecutionExpectedState"
          },
          "reference_price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "side": {
            "enum": [
              "buy",
              "sell"
            ],
            "type": "string"
          },
          "stop_loss": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "take_profit": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "volume": {
            "$ref": "#/components/schemas/PositiveDecimal"
          }
        },
        "required": [
          "command_type",
          "side",
          "symbol",
          "volume",
          "stop_loss",
          "reference_price",
          "expected_state"
        ],
        "type": "object"
      },
      "Meta": {
        "additionalProperties": false,
        "properties": {
          "generated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "request_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "request_id",
          "generated_at"
        ],
        "type": "object"
      },
      "ModelAssignmentsResponse": {
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "analysis": {
                "pattern": "^[1-9][0-9]*$",
                "type": [
                  "string",
                  "null"
                ]
              },
              "review": {
                "pattern": "^[1-9][0-9]*$",
                "type": [
                  "string",
                  "null"
                ]
              },
              "revision": {
                "pattern": "^[0-9]+$",
                "type": "string"
              },
              "trader": {
                "pattern": "^[1-9][0-9]*$",
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "analysis",
              "trader",
              "review",
              "revision"
            ],
            "type": "object"
          },
          "meta": {
            "properties": {
              "generated_at": {
                "type": "string"
              },
              "request_id": {
                "type": "string"
              }
            },
            "required": [
              "request_id",
              "generated_at"
            ],
            "type": "object"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ModelConfiguration": {
        "additionalProperties": false,
        "properties": {
          "base_url": {
            "type": "string"
          },
          "context_window_tokens": {
            "maximum": 2147483647,
            "minimum": 1,
            "type": [
              "integer",
              "null"
            ]
          },
          "has_key": {
            "type": "boolean"
          },
          "id": {
            "type": "string"
          },
          "max_input_tokens": {
            "maximum": 2147483647,
            "minimum": 1,
            "type": [
              "integer",
              "null"
            ]
          },
          "max_output_tokens": {
            "maximum": 2147483647,
            "minimum": 1,
            "type": [
              "integer",
              "null"
            ]
          },
          "max_tokens": {
            "type": [
              "integer",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "protocol": {
            "enum": [
              "chat_completions",
              "responses"
            ],
            "type": "string"
          },
          "provider": {
            "type": "string"
          },
          "reasoning_effort": {
            "enum": [
              null,
              "low",
              "medium",
              "high",
              "max"
            ],
            "type": [
              "string",
              "null"
            ]
          },
          "request_timeout_ms": {
            "maximum": 600000,
            "minimum": 1000,
            "type": [
              "integer",
              "null"
            ]
          },
          "revision": {
            "type": "string"
          },
          "scope": {
            "enum": [
              "user",
              "platform"
            ],
            "type": "string"
          },
          "temperature": {
            "maximum": 2,
            "minimum": 0,
            "type": [
              "number",
              "null"
            ]
          },
          "thinking_enabled": {
            "type": "boolean"
          },
          "verified": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "name",
          "provider",
          "scope",
          "base_url",
          "protocol",
          "max_tokens",
          "has_key",
          "verified",
          "revision"
        ],
        "type": "object"
      },
      "ModelConfigurationListResponse": {
        "properties": {
          "data": {
            "items": {
              "$ref": "#/components/schemas/ModelConfiguration"
            },
            "type": "array"
          },
          "meta": {
            "properties": {
              "generated_at": {
                "type": "string"
              },
              "request_id": {
                "type": "string"
              }
            },
            "required": [
              "request_id",
              "generated_at"
            ],
            "type": "object"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ModelConfigurationResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ModelConfiguration"
          },
          "meta": {
            "properties": {
              "generated_at": {
                "type": "string"
              },
              "request_id": {
                "type": "string"
              }
            },
            "required": [
              "request_id",
              "generated_at"
            ],
            "type": "object"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ModelDeletedResponse": {
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "deleted": {
                "type": "boolean"
              },
              "id": {
                "type": "string"
              }
            },
            "required": [
              "id",
              "deleted"
            ],
            "type": "object"
          },
          "meta": {
            "properties": {
              "generated_at": {
                "type": "string"
              },
              "request_id": {
                "type": "string"
              }
            },
            "required": [
              "request_id",
              "generated_at"
            ],
            "type": "object"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ModelSelectionResponse": {
        "properties": {
          "data": {
            "properties": {
              "items": {
                "items": {
                  "properties": {
                    "available": {
                      "type": "boolean"
                    },
                    "id": {
                      "type": "string"
                    },
                    "name": {
                      "type": "string"
                    },
                    "reason": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "scope": {
                      "enum": [
                        "user",
                        "platform"
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "name",
                    "scope",
                    "available",
                    "reason"
                  ],
                  "type": "object"
                },
                "type": "array"
              },
              "selected_model_profile_id": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "selected_model_profile_id",
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ModifyOrderCommand": {
        "additionalProperties": false,
        "anyOf": [
          {
            "required": [
              "price"
            ]
          },
          {
            "required": [
              "stop_limit_price"
            ]
          },
          {
            "required": [
              "stop_loss"
            ]
          },
          {
            "required": [
              "remove_stop_loss"
            ]
          },
          {
            "required": [
              "take_profit"
            ]
          },
          {
            "required": [
              "remove_take_profit"
            ]
          },
          {
            "required": [
              "expiration_utc_msc"
            ]
          },
          {
            "required": [
              "remove_expiration"
            ]
          }
        ],
        "not": {
          "anyOf": [
            {
              "required": [
                "stop_loss",
                "remove_stop_loss"
              ]
            },
            {
              "required": [
                "take_profit",
                "remove_take_profit"
              ]
            },
            {
              "required": [
                "expiration_utc_msc",
                "remove_expiration"
              ]
            }
          ]
        },
        "properties": {
          "command_type": {
            "const": "modify_order"
          },
          "expected_state": {
            "$ref": "#/components/schemas/ExecutionResourceExpectedState"
          },
          "expiration_utc_msc": {
            "format": "int64",
            "minimum": 1,
            "type": "integer"
          },
          "price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "remove_expiration": {
            "const": true
          },
          "remove_stop_loss": {
            "const": true
          },
          "remove_take_profit": {
            "const": true
          },
          "stop_limit_price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "stop_loss": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "take_profit": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "ticket": {
            "$ref": "#/components/schemas/Ticket"
          }
        },
        "required": [
          "command_type",
          "ticket",
          "expected_state"
        ],
        "type": "object"
      },
      "ModifyPositionCommand": {
        "additionalProperties": false,
        "anyOf": [
          {
            "required": [
              "stop_loss"
            ]
          },
          {
            "required": [
              "remove_stop_loss"
            ]
          },
          {
            "required": [
              "take_profit"
            ]
          },
          {
            "required": [
              "remove_take_profit"
            ]
          }
        ],
        "not": {
          "anyOf": [
            {
              "required": [
                "stop_loss",
                "remove_stop_loss"
              ]
            },
            {
              "required": [
                "take_profit",
                "remove_take_profit"
              ]
            }
          ]
        },
        "properties": {
          "command_type": {
            "const": "modify_position"
          },
          "expected_state": {
            "$ref": "#/components/schemas/ExecutionResourceExpectedState"
          },
          "remove_stop_loss": {
            "const": true
          },
          "remove_take_profit": {
            "const": true
          },
          "stop_loss": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "take_profit": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "ticket": {
            "$ref": "#/components/schemas/Ticket"
          }
        },
        "required": [
          "command_type",
          "ticket",
          "expected_state"
        ],
        "type": "object"
      },
      "ObserverAccessAdminItem": {
        "additionalProperties": false,
        "properties": {
          "granted_at_utc": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "granted_by_user_id": {
            "oneOf": [
              {
                "maximum": 2147483647,
                "minimum": 1,
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "observer_channel_id": {
            "$ref": "#/components/schemas/ObserverUnsignedId"
          },
          "revision": {
            "pattern": "^[1-9][0-9]*$",
            "type": "string"
          },
          "revoked_at_utc": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "user_id": {
            "maximum": 2147483647,
            "minimum": 1,
            "type": "integer"
          }
        },
        "required": [
          "observer_channel_id",
          "user_id",
          "granted_at_utc",
          "revoked_at_utc",
          "granted_by_user_id",
          "revision"
        ],
        "type": "object"
      },
      "ObserverAccessInput": {
        "additionalProperties": false,
        "properties": {
          "expected_revision": {
            "$ref": "#/components/schemas/ObserverRevisionInput"
          },
          "granted": {
            "type": "boolean"
          }
        },
        "required": [
          "granted",
          "expected_revision"
        ],
        "type": "object"
      },
      "ObserverAccessPage": {
        "additionalProperties": false,
        "properties": {
          "items": {
            "items": {
              "$ref": "#/components/schemas/ObserverAccessAdminItem"
            },
            "type": "array"
          },
          "next_cursor": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "registry_revision": {
            "pattern": "^[0-9]+$",
            "type": "string"
          }
        },
        "required": [
          "items",
          "next_cursor",
          "registry_revision"
        ],
        "type": "object"
      },
      "ObserverAccessPageResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ObserverAccessPage"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ObserverChannelAdminItem": {
        "additionalProperties": false,
        "properties": {
          "active": {
            "type": "boolean"
          },
          "audience": {
            "enum": [
              "all",
              "plus",
              "pro",
              "assigned"
            ],
            "type": "string"
          },
          "created_at_utc": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "description": {
            "maxLength": 255,
            "type": [
              "string",
              "null"
            ]
          },
          "display_name": {
            "maxLength": 80,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/ObserverUnsignedId"
          },
          "is_default": {
            "type": "boolean"
          },
          "revision": {
            "pattern": "^[1-9][0-9]*$",
            "type": "string"
          },
          "slug": {
            "maxLength": 64,
            "type": "string"
          },
          "sort_order": {
            "maximum": 1000000,
            "minimum": 0,
            "type": "integer"
          },
          "source_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "source_trading_account_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "updated_at_utc": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "source_id",
          "source_trading_account_id",
          "display_name",
          "slug",
          "description",
          "audience",
          "active",
          "is_default",
          "sort_order",
          "created_at_utc",
          "updated_at_utc",
          "revision"
        ],
        "type": "object"
      },
      "ObserverChannelCreateInput": {
        "additionalProperties": false,
        "properties": {
          "active": {
            "const": false,
            "default": false,
            "type": "boolean"
          },
          "audience": {
            "default": "assigned",
            "enum": [
              "all",
              "plus",
              "pro",
              "assigned"
            ],
            "type": "string"
          },
          "description": {
            "default": null,
            "maxLength": 255,
            "type": [
              "string",
              "null"
            ]
          },
          "display_name": {
            "maxLength": 80,
            "minLength": 1,
            "type": "string"
          },
          "slug": {
            "maxLength": 64,
            "minLength": 1,
            "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            "type": "string"
          },
          "sort_order": {
            "default": 0,
            "maximum": 1000000,
            "minimum": 0,
            "type": "integer"
          },
          "source_id": {
            "default": null,
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "display_name",
          "slug"
        ],
        "type": "object"
      },
      "ObserverChannelListResponse": {
        "description": "Authenticated active users only. Source/channel must be ready and aligned. Audience all, exact effective plus/pro plan, or an explicit active grant authorizes reading; pro does not inherit plus. This never grants trading rights. Observer HTTP reads return a sanitized publication, not operator metadata or private history.",
        "properties": {
          "data": {
            "properties": {
              "items": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "active": {
                      "type": "boolean"
                    },
                    "display_name": {
                      "type": "string"
                    },
                    "id": {
                      "$ref": "#/components/schemas/OpaqueId"
                    },
                    "source_account_id": {
                      "$ref": "#/components/schemas/OpaqueId"
                    }
                  },
                  "required": [
                    "id",
                    "display_name",
                    "source_account_id",
                    "active"
                  ],
                  "type": "object"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ObserverChannelPage": {
        "additionalProperties": false,
        "properties": {
          "items": {
            "items": {
              "$ref": "#/components/schemas/ObserverChannelAdminItem"
            },
            "type": "array"
          },
          "next_cursor": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "registry_revision": {
            "pattern": "^[0-9]+$",
            "type": "string"
          }
        },
        "required": [
          "items",
          "next_cursor",
          "registry_revision"
        ],
        "type": "object"
      },
      "ObserverChannelPageResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ObserverChannelPage"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ObserverChannelUpdateInput": {
        "additionalProperties": false,
        "properties": {
          "active": {
            "type": "boolean"
          },
          "audience": {
            "enum": [
              "all",
              "plus",
              "pro",
              "assigned"
            ],
            "type": "string"
          },
          "description": {
            "maxLength": 255,
            "type": [
              "string",
              "null"
            ]
          },
          "display_name": {
            "maxLength": 80,
            "minLength": 1,
            "type": "string"
          },
          "expected_revision": {
            "$ref": "#/components/schemas/ObserverRevisionInput"
          },
          "slug": {
            "maxLength": 64,
            "minLength": 1,
            "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            "type": "string"
          },
          "sort_order": {
            "maximum": 1000000,
            "minimum": 0,
            "type": "integer"
          },
          "source_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "display_name",
          "source_id",
          "slug",
          "description",
          "audience",
          "active",
          "sort_order",
          "expected_revision"
        ],
        "type": "object"
      },
      "ObserverDefaultChannelInput": {
        "additionalProperties": false,
        "properties": {
          "channel_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "expected_revision": {
            "$ref": "#/components/schemas/ObserverRevisionInput"
          }
        },
        "required": [
          "channel_id",
          "expected_revision"
        ],
        "type": "object"
      },
      "ObserverManagementWriteResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ObserverManagementWriteResult"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ObserverManagementWriteResult": {
        "additionalProperties": false,
        "properties": {
          "operation_id": {
            "format": "uuid",
            "type": "string"
          },
          "registry_revision": {
            "pattern": "^[0-9]+$",
            "type": "string"
          },
          "revision": {
            "pattern": "^[0-9]+$",
            "type": "string"
          },
          "target_id": {
            "type": "string"
          }
        },
        "required": [
          "operation_id",
          "target_id",
          "revision",
          "registry_revision"
        ],
        "type": "object"
      },
      "ObserverOperationAdminItem": {
        "additionalProperties": false,
        "properties": {
          "action": {
            "maxLength": 40,
            "type": "string"
          },
          "actor_user_id": {
            "maximum": 2147483647,
            "minimum": 1,
            "type": "integer"
          },
          "audit_json": {
            "description": "Canonical observer-management command; returned only from the admin-only operation endpoint.",
            "type": "object"
          },
          "created_at_utc": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "id": {
            "format": "uuid",
            "type": "string"
          },
          "result": {
            "$ref": "#/components/schemas/ObserverManagementWriteResult"
          },
          "target_id": {
            "maxLength": 191,
            "type": "string"
          }
        },
        "required": [
          "id",
          "action",
          "actor_user_id",
          "target_id",
          "result",
          "audit_json",
          "created_at_utc"
        ],
        "type": "object"
      },
      "ObserverOperationPage": {
        "additionalProperties": false,
        "properties": {
          "items": {
            "items": {
              "$ref": "#/components/schemas/ObserverOperationAdminItem"
            },
            "type": "array"
          },
          "next_cursor": {
            "oneOf": [
              {
                "format": "uuid",
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "registry_revision": {
            "pattern": "^[0-9]+$",
            "type": "string"
          }
        },
        "required": [
          "items",
          "next_cursor",
          "registry_revision"
        ],
        "type": "object"
      },
      "ObserverOperationPageResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ObserverOperationPage"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ObserverRevisionInput": {
        "description": "A JSON integer or its decimal string representation. Updates require at least 1; access creation and registry CAS may use 0.",
        "oneOf": [
          {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          {
            "pattern": "^(?:0|[1-9][0-9]{0,15})$",
            "type": "string"
          }
        ]
      },
      "ObserverSourceAdminItem": {
        "additionalProperties": false,
        "properties": {
          "analysis_strategy_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "configuration_status": {
            "enum": [
              "pending",
              "ready"
            ],
            "type": "string"
          },
          "created_at_utc": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "created_by_user_id": {
            "maximum": 2147483647,
            "minimum": 1,
            "type": "integer"
          },
          "display_name": {
            "maxLength": 80,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/ObserverUnsignedId"
          },
          "notes": {
            "maxLength": 255,
            "type": [
              "string",
              "null"
            ]
          },
          "operator_user_id": {
            "maximum": 2147483647,
            "minimum": 1,
            "type": "integer"
          },
          "revision": {
            "pattern": "^[1-9][0-9]*$",
            "type": "string"
          },
          "status": {
            "enum": [
              "active",
              "disabled"
            ],
            "type": "string"
          },
          "trading_account_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "updated_at_utc": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "id",
          "display_name",
          "notes",
          "operator_user_id",
          "trading_account_id",
          "analysis_strategy_id",
          "status",
          "configuration_status",
          "created_by_user_id",
          "created_at_utc",
          "updated_at_utc",
          "revision"
        ],
        "type": "object"
      },
      "ObserverSourceCreateInput": {
        "additionalProperties": false,
        "properties": {
          "analysis_strategy_id": {
            "default": null,
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "display_name": {
            "maxLength": 80,
            "minLength": 1,
            "type": "string"
          },
          "notes": {
            "default": null,
            "maxLength": 255,
            "type": [
              "string",
              "null"
            ]
          },
          "status": {
            "const": "disabled",
            "default": "disabled",
            "type": "string"
          },
          "trading_account_id": {
            "default": null,
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "display_name"
        ],
        "type": "object"
      },
      "ObserverSourcePage": {
        "additionalProperties": false,
        "properties": {
          "items": {
            "items": {
              "$ref": "#/components/schemas/ObserverSourceAdminItem"
            },
            "type": "array"
          },
          "next_cursor": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "registry_revision": {
            "pattern": "^[0-9]+$",
            "type": "string"
          }
        },
        "required": [
          "items",
          "next_cursor",
          "registry_revision"
        ],
        "type": "object"
      },
      "ObserverSourcePageResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ObserverSourcePage"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ObserverSourceUpdateInput": {
        "additionalProperties": false,
        "properties": {
          "analysis_strategy_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          },
          "display_name": {
            "maxLength": 80,
            "minLength": 1,
            "type": "string"
          },
          "expected_revision": {
            "$ref": "#/components/schemas/ObserverRevisionInput"
          },
          "notes": {
            "maxLength": 255,
            "type": [
              "string",
              "null"
            ]
          },
          "status": {
            "enum": [
              "active",
              "disabled"
            ],
            "type": "string"
          },
          "trading_account_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ObserverUnsignedId"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "display_name",
          "notes",
          "trading_account_id",
          "analysis_strategy_id",
          "status",
          "expected_revision"
        ],
        "type": "object"
      },
      "ObserverUnsignedId": {
        "description": "Positive decimal identifier bounded by the target unsigned BIGINT range (1..18446744073709551615).",
        "maxLength": 20,
        "pattern": "^[1-9][0-9]{0,19}$",
        "type": "string"
      },
      "OpaqueId": {
        "maxLength": 191,
        "minLength": 1,
        "type": "string"
      },
      "Operation": {
        "additionalProperties": false,
        "properties": {
          "accepted_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "completed_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "distribution_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "error_code": {
            "maxLength": 128,
            "type": [
              "string",
              "null"
            ]
          },
          "kind": {
            "maxLength": 128,
            "type": "string"
          },
          "operation_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "parent_operation_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "resource_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "result_summary": {
            "additionalProperties": true,
            "type": [
              "object",
              "null"
            ]
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "status": {
            "enum": [
              "accepted",
              "queued",
              "running",
              "succeeded",
              "partially_succeeded",
              "rejected",
              "failed",
              "uncertain",
              "cancelled",
              "expired"
            ],
            "type": "string"
          },
          "updated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "operation_id",
          "kind",
          "status",
          "accepted_at",
          "updated_at",
          "revision"
        ],
        "type": "object"
      },
      "OperationResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/Operation"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "PageMeta": {
        "additionalProperties": false,
        "properties": {
          "generated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "has_more": {
            "type": "boolean"
          },
          "next_cursor": {
            "type": [
              "string",
              "null"
            ]
          },
          "page_size": {
            "maximum": 500,
            "minimum": 0,
            "type": "integer"
          },
          "request_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "request_id",
          "generated_at",
          "page_size",
          "next_cursor",
          "has_more"
        ],
        "type": "object"
      },
      "PendingOrder": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "expires_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "price": {
            "$ref": "#/components/schemas/Decimal"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "signal_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "source": {
            "enum": [
              "manual",
              "signal",
              "unknown"
            ],
            "type": "string"
          },
          "stop_loss": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "take_profit": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "ticket": {
            "$ref": "#/components/schemas/Ticket"
          },
          "type": {
            "enum": [
              "buy_limit",
              "sell_limit",
              "buy_stop",
              "sell_stop",
              "buy_stop_limit",
              "sell_stop_limit"
            ],
            "type": "string"
          },
          "volume": {
            "$ref": "#/components/schemas/Decimal"
          }
        },
        "required": [
          "ticket",
          "account_id",
          "symbol",
          "type",
          "volume",
          "price",
          "stop_loss",
          "take_profit",
          "created_at",
          "expires_at",
          "source",
          "signal_id",
          "revision"
        ],
        "type": "object"
      },
      "PendingOrderCommand": {
        "additionalProperties": false,
        "properties": {
          "command_type": {
            "const": "pending_order"
          },
          "expected_state": {
            "$ref": "#/components/schemas/ExecutionExpectedState"
          },
          "expiration_utc_msc": {
            "format": "int64",
            "minimum": 1,
            "type": "integer"
          },
          "order_type": {
            "enum": [
              "buy_limit",
              "sell_limit",
              "buy_stop",
              "sell_stop",
              "buy_stop_limit",
              "sell_stop_limit"
            ],
            "type": "string"
          },
          "price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "reference_price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "stop_limit_price": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "stop_loss": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "take_profit": {
            "$ref": "#/components/schemas/PositiveDecimal"
          },
          "volume": {
            "$ref": "#/components/schemas/PositiveDecimal"
          }
        },
        "required": [
          "command_type",
          "order_type",
          "symbol",
          "volume",
          "stop_loss",
          "reference_price",
          "price",
          "expected_state"
        ],
        "type": "object"
      },
      "Position": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "current_price": {
            "$ref": "#/components/schemas/Decimal"
          },
          "floating_profit": {
            "$ref": "#/components/schemas/Decimal"
          },
          "open_price": {
            "$ref": "#/components/schemas/Decimal"
          },
          "opened_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "side": {
            "enum": [
              "buy",
              "sell"
            ],
            "type": "string"
          },
          "signal_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "source": {
            "enum": [
              "manual",
              "signal",
              "unknown"
            ],
            "type": "string"
          },
          "stop_loss": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "take_profit": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "ticket": {
            "$ref": "#/components/schemas/Ticket"
          },
          "volume": {
            "$ref": "#/components/schemas/Decimal"
          }
        },
        "required": [
          "ticket",
          "account_id",
          "symbol",
          "side",
          "volume",
          "open_price",
          "current_price",
          "stop_loss",
          "take_profit",
          "floating_profit",
          "opened_at",
          "source",
          "revision"
        ],
        "type": "object"
      },
      "PositionListResponse": {
        "properties": {
          "data": {
            "items": {
              "$ref": "#/components/schemas/Position"
            },
            "type": "array"
          },
          "meta": {
            "$ref": "#/components/schemas/PageMeta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "PositiveDecimal": {
        "pattern": "^(?:(?:[1-9][0-9]*)(?:\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$",
        "type": "string"
      },
      "Problem": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "pattern": "^[a-z][a-z0-9_]{1,127}$",
            "type": "string"
          },
          "correlation_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "detail": {
            "maxLength": 2048,
            "type": "string"
          },
          "errors": {
            "items": {
              "$ref": "#/components/schemas/FieldProblem"
            },
            "maxItems": 50,
            "type": "array"
          },
          "instance": {
            "maxLength": 2048,
            "type": "string"
          },
          "retry_after_ms": {
            "minimum": 0,
            "type": "integer"
          },
          "retryable": {
            "type": "boolean"
          },
          "status": {
            "maximum": 599,
            "minimum": 400,
            "type": "integer"
          },
          "title": {
            "maxLength": 256,
            "type": "string"
          },
          "type": {
            "format": "uri-reference",
            "type": "string"
          }
        },
        "required": [
          "type",
          "title",
          "status",
          "code",
          "detail",
          "instance",
          "correlation_id",
          "retryable"
        ],
        "type": "object"
      },
      "PublicMarketCandle": {
        "additionalProperties": false,
        "properties": {
          "close": {
            "$ref": "#/components/schemas/Decimal"
          },
          "closed": {
            "type": "boolean"
          },
          "high": {
            "$ref": "#/components/schemas/Decimal"
          },
          "low": {
            "$ref": "#/components/schemas/Decimal"
          },
          "open": {
            "$ref": "#/components/schemas/Decimal"
          },
          "open_time": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "tick_volume": {
            "$ref": "#/components/schemas/Decimal"
          }
        },
        "required": [
          "open_time",
          "open",
          "high",
          "low",
          "close",
          "tick_volume",
          "closed",
          "revision"
        ],
        "type": "object"
      },
      "PublicMarketQuote": {
        "additionalProperties": false,
        "properties": {
          "ask": {
            "$ref": "#/components/schemas/Decimal"
          },
          "bid": {
            "$ref": "#/components/schemas/Decimal"
          },
          "last": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "observed_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "spread": {
            "$ref": "#/components/schemas/Decimal"
          }
        },
        "required": [
          "bid",
          "ask",
          "spread",
          "observed_at",
          "revision"
        ],
        "type": "object"
      },
      "PublicMarketSnapshotResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "candles": {
                "items": {
                  "$ref": "#/components/schemas/PublicMarketCandle"
                },
                "maxItems": 500,
                "type": "array"
              },
              "quote": {
                "oneOf": [
                  {
                    "$ref": "#/components/schemas/PublicMarketQuote"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "source_generation": {
                "oneOf": [
                  {
                    "$ref": "#/components/schemas/Revision"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "source_key": {
                "oneOf": [
                  {
                    "pattern": "^[a-f0-9]{64}$",
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "status": {
                "enum": [
                  "cached",
                  "unavailable"
                ],
                "type": "string"
              },
              "structure": {
                "oneOf": [
                  {
                    "$ref": "#/components/schemas/PublicMarketStructure"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "symbol": {
                "$ref": "#/components/schemas/Symbol"
              },
              "timeframe": {
                "$ref": "#/components/schemas/Timeframe"
              }
            },
            "required": [
              "symbol",
              "timeframe",
              "source_key",
              "source_generation",
              "status",
              "quote",
              "candles",
              "structure"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "PublicMarketStructure": {
        "additionalProperties": false,
        "properties": {
          "algorithm": {
            "enum": [
              "chan_structure_v8"
            ],
            "type": "string"
          },
          "based_on_closed_bars": {
            "maximum": 2000,
            "minimum": 0,
            "type": "integer"
          },
          "lines": {
            "items": {
              "$ref": "#/components/schemas/PublicMarketStructureLine"
            },
            "maxItems": 32,
            "type": "array"
          },
          "reliability": {
            "enum": [
              "high",
              "medium",
              "low"
            ],
            "type": "string"
          },
          "status": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "trend": {
            "additionalProperties": false,
            "properties": {
              "confidence": {
                "enum": [
                  "high",
                  "medium",
                  "low"
                ],
                "type": "string"
              },
              "direction": {
                "enum": [
                  "up",
                  "down",
                  "neutral"
                ],
                "type": "string"
              },
              "phase": {
                "maxLength": 64,
                "minLength": 1,
                "type": "string"
              },
              "reason": {
                "maxLength": 128,
                "minLength": 1,
                "type": "string"
              },
              "state": {
                "maxLength": 64,
                "minLength": 1,
                "type": "string"
              }
            },
            "required": [
              "state",
              "direction",
              "phase",
              "confidence",
              "reason"
            ],
            "type": [
              "object",
              "null"
            ]
          }
        },
        "required": [
          "algorithm",
          "status",
          "reliability",
          "based_on_closed_bars",
          "lines"
        ],
        "type": "object"
      },
      "PublicMarketStructureLine": {
        "additionalProperties": false,
        "properties": {
          "end": {
            "type": "number"
          },
          "from": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "kind": {
            "enum": [
              "bi",
              "segment",
              "forming_segment",
              "center",
              "bi_center",
              "fractal_top",
              "fractal_bottom"
            ],
            "type": "string"
          },
          "start": {
            "type": "number"
          },
          "to": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "kind",
          "from",
          "to",
          "start",
          "end"
        ],
        "type": "object"
      },
      "PublicMarketSymbolsResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "pattern": "^[A-Z0-9]{1,32}$",
                  "type": "string"
                },
                "maxItems": 32,
                "type": "array",
                "uniqueItems": true
              },
              "market_states": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "checked_at": {
                      "format": "date-time",
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "reason": {
                      "pattern": "^[a-z_]{3,64}$",
                      "type": "string"
                    },
                    "state": {
                      "enum": [
                        "open",
                        "closed",
                        "restricted",
                        "stale",
                        "unknown"
                      ],
                      "type": "string"
                    },
                    "symbol": {
                      "pattern": "^[A-Z0-9]{1,32}$",
                      "type": "string"
                    }
                  },
                  "required": [
                    "symbol",
                    "state",
                    "reason",
                    "checked_at"
                  ],
                  "type": "object"
                },
                "maxItems": 32,
                "type": "array"
              },
              "timezone": {
                "additionalProperties": false,
                "properties": {
                  "checked_at": {
                    "format": "date-time",
                    "type": "string"
                  },
                  "offset_minutes": {
                    "maximum": 840,
                    "minimum": -720,
                    "type": "integer"
                  },
                  "status": {
                    "enum": [
                      "calibrated",
                      "stale"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "offset_minutes",
                  "checked_at",
                  "status"
                ],
                "type": [
                  "object",
                  "null"
                ]
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "Quote": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "ask": {
            "$ref": "#/components/schemas/Decimal"
          },
          "bid": {
            "$ref": "#/components/schemas/Decimal"
          },
          "last": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "observed_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "spread": {
            "$ref": "#/components/schemas/Decimal"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "trade_mode": {
            "enum": [
              "full",
              "long_only",
              "short_only",
              "close_only",
              "disabled",
              "unknown"
            ],
            "type": "string"
          }
        },
        "required": [
          "account_id",
          "symbol",
          "bid",
          "ask",
          "spread",
          "observed_at",
          "revision"
        ],
        "type": "object"
      },
      "QuoteResponse": {
        "properties": {
          "data": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Quote"
              },
              {
                "type": "null"
              }
            ]
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "RealtimeTicket": {
        "additionalProperties": false,
        "properties": {
          "capabilities": {
            "items": {
              "maxLength": 64,
              "type": "string"
            },
            "type": "array",
            "uniqueItems": true
          },
          "expires_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "protocol": {
            "const": "aurum.realtime.v4"
          },
          "ws_url": {
            "pattern": "^/realtime/v4$",
            "type": "string"
          }
        },
        "required": [
          "ws_url",
          "protocol",
          "expires_at",
          "capabilities"
        ],
        "type": "object"
      },
      "RealtimeTicketResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/RealtimeTicket"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ReviewCaseDetail": {
        "additionalProperties": false,
        "properties": {
          "current_job": {
            "additionalProperties": true,
            "type": [
              "object",
              "null"
            ]
          },
          "current_version": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ReviewVersion"
              },
              {
                "type": "null"
              }
            ]
          },
          "return_reason": {
            "type": [
              "string",
              "null"
            ]
          },
          "sources": {
            "items": {
              "additionalProperties": true,
              "type": "object"
            },
            "type": "array"
          },
          "summary": {
            "$ref": "#/components/schemas/ReviewCaseSummary"
          }
        },
        "required": [
          "summary",
          "current_version",
          "sources",
          "current_job",
          "return_reason"
        ],
        "type": "object"
      },
      "ReviewCaseDetailResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ReviewCaseDetail"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ReviewCaseListResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/ReviewCaseSummary"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ReviewCaseSummary": {
        "additionalProperties": false,
        "properties": {
          "account_label": {
            "type": "string"
          },
          "analysis_strategy_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "analysis_strategy_name": {
            "type": [
              "string",
              "null"
            ]
          },
          "confirmed_version_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "current_version_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "evidence_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": [
              "string",
              "null"
            ]
          },
          "evidence_revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "evidence_status": {
            "enum": [
              "pending",
              "incomplete",
              "complete",
              "stale"
            ],
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "kind": {
            "enum": [
              "daily",
              "monthly",
              "manual",
              "trade"
            ],
            "type": "string"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "status": {
            "enum": [
              "awaiting_evidence",
              "queued",
              "running",
              "awaiting_confirmation",
              "needs_changes",
              "confirmed",
              "failed",
              "archived"
            ],
            "type": "string"
          },
          "subscription_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "subscription_revision": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Revision"
              },
              {
                "type": "null"
              }
            ]
          },
          "symbol": {
            "type": [
              "string",
              "null"
            ]
          },
          "terminal_period_end": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "terminal_period_start": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "terminal_timezone_offset_minutes": {
            "maximum": 840,
            "minimum": -840,
            "type": "integer"
          },
          "trader_strategy_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "trader_strategy_name": {
            "type": [
              "string",
              "null"
            ]
          },
          "trading_account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "updated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "user_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "id",
          "kind",
          "user_id",
          "trading_account_id",
          "account_label",
          "symbol",
          "subscription_id",
          "subscription_revision",
          "analysis_strategy_id",
          "analysis_strategy_name",
          "trader_strategy_id",
          "trader_strategy_name",
          "terminal_period_start",
          "terminal_period_end",
          "terminal_timezone_offset_minutes",
          "status",
          "evidence_status",
          "evidence_revision",
          "evidence_hash",
          "current_version_id",
          "confirmed_version_id",
          "updated_at",
          "revision"
        ],
        "type": "object"
      },
      "ReviewContent": {
        "additionalProperties": false,
        "properties": {
          "conclusion": {
            "enum": [
              "effective",
              "mixed",
              "ineffective",
              "insufficient_evidence",
              "manual_trade_reviewed"
            ],
            "type": "string"
          },
          "counterexamples": {
            "items": {
              "additionalProperties": true,
              "type": "object"
            },
            "type": "array"
          },
          "evidence_refs": {
            "items": {
              "$ref": "#/components/schemas/OpaqueId"
            },
            "type": "array"
          },
          "full_analysis_text": {
            "maxLength": 500000,
            "type": "string"
          },
          "headline": {
            "maxLength": 300,
            "type": "string"
          },
          "memory_candidates": {
            "items": {
              "$ref": "#/components/schemas/ReviewMemoryCandidate"
            },
            "type": "array"
          },
          "metrics": {
            "additionalProperties": false,
            "properties": {
              "net_profit": {
                "oneOf": [
                  {
                    "$ref": "#/components/schemas/Decimal"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "profit_factor": {
                "oneOf": [
                  {
                    "$ref": "#/components/schemas/Decimal"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "trade_count": {
                "minimum": 0,
                "type": "integer"
              },
              "win_rate_percent": {
                "oneOf": [
                  {
                    "$ref": "#/components/schemas/Decimal"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "net_profit",
              "trade_count",
              "win_rate_percent",
              "profit_factor"
            ],
            "type": "object"
          },
          "roles": {
            "additionalProperties": false,
            "properties": {
              "analyst": {
                "$ref": "#/components/schemas/ReviewRoleResult"
              },
              "execution": {
                "$ref": "#/components/schemas/ReviewRoleResult"
              },
              "risk": {
                "$ref": "#/components/schemas/ReviewRoleResult"
              },
              "trader": {
                "$ref": "#/components/schemas/ReviewRoleResult"
              }
            },
            "required": [
              "analyst",
              "trader",
              "risk",
              "execution"
            ],
            "type": "object"
          },
          "schema_version": {
            "const": "review.v4.1"
          },
          "summary": {
            "maxLength": 5000,
            "type": "string"
          },
          "trade_episodes": {
            "items": {
              "additionalProperties": true,
              "type": "object"
            },
            "type": "array"
          }
        },
        "required": [
          "schema_version",
          "conclusion",
          "headline",
          "summary",
          "metrics",
          "trade_episodes",
          "roles",
          "counterexamples",
          "memory_candidates",
          "evidence_refs",
          "full_analysis_text"
        ],
        "type": "object"
      },
      "ReviewHistoricalMetadata": {
        "additionalProperties": false,
        "properties": {
          "review_case_id": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "source_evidence_status": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "source_id": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "source_status": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "source_strategy_id": {
            "maxLength": 191,
            "type": [
              "string",
              "null"
            ]
          },
          "source_strategy_version": {
            "maxLength": 191,
            "type": [
              "string",
              "null"
            ]
          },
          "source_table": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "timezone_source": {
            "enum": [
              "legacy_evidence",
              "legacy_case",
              "default_utc_plus_3"
            ],
            "type": "string"
          }
        },
        "required": [
          "review_case_id",
          "source_table",
          "source_id",
          "source_status",
          "source_evidence_status",
          "source_strategy_id",
          "source_strategy_version",
          "timezone_source"
        ],
        "type": "object"
      },
      "ReviewHistoricalMetadataResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ReviewHistoricalMetadata"
              },
              {
                "type": "null"
              }
            ]
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ReviewMemoryCandidate": {
        "additionalProperties": false,
        "properties": {
          "content": {
            "maxLength": 20000,
            "type": "string"
          },
          "evidence_refs": {
            "items": {
              "$ref": "#/components/schemas/OpaqueId"
            },
            "type": "array"
          },
          "memory_key": {
            "pattern": "^[a-z0-9][a-z0-9._:-]{2,190}$",
            "type": "string"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "title": {
            "maxLength": 300,
            "type": "string"
          },
          "update_kind": {
            "enum": [
              "short_term",
              "long_term_candidate",
              "monthly_summary",
              "platform_candidate"
            ],
            "type": "string"
          }
        },
        "required": [
          "strategy_id",
          "memory_key",
          "update_kind",
          "title",
          "content",
          "evidence_refs"
        ],
        "type": "object"
      },
      "ReviewRoleResult": {
        "additionalProperties": false,
        "properties": {
          "assessment": {
            "enum": [
              "effective",
              "mixed",
              "problem",
              "insufficient_evidence",
              "not_applicable"
            ],
            "type": "string"
          },
          "evidence_refs": {
            "items": {
              "$ref": "#/components/schemas/OpaqueId"
            },
            "type": "array"
          },
          "summary": {
            "maxLength": 5000,
            "type": "string"
          }
        },
        "required": [
          "assessment",
          "summary",
          "evidence_refs"
        ],
        "type": "object"
      },
      "ReviewVersion": {
        "additionalProperties": false,
        "oneOf": [
          {
            "properties": {
              "conclusion": {
                "type": "null"
              },
              "content": {
                "$ref": "#/components/schemas/LegacyReviewContent"
              }
            }
          },
          {
            "properties": {
              "conclusion": {
                "type": "string"
              },
              "content": {
                "$ref": "#/components/schemas/ReviewContent"
              }
            }
          }
        ],
        "properties": {
          "author_kind": {
            "enum": [
              "ai",
              "user"
            ],
            "type": "string"
          },
          "conclusion": {
            "enum": [
              "effective",
              "mixed",
              "ineffective",
              "insufficient_evidence",
              "manual_trade_reviewed",
              null
            ],
            "type": [
              "string",
              "null"
            ]
          },
          "content": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/ReviewContent"
              },
              {
                "$ref": "#/components/schemas/LegacyReviewContent"
              }
            ]
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "review_case_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "version": {
            "minimum": 1,
            "type": "integer"
          }
        },
        "required": [
          "id",
          "review_case_id",
          "version",
          "author_kind",
          "conclusion",
          "content",
          "created_at"
        ],
        "type": "object"
      },
      "ReviewVersionHistoryResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/ReviewVersionSummary"
                },
                "maxItems": 100,
                "type": "array"
              },
              "next_before_version": {
                "maximum": 4294967295,
                "minimum": 1,
                "type": [
                  "integer",
                  "null"
                ]
              }
            },
            "required": [
              "items",
              "next_before_version"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ReviewVersionResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ReviewVersion"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "ReviewVersionSummary": {
        "additionalProperties": false,
        "properties": {
          "author_kind": {
            "enum": [
              "ai",
              "user"
            ],
            "type": "string"
          },
          "conclusion": {
            "enum": [
              "effective",
              "mixed",
              "ineffective",
              "insufficient_evidence",
              "manual_trade_reviewed",
              null
            ],
            "type": [
              "string",
              "null"
            ]
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "review_case_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "version": {
            "minimum": 1,
            "type": "integer"
          }
        },
        "required": [
          "id",
          "review_case_id",
          "version",
          "author_kind",
          "conclusion",
          "created_at"
        ],
        "type": "object"
      },
      "Revision": {
        "maxLength": 128,
        "minLength": 1,
        "type": "string"
      },
      "RiskDecisionDetail": {
        "additionalProperties": false,
        "properties": {
          "approved_actions": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "action_id": {
                  "$ref": "#/components/schemas/OpaqueId"
                },
                "expected_state": {
                  "additionalProperties": true,
                  "type": "object"
                },
                "kind": {
                  "enum": [
                    "market_order",
                    "pending_order",
                    "modify_position",
                    "close_position",
                    "modify_order",
                    "cancel_order"
                  ],
                  "type": "string"
                },
                "parameters": {
                  "additionalProperties": true,
                  "type": "object"
                }
              },
              "required": [
                "action_id",
                "kind",
                "parameters",
                "expected_state"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "evaluated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "policy_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "rules": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "action_id": {
                  "oneOf": [
                    {
                      "$ref": "#/components/schemas/OpaqueId"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "code": {
                  "maxLength": 128,
                  "type": "string"
                },
                "details": {
                  "additionalProperties": true,
                  "type": "object"
                },
                "outcome": {
                  "enum": [
                    "passed",
                    "rejected",
                    "not_applicable"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "code",
                "outcome",
                "action_id",
                "details"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "summary": {
            "$ref": "#/components/schemas/RiskDecisionSummary"
          }
        },
        "required": [
          "summary",
          "rules",
          "approved_actions",
          "evaluated_at",
          "policy_hash"
        ],
        "type": "object"
      },
      "RiskDecisionDetailResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/RiskDecisionDetail"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "RiskDecisionListResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/RiskDecisionSummary"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "RiskDecisionSummary": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "account_policy_version_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "account_risk_revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "manual_release_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "platform_policy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "reject_code": {
            "maxLength": 128,
            "type": [
              "string",
              "null"
            ]
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "risk_decision_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "status": {
            "enum": [
              "approved",
              "rejected"
            ],
            "type": "string"
          },
          "trade_decision_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "risk_decision_id",
          "trade_decision_id",
          "account_id",
          "status",
          "reject_code",
          "platform_policy_version_id",
          "account_policy_version_id",
          "account_risk_revision",
          "manual_release_id",
          "created_at",
          "revision"
        ],
        "type": "object"
      },
      "RiskPolicy": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "account_kill_switch": {
            "type": "boolean"
          },
          "account_policy_version_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "allowed_symbols": {
            "items": {
              "maxLength": 64,
              "minLength": 1,
              "type": "string"
            },
            "minItems": 1,
            "readOnly": true,
            "type": "array",
            "uniqueItems": true
          },
          "consecutive_loss_limit": {
            "minimum": 0,
            "type": "integer"
          },
          "editable_fields": {
            "items": {
              "maxLength": 64,
              "type": "string"
            },
            "type": "array",
            "uniqueItems": true
          },
          "fail_closed_on_incomplete_data": {
            "const": true,
            "readOnly": true
          },
          "global_kill_switch": {
            "readOnly": true,
            "type": "boolean"
          },
          "loss_cooldown_minutes": {
            "minimum": 0,
            "type": "integer"
          },
          "manual_release_consecutive_loss_limit": {
            "minimum": 0,
            "readOnly": true,
            "type": "integer"
          },
          "manual_release_enabled": {
            "readOnly": true,
            "type": "boolean"
          },
          "manual_release_max_daily_loss_percent": {
            "$ref": "#/components/schemas/Decimal",
            "readOnly": true
          },
          "manual_release_max_daily_open_count": {
            "minimum": 0,
            "readOnly": true,
            "type": "integer"
          },
          "manual_release_max_drawdown_percent": {
            "$ref": "#/components/schemas/Decimal",
            "readOnly": true
          },
          "max_daily_loss_percent": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_daily_open_count": {
            "minimum": 0,
            "type": "integer"
          },
          "max_decision_age_seconds": {
            "minimum": 1,
            "readOnly": true,
            "type": "integer"
          },
          "max_drawdown_percent": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_open_positions": {
            "minimum": 0,
            "type": "integer"
          },
          "max_order_volume": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_pending_orders": {
            "minimum": 0,
            "type": "integer"
          },
          "max_price_deviation_percent": {
            "$ref": "#/components/schemas/Decimal",
            "readOnly": true
          },
          "max_quote_age_seconds": {
            "minimum": 1,
            "readOnly": true,
            "type": "integer"
          },
          "max_risk_per_trade_percent": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_risk_summary_age_seconds": {
            "minimum": 1,
            "readOnly": true,
            "type": "integer"
          },
          "max_spread_points": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_total_volume": {
            "$ref": "#/components/schemas/Decimal"
          },
          "min_open_interval_seconds": {
            "minimum": 0,
            "type": "integer"
          },
          "numeric_controls": {
            "additionalProperties": {
              "additionalProperties": false,
              "properties": {
                "allowed_max": {
                  "$ref": "#/components/schemas/Decimal"
                },
                "allowed_min": {
                  "$ref": "#/components/schemas/Decimal"
                },
                "locked_value": {
                  "anyOf": [
                    {
                      "$ref": "#/components/schemas/Decimal"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "user_editable": {
                  "type": "boolean"
                }
              },
              "required": [
                "allowed_min",
                "allowed_max",
                "locked_value",
                "user_editable"
              ],
              "type": "object"
            },
            "type": "object"
          },
          "pending_dedup_atr_multiplier": {
            "description": "System-only pending-order price tolerance in ATR units. Optional for older V4 responses; not an account-editable field.",
            "pattern": "^(?:[0-4](?:\\.[0-9]+)?|5(?:\\.0+)?)$",
            "type": "string"
          },
          "pending_valid_minutes": {
            "minimum": 1,
            "type": "integer"
          },
          "platform_policy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "require_stop_loss": {
            "const": true
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "trade_send_enabled": {
            "type": "boolean"
          },
          "updated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "weekend_close_minutes": {
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": [
          "account_id",
          "platform_policy_version_id",
          "account_policy_version_id",
          "global_kill_switch",
          "allowed_symbols",
          "fail_closed_on_incomplete_data",
          "max_quote_age_seconds",
          "max_risk_summary_age_seconds",
          "max_decision_age_seconds",
          "max_price_deviation_percent",
          "manual_release_enabled",
          "manual_release_max_daily_loss_percent",
          "manual_release_max_drawdown_percent",
          "manual_release_max_daily_open_count",
          "manual_release_consecutive_loss_limit",
          "max_risk_per_trade_percent",
          "max_daily_loss_percent",
          "max_drawdown_percent",
          "max_open_positions",
          "max_pending_orders",
          "max_total_volume",
          "max_spread_points",
          "min_open_interval_seconds",
          "max_daily_open_count",
          "consecutive_loss_limit",
          "loss_cooldown_minutes",
          "pending_valid_minutes",
          "weekend_close_minutes",
          "trade_send_enabled",
          "account_kill_switch",
          "require_stop_loss",
          "editable_fields",
          "revision",
          "updated_at"
        ],
        "type": "object"
      },
      "RiskPolicyInput": {
        "additionalProperties": false,
        "properties": {
          "account_kill_switch": {
            "type": "boolean"
          },
          "consecutive_loss_limit": {
            "maximum": 1000,
            "minimum": 0,
            "type": "integer"
          },
          "loss_cooldown_minutes": {
            "maximum": 10080,
            "minimum": 0,
            "type": "integer"
          },
          "max_daily_loss_percent": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_daily_open_count": {
            "maximum": 10000,
            "minimum": 0,
            "type": "integer"
          },
          "max_drawdown_percent": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_open_positions": {
            "maximum": 1000,
            "minimum": 0,
            "type": "integer"
          },
          "max_order_volume": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_pending_orders": {
            "maximum": 1000,
            "minimum": 0,
            "type": "integer"
          },
          "max_risk_per_trade_percent": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_spread_points": {
            "$ref": "#/components/schemas/Decimal"
          },
          "max_total_volume": {
            "$ref": "#/components/schemas/Decimal"
          },
          "min_open_interval_seconds": {
            "maximum": 86400,
            "minimum": 0,
            "type": "integer"
          },
          "pending_valid_minutes": {
            "maximum": 10080,
            "minimum": 1,
            "type": "integer"
          },
          "reason": {
            "maxLength": 500,
            "minLength": 3,
            "type": "string"
          },
          "trade_send_enabled": {
            "type": "boolean"
          },
          "weekend_close_minutes": {
            "maximum": 2880,
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": [
          "reason"
        ],
        "type": "object"
      },
      "RiskPolicyReceiptResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "oneOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "policy": {
                    "type": "null"
                  },
                  "state": {
                    "const": "unconfirmed"
                  }
                },
                "required": [
                  "state",
                  "policy"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "policy": {
                    "$ref": "#/components/schemas/RiskPolicy"
                  },
                  "state": {
                    "const": "confirmed"
                  }
                },
                "required": [
                  "state",
                  "policy"
                ],
                "type": "object"
              }
            ]
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "RiskPolicyResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/RiskPolicy"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "Session": {
        "additionalProperties": false,
        "properties": {
          "app": {
            "enum": [
              "www",
              "trade",
              "admin"
            ],
            "type": "string"
          },
          "authenticated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "csrf_token": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          },
          "mfa_level": {
            "enum": [
              "none",
              "otp",
              "strong"
            ],
            "type": "string"
          },
          "permissions": {
            "items": {
              "maxLength": 128,
              "type": "string"
            },
            "type": "array",
            "uniqueItems": true
          },
          "user": {
            "additionalProperties": false,
            "properties": {
              "avatar_url": {
                "format": "uri-reference",
                "type": [
                  "string",
                  "null"
                ]
              },
              "display_name": {
                "maxLength": 100,
                "minLength": 1,
                "type": "string"
              },
              "id": {
                "$ref": "#/components/schemas/OpaqueId"
              }
            },
            "required": [
              "id",
              "display_name",
              "avatar_url"
            ],
            "type": "object"
          }
        },
        "required": [
          "user",
          "app",
          "permissions",
          "authenticated_at",
          "mfa_level",
          "csrf_token"
        ],
        "type": "object"
      },
      "SessionResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/Session"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategyCombinationCreate": {
        "additionalProperties": false,
        "properties": {
          "analysis_config": {
            "additionalProperties": true,
            "type": "object"
          },
          "analysis_prompt_text": {
            "maxLength": 100000,
            "minLength": 20,
            "type": "string"
          },
          "description": {
            "maxLength": 2000,
            "type": "string"
          },
          "name": {
            "maxLength": 191,
            "minLength": 2,
            "type": "string"
          },
          "trader_config": {
            "additionalProperties": true,
            "type": "object"
          },
          "trader_prompt_text": {
            "maxLength": 100000,
            "minLength": 20,
            "type": "string"
          }
        },
        "required": [
          "name",
          "description",
          "analysis_prompt_text",
          "analysis_config",
          "trader_prompt_text",
          "trader_config"
        ],
        "type": "object"
      },
      "StrategyCombinationVersionCreate": {
        "additionalProperties": false,
        "properties": {
          "analysis_config": {
            "additionalProperties": true,
            "type": "object"
          },
          "analysis_prompt_text": {
            "maxLength": 100000,
            "minLength": 20,
            "type": "string"
          },
          "description": {
            "maxLength": 2000,
            "type": "string"
          },
          "name": {
            "maxLength": 191,
            "minLength": 2,
            "type": "string"
          },
          "status": {
            "enum": [
              "draft",
              "active"
            ],
            "type": "string"
          },
          "trader_config": {
            "additionalProperties": true,
            "type": "object"
          },
          "trader_expected_revision": {
            "oneOf": [
              {
                "minimum": 1,
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "trader_prompt_text": {
            "maxLength": 100000,
            "minLength": 20,
            "type": "string"
          }
        },
        "required": [
          "name",
          "description",
          "status",
          "trader_expected_revision",
          "analysis_prompt_text",
          "analysis_config",
          "trader_prompt_text",
          "trader_config"
        ],
        "type": "object"
      },
      "StrategyCompile": {
        "additionalProperties": false,
        "properties": {
          "config": {
            "additionalProperties": true,
            "type": "object"
          },
          "kind": {
            "enum": [
              "analysis",
              "trader"
            ],
            "type": "string"
          },
          "prompt_text": {
            "maxLength": 100000,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "kind",
          "prompt_text",
          "config"
        ],
        "type": "object"
      },
      "StrategyCompileIssue": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "maxLength": 128,
            "minLength": 1,
            "type": "string"
          },
          "level": {
            "enum": [
              "error",
              "warning"
            ],
            "type": "string"
          },
          "message": {
            "maxLength": 2000,
            "minLength": 1,
            "type": "string"
          },
          "path": {
            "maxLength": 256,
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "level",
          "code",
          "message",
          "path"
        ],
        "type": "object"
      },
      "StrategyCompileResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/StrategyCompileResult"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategyCompileResult": {
        "additionalProperties": false,
        "properties": {
          "input_contract_version": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "issues": {
            "items": {
              "$ref": "#/components/schemas/StrategyCompileIssue"
            },
            "type": "array"
          },
          "kind": {
            "enum": [
              "analysis",
              "trader"
            ],
            "type": "string"
          },
          "normalized_config": {
            "additionalProperties": true,
            "type": "object"
          },
          "output_contract_version": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "prompt_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "valid": {
            "type": "boolean"
          }
        },
        "required": [
          "valid",
          "kind",
          "prompt_hash",
          "normalized_config",
          "input_contract_version",
          "output_contract_version",
          "issues"
        ],
        "type": "object"
      },
      "StrategyCreate": {
        "additionalProperties": false,
        "properties": {
          "config": {
            "additionalProperties": true,
            "type": "object"
          },
          "description": {
            "maxLength": 2000,
            "type": "string"
          },
          "kind": {
            "enum": [
              "analysis",
              "trader"
            ],
            "type": "string"
          },
          "name": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "prompt_text": {
            "maxLength": 100000,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "kind",
          "name",
          "description",
          "prompt_text",
          "config"
        ],
        "type": "object"
      },
      "StrategyDetail": {
        "additionalProperties": false,
        "properties": {
          "active_version_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "description": {
            "maxLength": 2000,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "kind": {
            "enum": [
              "analysis",
              "trader"
            ],
            "type": "string"
          },
          "name": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "owner_user_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "paired_trader_strategy": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/StrategyPairedTrader"
              },
              {
                "type": "null"
              }
            ]
          },
          "performance": {
            "$ref": "#/components/schemas/StrategyPerformance"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "scope": {
            "enum": [
              "platform",
              "user"
            ],
            "type": "string"
          },
          "status": {
            "enum": [
              "draft",
              "active",
              "retired"
            ],
            "type": "string"
          },
          "versions": {
            "items": {
              "$ref": "#/components/schemas/StrategyVersion"
            },
            "type": "array"
          }
        },
        "required": [
          "id",
          "kind",
          "scope",
          "owner_user_id",
          "name",
          "description",
          "status",
          "active_version_id",
          "revision",
          "paired_trader_strategy",
          "performance",
          "versions"
        ],
        "type": "object"
      },
      "StrategyDetailResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/StrategyDetail"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategyListResponse": {
        "properties": {
          "data": {
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/StrategySummary"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategyMemoryConflict": {
        "additionalProperties": false,
        "properties": {
          "memory_key": {
            "pattern": "^[a-z0-9][a-z0-9._:-]{2,190}$",
            "type": "string"
          },
          "prior_update_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "type": {
            "enum": [
              "same_key_content_changed"
            ],
            "type": "string"
          }
        },
        "required": [
          "type",
          "prior_update_id",
          "memory_key"
        ],
        "type": "object"
      },
      "StrategyMemoryDetailResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "allOf": [
              {
                "$ref": "#/components/schemas/StrategyMemoryFields"
              },
              {
                "properties": {
                  "content_hash": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "content_text": {
                    "type": "string"
                  },
                  "current_revision_id": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "max_context_tokens": {
                    "minimum": 1,
                    "type": "integer"
                  }
                },
                "required": [
                  "current_revision_id",
                  "content_text",
                  "content_hash",
                  "max_context_tokens"
                ],
                "type": "object"
              }
            ],
            "unevaluatedProperties": false
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategyMemoryFields": {
        "properties": {
          "current_version": {
            "minimum": 0,
            "type": "integer"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "mode": {
            "enum": [
              "off",
              "shadow",
              "active"
            ],
            "type": "string"
          },
          "owner_user_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "pending_count": {
            "minimum": 0,
            "type": "integer"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "status": {
            "enum": [
              "active",
              "revalidating",
              "retired"
            ],
            "type": "string"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "strategy_kind": {
            "enum": [
              "analysis",
              "trader"
            ],
            "type": "string"
          },
          "strategy_name": {
            "type": "string"
          },
          "updated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "id",
          "strategy_id",
          "strategy_name",
          "strategy_kind",
          "owner_user_id",
          "mode",
          "status",
          "current_version",
          "pending_count",
          "updated_at",
          "revision"
        ],
        "type": "object"
      },
      "StrategyMemoryListResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/StrategyMemorySummary"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategyMemoryProposal": {
        "additionalProperties": false,
        "properties": {
          "content": {
            "maxLength": 20000,
            "minLength": 1,
            "type": "string"
          },
          "evidence_refs": {
            "items": {
              "minLength": 1,
              "type": "string"
            },
            "maxItems": 2000,
            "type": "array"
          },
          "memory_key": {
            "pattern": "^[a-z0-9][a-z0-9._:-]{2,190}$",
            "type": "string"
          },
          "title": {
            "maxLength": 300,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "memory_key",
          "title",
          "content",
          "evidence_refs"
        ],
        "type": "object"
      },
      "StrategyMemorySummary": {
        "allOf": [
          {
            "$ref": "#/components/schemas/StrategyMemoryFields"
          }
        ],
        "unevaluatedProperties": false
      },
      "StrategyMemoryUpdate": {
        "additionalProperties": false,
        "properties": {
          "conflicts": {
            "items": {
              "$ref": "#/components/schemas/StrategyMemoryConflict"
            },
            "type": "array"
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "diff_preview_text": {
            "type": "string"
          },
          "expected_library_revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "library_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "proposal": {
            "$ref": "#/components/schemas/StrategyMemoryProposal"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "source_review_case_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "source_review_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "status": {
            "enum": [
              "collecting_evidence",
              "awaiting_confirmation",
              "accepted",
              "rejected",
              "merged",
              "superseded"
            ],
            "type": "string"
          },
          "update_kind": {
            "enum": [
              "short_term",
              "long_term_candidate",
              "monthly_summary",
              "platform_candidate"
            ],
            "type": "string"
          }
        },
        "required": [
          "id",
          "library_id",
          "source_review_case_id",
          "source_review_version_id",
          "update_kind",
          "status",
          "expected_library_revision",
          "proposal",
          "diff_preview_text",
          "conflicts",
          "created_at",
          "revision"
        ],
        "type": "object"
      },
      "StrategyMemoryUpdateListResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/StrategyMemoryUpdate"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategyMemoryUpdateResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/StrategyMemoryUpdate"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategyMetadataPatch": {
        "additionalProperties": false,
        "properties": {
          "description": {
            "maxLength": 2000,
            "type": "string"
          },
          "name": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "name",
          "description"
        ],
        "type": "object"
      },
      "StrategyPairedTrader": {
        "additionalProperties": false,
        "properties": {
          "active_version_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "name": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "status": {
            "enum": [
              "draft",
              "active",
              "retired"
            ],
            "type": "string"
          }
        },
        "required": [
          "id",
          "name",
          "status",
          "active_version_id"
        ],
        "type": "object"
      },
      "StrategyPerformance": {
        "additionalProperties": false,
        "properties": {
          "currencies": {
            "items": {
              "maxLength": 16,
              "minLength": 1,
              "type": "string"
            },
            "type": "array"
          },
          "currency": {
            "oneOf": [
              {
                "maxLength": 16,
                "minLength": 1,
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "max_drawdown": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "max_drawdown_percent": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "net_profit": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "period_end": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "period_start": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "profit_factor": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "return_percent": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "status": {
            "enum": [
              "available",
              "insufficient",
              "mixed_currency"
            ],
            "type": "string"
          },
          "trade_count": {
            "minimum": 0,
            "type": "integer"
          },
          "win_rate_percent": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "status",
          "currency",
          "currencies",
          "net_profit",
          "max_drawdown",
          "return_percent",
          "max_drawdown_percent",
          "trade_count",
          "win_rate_percent",
          "profit_factor",
          "period_start",
          "period_end"
        ],
        "type": "object"
      },
      "StrategySubscription": {
        "additionalProperties": false,
        "properties": {
          "analysis_enabled": {
            "type": "boolean"
          },
          "analysis_strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "analysis_strategy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "schedule": {
            "$ref": "#/components/schemas/StrategySubscriptionSchedule"
          },
          "status": {
            "enum": [
              "active",
              "paused",
              "ended"
            ],
            "type": "string"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "trade_send_enabled": {
            "type": "boolean"
          },
          "trader_enabled": {
            "type": "boolean"
          },
          "trader_strategy_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "trader_strategy_version_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "trading_account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "updated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "user_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "id",
          "user_id",
          "trading_account_id",
          "symbol",
          "analysis_strategy_id",
          "analysis_strategy_version_id",
          "trader_strategy_id",
          "trader_strategy_version_id",
          "analysis_enabled",
          "trader_enabled",
          "trade_send_enabled",
          "status",
          "revision",
          "created_at",
          "updated_at",
          "schedule"
        ],
        "type": "object"
      },
      "StrategySubscriptionCreate": {
        "additionalProperties": false,
        "properties": {
          "analysis_enabled": {
            "default": true,
            "type": "boolean"
          },
          "analysis_strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "receive_window": {
            "oneOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "enabled": {
                    "const": false,
                    "type": "boolean"
                  }
                },
                "required": [
                  "enabled"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "enabled": {
                    "type": "boolean"
                  },
                  "outsideBehavior": {
                    "enum": [
                      "pause_all",
                      "signals_only"
                    ],
                    "type": "string"
                  },
                  "timezone": {
                    "const": "terminal_server",
                    "type": "string"
                  },
                  "version": {
                    "const": 1,
                    "type": "integer"
                  },
                  "weekdays": {
                    "items": {
                      "maximum": 6,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "maxItems": 7,
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  },
                  "windows": {
                    "items": {
                      "additionalProperties": false,
                      "properties": {
                        "end": {
                          "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                          "type": "string"
                        },
                        "start": {
                          "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                          "type": "string"
                        }
                      },
                      "required": [
                        "start",
                        "end"
                      ],
                      "type": "object"
                    },
                    "maxItems": 6,
                    "minItems": 1,
                    "type": "array"
                  }
                },
                "required": [
                  "enabled",
                  "version",
                  "timezone",
                  "weekdays",
                  "windows",
                  "outsideBehavior"
                ],
                "type": "object"
              }
            ]
          },
          "status": {
            "default": "active",
            "enum": [
              "active",
              "paused"
            ],
            "type": "string"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "trade_send_enabled": {
            "default": false,
            "type": "boolean"
          },
          "trader_enabled": {
            "default": false,
            "type": "boolean"
          },
          "trader_strategy_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "trading_account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "trading_account_id",
          "symbol",
          "analysis_strategy_id"
        ],
        "type": "object"
      },
      "StrategySubscriptionListResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/StrategySubscription"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategySubscriptionPatch": {
        "additionalProperties": false,
        "properties": {
          "analysis_enabled": {
            "type": "boolean"
          },
          "analysis_strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "receive_window": {
            "oneOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "enabled": {
                    "const": false,
                    "type": "boolean"
                  }
                },
                "required": [
                  "enabled"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "enabled": {
                    "type": "boolean"
                  },
                  "outsideBehavior": {
                    "enum": [
                      "pause_all",
                      "signals_only"
                    ],
                    "type": "string"
                  },
                  "timezone": {
                    "const": "terminal_server",
                    "type": "string"
                  },
                  "version": {
                    "const": 1,
                    "type": "integer"
                  },
                  "weekdays": {
                    "items": {
                      "maximum": 6,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "maxItems": 7,
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  },
                  "windows": {
                    "items": {
                      "additionalProperties": false,
                      "properties": {
                        "end": {
                          "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                          "type": "string"
                        },
                        "start": {
                          "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                          "type": "string"
                        }
                      },
                      "required": [
                        "start",
                        "end"
                      ],
                      "type": "object"
                    },
                    "maxItems": 6,
                    "minItems": 1,
                    "type": "array"
                  }
                },
                "required": [
                  "enabled",
                  "version",
                  "timezone",
                  "weekdays",
                  "windows",
                  "outsideBehavior"
                ],
                "type": "object"
              }
            ]
          },
          "status": {
            "enum": [
              "active",
              "paused",
              "ended"
            ],
            "type": "string"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "trade_send_enabled": {
            "type": "boolean"
          },
          "trader_enabled": {
            "type": "boolean"
          },
          "trader_strategy_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "type": "object"
      },
      "StrategySubscriptionResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/StrategySubscription"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "StrategySubscriptionSchedule": {
        "additionalProperties": false,
        "properties": {
          "cadence_seconds": {
            "minimum": 60,
            "type": "integer"
          },
          "next_due_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "receive_timezone": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "receive_window": {
            "additionalProperties": true,
            "type": "object"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          }
        },
        "required": [
          "cadence_seconds",
          "receive_timezone",
          "receive_window",
          "next_due_at",
          "revision"
        ],
        "type": "object"
      },
      "StrategySummary": {
        "additionalProperties": false,
        "properties": {
          "active_version_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "description": {
            "maxLength": 2000,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "kind": {
            "enum": [
              "analysis",
              "trader"
            ],
            "type": "string"
          },
          "name": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "owner_user_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "paired_trader_strategy": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/StrategyPairedTrader"
              },
              {
                "type": "null"
              }
            ]
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "scope": {
            "enum": [
              "platform",
              "user"
            ],
            "type": "string"
          },
          "status": {
            "enum": [
              "draft",
              "active",
              "retired"
            ],
            "type": "string"
          }
        },
        "required": [
          "id",
          "kind",
          "scope",
          "owner_user_id",
          "name",
          "description",
          "status",
          "active_version_id",
          "paired_trader_strategy",
          "revision"
        ],
        "type": "object"
      },
      "StrategyVersion": {
        "additionalProperties": false,
        "properties": {
          "config": {
            "additionalProperties": true,
            "type": "object"
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "created_by_user_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "input_contract_version": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "kind": {
            "enum": [
              "analysis",
              "trader"
            ],
            "type": "string"
          },
          "output_contract_version": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "prompt_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "prompt_text": {
            "maxLength": 100000,
            "minLength": 1,
            "type": "string"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "version": {
            "minimum": 1,
            "type": "integer"
          }
        },
        "required": [
          "id",
          "strategy_id",
          "kind",
          "version",
          "prompt_text",
          "prompt_hash",
          "config",
          "input_contract_version",
          "output_contract_version",
          "created_by_user_id",
          "created_at"
        ],
        "type": "object"
      },
      "StrategyVersionCreate": {
        "additionalProperties": false,
        "properties": {
          "config": {
            "additionalProperties": true,
            "type": "object"
          },
          "description": {
            "maxLength": 2000,
            "type": "string"
          },
          "name": {
            "maxLength": 191,
            "minLength": 1,
            "type": "string"
          },
          "prompt_text": {
            "maxLength": 100000,
            "minLength": 1,
            "type": "string"
          },
          "status": {
            "enum": [
              "draft",
              "active"
            ],
            "type": "string"
          }
        },
        "required": [
          "prompt_text",
          "config"
        ],
        "type": "object"
      },
      "Symbol": {
        "maxLength": 64,
        "minLength": 1,
        "pattern": "^[A-Za-z0-9._-]+$",
        "type": "string"
      },
      "TerminalMarketSymbol": {
        "additionalProperties": false,
        "properties": {
          "currency_base": {
            "maxLength": 16,
            "type": [
              "string",
              "null"
            ]
          },
          "currency_profit": {
            "maxLength": 16,
            "type": [
              "string",
              "null"
            ]
          },
          "description": {
            "maxLength": 256,
            "type": "string"
          },
          "selected": {
            "type": "boolean"
          },
          "symbol": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "trade_mode": {
            "maximum": 4,
            "minimum": 0,
            "type": [
              "integer",
              "null"
            ]
          },
          "visible": {
            "type": "boolean"
          }
        },
        "required": [
          "symbol",
          "description",
          "selected",
          "visible",
          "trade_mode",
          "currency_base",
          "currency_profit"
        ],
        "type": "object"
      },
      "TerminalMarketSymbolsResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/TerminalMarketSymbol"
                },
                "maxItems": 5000,
                "type": "array"
              },
              "next_cursor": {
                "maxLength": 2048,
                "type": [
                  "string",
                  "null"
                ]
              },
              "observed_at": {
                "format": "date-time",
                "type": "string"
              }
            },
            "required": [
              "items",
              "next_cursor",
              "observed_at"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TerminalMarketWindowResponse": {
        "properties": {
          "data": {
            "properties": {
              "before": {
                "pattern": "^[1-9][0-9]{0,15}$",
                "type": "string"
              },
              "items": {
                "items": {
                  "$ref": "#/components/schemas/Candle"
                },
                "type": "array"
              },
              "structure": {
                "oneOf": [
                  {
                    "$ref": "#/components/schemas/PublicMarketStructure"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "items",
              "before",
              "structure"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TerminalProfileListResponse": {
        "properties": {
          "data": {
            "properties": {
              "items": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "account_id": {
                      "oneOf": [
                        {
                          "$ref": "#/components/schemas/OpaqueId"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "connection_state": {
                      "enum": [
                        "online",
                        "offline",
                        "paused"
                      ],
                      "type": "string"
                    },
                    "display_name": {
                      "type": "string"
                    },
                    "id": {
                      "$ref": "#/components/schemas/OpaqueId"
                    },
                    "installation_id": {
                      "$ref": "#/components/schemas/OpaqueId"
                    },
                    "last_seen_at": {
                      "oneOf": [
                        {
                          "$ref": "#/components/schemas/UtcDateTime"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "platform": {
                      "enum": [
                        "mt4",
                        "mt5"
                      ],
                      "type": "string"
                    }
                  },
                  "required": [
                    "id",
                    "display_name",
                    "platform",
                    "installation_id",
                    "account_id",
                    "connection_state",
                    "last_seen_at"
                  ],
                  "type": "object"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "Ticket": {
        "maxLength": 64,
        "minLength": 1,
        "pattern": "^[0-9A-Za-z._:-]+$",
        "type": "string"
      },
      "Timeframe": {
        "enum": [
          "M1",
          "M5",
          "M15",
          "M30",
          "H1",
          "H4",
          "D1"
        ],
        "type": "string"
      },
      "TradeDecisionDetail": {
        "additionalProperties": false,
        "properties": {
          "actions": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "action_id": {
                  "$ref": "#/components/schemas/OpaqueId"
                },
                "expected_state": {
                  "additionalProperties": true,
                  "type": "object"
                },
                "kind": {
                  "enum": [
                    "market_order",
                    "pending_order",
                    "modify_position",
                    "close_position",
                    "modify_order",
                    "cancel_order"
                  ],
                  "type": "string"
                },
                "parameters": {
                  "additionalProperties": true,
                  "type": "object"
                }
              },
              "required": [
                "action_id",
                "kind",
                "parameters",
                "expected_state"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "input_snapshot_hash": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          },
          "reasoning": {
            "type": "string"
          },
          "summary": {
            "$ref": "#/components/schemas/TradeDecisionSummary"
          }
        },
        "required": [
          "summary",
          "actions",
          "reasoning",
          "input_snapshot_hash"
        ],
        "type": "object"
      },
      "TradeDecisionDetailResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/TradeDecisionDetail"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TradeDecisionListResponse": {
        "properties": {
          "data": {
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/TradeDecisionSummary"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TradeDecisionSummary": {
        "additionalProperties": false,
        "properties": {
          "action": {
            "enum": [
              "hold",
              "market_order",
              "pending_order",
              "modify_position",
              "close_position",
              "modify_order",
              "cancel_order"
            ],
            "type": "string"
          },
          "analysis_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "confidence": {
            "maximum": 100,
            "minimum": 0,
            "type": "number"
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "decision_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "side": {
            "enum": [
              "buy",
              "sell",
              null
            ],
            "type": [
              "string",
              "null"
            ]
          },
          "stale_reason": {
            "maxLength": 128,
            "type": [
              "string",
              "null"
            ]
          },
          "status": {
            "enum": [
              "proposed",
              "stale",
              "risk_rejected",
              "accepted"
            ],
            "type": "string"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "strategy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "summary": {
            "maxLength": 2000,
            "type": "string"
          },
          "trading_account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "decision_id",
          "analysis_id",
          "trading_account_id",
          "strategy_id",
          "strategy_version_id",
          "action",
          "side",
          "confidence",
          "summary",
          "status",
          "stale_reason",
          "created_at",
          "revision"
        ],
        "type": "object"
      },
      "TradeHistoryPageResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "captured_end": {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              "daily": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "business_date": {
                      "$ref": "#/components/schemas/BusinessDate"
                    },
                    "cumulative_net_profit": {
                      "anyOf": [
                        {
                          "$ref": "#/components/schemas/Decimal"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "net_profit": {
                      "anyOf": [
                        {
                          "$ref": "#/components/schemas/Decimal"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "trade_count": {
                      "minimum": 0,
                      "type": "integer"
                    }
                  },
                  "required": [
                    "business_date",
                    "trade_count",
                    "net_profit",
                    "cumulative_net_profit"
                  ],
                  "type": "object"
                },
                "type": "array"
              },
              "freshness": {
                "additionalProperties": false,
                "properties": {
                  "blocking_reason": {
                    "enum": [
                      "terminal_clock_unavailable",
                      "terminal_connection_unavailable",
                      null
                    ],
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "fresh_through": {
                    "oneOf": [
                      {
                        "$ref": "#/components/schemas/UtcDateTime"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "history_revision": {
                    "$ref": "#/components/schemas/Revision"
                  },
                  "last_success_at": {
                    "oneOf": [
                      {
                        "$ref": "#/components/schemas/UtcDateTime"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "status": {
                    "enum": [
                      "empty",
                      "syncing",
                      "ready",
                      "stale",
                      "failed"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "status",
                  "blocking_reason",
                  "history_revision",
                  "fresh_through",
                  "last_success_at"
                ],
                "type": "object"
              },
              "has_more": {
                "type": "boolean"
              },
              "items": {
                "items": {
                  "$ref": "#/components/schemas/TradeHistoryRecord"
                },
                "type": "array"
              },
              "next_cursor": {
                "maxLength": 2048,
                "type": [
                  "string",
                  "null"
                ]
              },
              "summary": {
                "$ref": "#/components/schemas/TradeHistorySummary"
              }
            },
            "required": [
              "captured_end",
              "freshness",
              "items",
              "next_cursor",
              "has_more",
              "summary",
              "daily"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TradeHistoryRecord": {
        "allOf": [
          {
            "$ref": "#/components/schemas/TradeHistoryRecordFields"
          }
        ],
        "unevaluatedProperties": false
      },
      "TradeHistoryRecordFields": {
        "properties": {
          "account_currency": {
            "maxLength": 16,
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "attribution_status": {
            "enum": [
              "exact",
              "partial",
              "conflicted",
              "unresolved"
            ],
            "type": "string"
          },
          "closed_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "commission": {
            "$ref": "#/components/schemas/Decimal"
          },
          "currency_evidence": {
            "enum": [
              "unknown",
              "explicit_record"
            ],
            "type": "string"
          },
          "entry_price": {
            "$ref": "#/components/schemas/Decimal"
          },
          "evidence_status": {
            "enum": [
              "complete",
              "partial",
              "conflicted"
            ],
            "type": "string"
          },
          "exit_price": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "fee": {
            "$ref": "#/components/schemas/Decimal"
          },
          "gross_profit": {
            "$ref": "#/components/schemas/Decimal"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "net_profit": {
            "$ref": "#/components/schemas/Decimal"
          },
          "opened_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "platform": {
            "enum": [
              "mt4",
              "mt5"
            ],
            "type": "string"
          },
          "position_id": {
            "maxLength": 64,
            "type": [
              "string",
              "null"
            ]
          },
          "primary_ticket": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "side": {
            "enum": [
              "buy",
              "sell"
            ],
            "type": "string"
          },
          "source": {
            "enum": [
              "system",
              "manual",
              "other_ea",
              "mixed",
              "unknown"
            ],
            "type": "string"
          },
          "status": {
            "enum": [
              "open",
              "closed",
              "partial",
              "unknown"
            ],
            "type": "string"
          },
          "stop_loss": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "swap": {
            "$ref": "#/components/schemas/Decimal"
          },
          "symbol": {
            "$ref": "#/components/schemas/Symbol"
          },
          "take_profit": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "terminal_timezone_offset_minutes": {
            "maximum": 840,
            "minimum": -840,
            "type": "integer"
          },
          "volume": {
            "$ref": "#/components/schemas/Decimal"
          }
        },
        "required": [
          "id",
          "account_id",
          "platform",
          "primary_ticket",
          "position_id",
          "symbol",
          "side",
          "status",
          "source",
          "attribution_status",
          "evidence_status",
          "volume",
          "entry_price",
          "exit_price",
          "stop_loss",
          "take_profit",
          "gross_profit",
          "commission",
          "swap",
          "fee",
          "net_profit",
          "opened_at",
          "closed_at",
          "terminal_timezone_offset_minutes",
          "revision",
          "account_currency",
          "currency_evidence"
        ],
        "type": "object"
      },
      "TradeHistorySummary": {
        "additionalProperties": false,
        "allOf": [
          {
            "else": {
              "properties": {
                "account_currency": {
                  "type": "null"
                },
                "commission": {
                  "type": "null"
                },
                "fee": {
                  "type": "null"
                },
                "gross_profit": {
                  "type": "null"
                },
                "net_profit": {
                  "type": "null"
                },
                "profit_factor": {
                  "type": "null"
                },
                "swap": {
                  "type": "null"
                }
              }
            },
            "if": {
              "properties": {
                "money_status": {
                  "const": "comparable"
                }
              }
            },
            "then": {
              "properties": {
                "account_currency": {
                  "type": "string"
                },
                "commission": {
                  "$ref": "#/components/schemas/Decimal"
                },
                "fee": {
                  "$ref": "#/components/schemas/Decimal"
                },
                "gross_profit": {
                  "$ref": "#/components/schemas/Decimal"
                },
                "net_profit": {
                  "$ref": "#/components/schemas/Decimal"
                },
                "swap": {
                  "$ref": "#/components/schemas/Decimal"
                },
                "trade_count": {
                  "minimum": 1
                }
              }
            }
          },
          {
            "else": {
              "properties": {
                "trade_count": {
                  "minimum": 1
                }
              }
            },
            "if": {
              "properties": {
                "money_status": {
                  "const": "empty"
                }
              }
            },
            "then": {
              "properties": {
                "trade_count": {
                  "const": 0
                }
              }
            }
          }
        ],
        "properties": {
          "account_currency": {
            "maxLength": 16,
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "breakeven_count": {
            "minimum": 0,
            "type": "integer"
          },
          "commission": {
            "anyOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "fee": {
            "anyOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "gross_profit": {
            "anyOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "losing_count": {
            "minimum": 0,
            "type": "integer"
          },
          "money_status": {
            "enum": [
              "comparable",
              "unknown",
              "mixed",
              "empty"
            ],
            "type": "string"
          },
          "net_profit": {
            "anyOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "profit_factor": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "swap": {
            "anyOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "trade_count": {
            "minimum": 0,
            "type": "integer"
          },
          "win_rate_percent": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "winning_count": {
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": [
          "trade_count",
          "winning_count",
          "losing_count",
          "breakeven_count",
          "win_rate_percent",
          "gross_profit",
          "commission",
          "swap",
          "fee",
          "net_profit",
          "profit_factor",
          "account_currency",
          "money_status"
        ],
        "type": "object"
      },
      "TradeRecordAttribution": {
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": [
              "market_analysis",
              "trade_decision",
              "risk_decision",
              "execution_intent",
              "execution_outcome",
              "bridge_command",
              "review_case"
            ],
            "type": "string"
          },
          "proof_kind": {
            "enum": [
              "terminal_ticket",
              "terminal_order",
              "terminal_deal",
              "distribution_target",
              "legacy_mapping"
            ],
            "type": "string"
          },
          "relation": {
            "enum": [
              "opened",
              "modified",
              "closed",
              "cancelled",
              "reviewed",
              "related"
            ],
            "type": "string"
          },
          "source_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "kind",
          "source_id",
          "relation",
          "proof_kind"
        ],
        "type": "object"
      },
      "TradeRecordDeal": {
        "additionalProperties": false,
        "properties": {
          "account_currency": {
            "maxLength": 16,
            "minLength": 1,
            "type": [
              "string",
              "null"
            ]
          },
          "commission": {
            "$ref": "#/components/schemas/Decimal"
          },
          "currency_evidence": {
            "enum": [
              "unknown",
              "explicit_record"
            ],
            "type": "string"
          },
          "deal_ticket": {
            "type": "string"
          },
          "entry_kind": {
            "enum": [
              "in",
              "out",
              "inout",
              "out_by",
              "none",
              "unknown"
            ],
            "type": "string"
          },
          "fee": {
            "$ref": "#/components/schemas/Decimal"
          },
          "gross_profit": {
            "$ref": "#/components/schemas/Decimal"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "occurred_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "order_ticket": {
            "type": [
              "string",
              "null"
            ]
          },
          "price": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          },
          "role": {
            "enum": [
              "entry",
              "exit",
              "fee",
              "adjustment",
              "unknown"
            ],
            "type": "string"
          },
          "side": {
            "enum": [
              "buy",
              "sell",
              "none",
              "unknown"
            ],
            "type": "string"
          },
          "swap": {
            "$ref": "#/components/schemas/Decimal"
          },
          "volume": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Decimal"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "deal_ticket",
          "order_ticket",
          "role",
          "side",
          "entry_kind",
          "volume",
          "price",
          "gross_profit",
          "commission",
          "swap",
          "fee",
          "occurred_at",
          "account_currency",
          "currency_evidence"
        ],
        "type": "object"
      },
      "TradeRecordDetailResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "allOf": [
              {
                "$ref": "#/components/schemas/TradeHistoryRecordFields"
              },
              {
                "properties": {
                  "attributions": {
                    "items": {
                      "$ref": "#/components/schemas/TradeRecordAttribution"
                    },
                    "type": "array"
                  },
                  "deals": {
                    "items": {
                      "$ref": "#/components/schemas/TradeRecordDeal"
                    },
                    "type": "array"
                  },
                  "evidence_hash": {
                    "pattern": "^[a-f0-9]{64}$",
                    "type": "string"
                  }
                },
                "required": [
                  "evidence_hash",
                  "deals",
                  "attributions"
                ],
                "type": "object"
              }
            ],
            "unevaluatedProperties": false
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TraderEvaluationCreate": {
        "additionalProperties": false,
        "properties": {
          "subscription_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "subscription_revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "trader_strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "trader_strategy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "trading_account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "trading_account_id",
          "subscription_id",
          "subscription_revision",
          "trader_strategy_id",
          "trader_strategy_version_id"
        ],
        "type": "object"
      },
      "TraderRun": {
        "additionalProperties": false,
        "properties": {
          "analysis_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "created_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "status": {
            "enum": [
              "queued",
              "running",
              "succeeded",
              "failed",
              "cancelled",
              "expired"
            ],
            "type": "string"
          },
          "strategy_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "strategy_version_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "task_mode": {
            "enum": [
              "entry",
              "manage",
              "both"
            ],
            "type": "string"
          },
          "trader_run_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "trading_account_id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "updated_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        "required": [
          "trader_run_id",
          "analysis_id",
          "trading_account_id",
          "strategy_id",
          "strategy_version_id",
          "task_mode",
          "status",
          "created_at",
          "updated_at",
          "revision"
        ],
        "type": "object"
      },
      "TraderRunResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/TraderRun"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TradingAccount": {
        "additionalProperties": false,
        "properties": {
          "bridge_state": {
            "enum": [
              "online",
              "offline",
              "paused",
              "replaced",
              "unauthorized"
            ],
            "type": "string"
          },
          "currency": {
            "maxLength": 12,
            "minLength": 3,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/OpaqueId"
          },
          "last_seen_at": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/UtcDateTime"
              },
              {
                "type": "null"
              }
            ]
          },
          "login": {
            "maxLength": 64,
            "type": "string"
          },
          "platform": {
            "enum": [
              "mt4",
              "mt5"
            ],
            "type": "string"
          },
          "server": {
            "maxLength": 191,
            "type": "string"
          },
          "terminal_instance_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "terminal_profile_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "trade_permission": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "platform",
          "login",
          "server",
          "currency",
          "terminal_profile_id",
          "terminal_instance_id",
          "bridge_state",
          "trade_permission",
          "last_seen_at"
        ],
        "type": "object"
      },
      "TradingAccountListResponse": {
        "properties": {
          "data": {
            "properties": {
              "items": {
                "items": {
                  "$ref": "#/components/schemas/TradingAccount"
                },
                "type": "array"
              }
            },
            "required": [
              "items"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TradingContext": {
        "additionalProperties": false,
        "properties": {
          "account_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "mode": {
            "enum": [
              "full",
              "observer",
              "blocked"
            ],
            "type": "string"
          },
          "observer_channel_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "read_only": {
            "type": "boolean"
          },
          "revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "user_id": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        "required": [
          "mode",
          "user_id",
          "account_id",
          "observer_channel_id",
          "read_only",
          "revision"
        ],
        "type": "object"
      },
      "TradingContextInput": {
        "additionalProperties": false,
        "oneOf": [
          {
            "properties": {
              "account_id": {
                "$ref": "#/components/schemas/OpaqueId"
              },
              "mode": {
                "const": "full"
              },
              "observer_channel_id": {
                "type": "null"
              }
            },
            "required": [
              "account_id"
            ]
          },
          {
            "properties": {
              "account_id": {
                "type": "null"
              },
              "mode": {
                "const": "observer"
              },
              "observer_channel_id": {
                "$ref": "#/components/schemas/OpaqueId"
              }
            },
            "required": [
              "observer_channel_id"
            ]
          }
        ],
        "properties": {
          "account_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          },
          "expected_revision": {
            "maxLength": 16,
            "pattern": "^(0|[1-9][0-9]*)$",
            "type": "string"
          },
          "mode": {
            "enum": [
              "full",
              "observer"
            ],
            "type": "string"
          },
          "observer_channel_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "mode",
          "expected_revision"
        ],
        "type": "object"
      },
      "TradingContextReceipt": {
        "additionalProperties": false,
        "properties": {
          "action": {
            "enum": [
              "select_account",
              "enter_observer",
              "leave_observer"
            ],
            "type": "string"
          },
          "prior_revision": {
            "$ref": "#/components/schemas/Revision"
          },
          "recorded_at": {
            "$ref": "#/components/schemas/UtcDateTime"
          },
          "replayed": {
            "type": "boolean"
          },
          "request_id": {
            "maxLength": 36,
            "minLength": 36,
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            "type": "string"
          },
          "result": {
            "$ref": "#/components/schemas/TradingContext"
          },
          "target_id": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/OpaqueId"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "request_id",
          "action",
          "target_id",
          "prior_revision",
          "result",
          "recorded_at",
          "replayed"
        ],
        "type": "object"
      },
      "TradingContextReceiptResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/TradingContextReceipt"
              },
              {
                "type": "null"
              }
            ]
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TradingContextResponse": {
        "properties": {
          "data": {
            "$ref": "#/components/schemas/TradingContext"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "TradingWorkspaceResponse": {
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "account": {
                "$ref": "#/components/schemas/TradingAccount"
              },
              "pending_orders": {
                "properties": {
                  "items": {
                    "items": {
                      "$ref": "#/components/schemas/PendingOrder"
                    },
                    "type": "array"
                  },
                  "revision": {
                    "$ref": "#/components/schemas/Revision"
                  }
                },
                "required": [
                  "revision",
                  "items"
                ],
                "type": "object"
              },
              "positions": {
                "properties": {
                  "items": {
                    "items": {
                      "$ref": "#/components/schemas/Position"
                    },
                    "type": "array"
                  },
                  "revision": {
                    "$ref": "#/components/schemas/Revision"
                  }
                },
                "required": [
                  "revision",
                  "items"
                ],
                "type": "object"
              },
              "snapshot": {
                "oneOf": [
                  {
                    "$ref": "#/components/schemas/AccountSnapshot"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "symbols": {
                "items": {
                  "$ref": "#/components/schemas/Symbol"
                },
                "type": "array"
              }
            },
            "required": [
              "account",
              "snapshot",
              "symbols",
              "positions",
              "pending_orders"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "UtcDateTime": {
        "format": "date-time",
        "pattern": "Z$",
        "type": "string"
      },
      "getArchivedExecutionResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ArchivedExecutionDetail"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "getArchivedSignalResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "$ref": "#/components/schemas/ArchivedSignalDetail"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "listArchivedExecutionsResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "executable": {
                "enum": [
                  false
                ],
                "type": "boolean"
              },
              "identity_namespace": {
                "enum": [
                  "retained-legacy"
                ],
                "type": "string"
              },
              "items": {
                "items": {
                  "$ref": "#/components/schemas/ArchivedExecutionSummary"
                },
                "maxItems": 100,
                "type": "array"
              },
              "next_cursor": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "items",
              "next_cursor",
              "identity_namespace",
              "executable"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      },
      "listArchivedSignalsResponse": {
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "executable": {
                "enum": [
                  false
                ],
                "type": "boolean"
              },
              "identity_namespace": {
                "enum": [
                  "retained-legacy"
                ],
                "type": "string"
              },
              "items": {
                "items": {
                  "$ref": "#/components/schemas/ArchivedSignalSummary"
                },
                "maxItems": 100,
                "type": "array"
              },
              "next_cursor": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "items",
              "next_cursor",
              "identity_namespace",
              "executable"
            ],
            "type": "object"
          },
          "meta": {
            "$ref": "#/components/schemas/Meta"
          }
        },
        "required": [
          "data",
          "meta"
        ],
        "type": "object"
      }
    }
  },
  "operations": {
    "listObserverChannelsForAdmin": {
      "parameters": [
        {
          "name": "limit",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 20,
            "pattern": "^[1-9][0-9]{0,19}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverChannelPageResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createObserverChannel": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 8,
            "pattern": "^[A-Za-z0-9._:-]+$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverManagementWriteResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ObserverChannelCreateInput"
        },
        "required": true
      }
    },
    "updateObserverChannel": {
      "parameters": [
        {
          "name": "channel_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 20,
            "pattern": "^[1-9][0-9]{0,19}$",
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 8,
            "pattern": "^[A-Za-z0-9._:-]+$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverManagementWriteResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ObserverChannelUpdateInput"
        },
        "required": true
      }
    },
    "listObserverChannelAccesses": {
      "parameters": [
        {
          "name": "channel_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 20,
            "pattern": "^[1-9][0-9]{0,19}$",
            "type": "string"
          }
        },
        {
          "name": "limit",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 20,
            "pattern": "^[1-9][0-9]{0,19}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverAccessPageResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "setObserverChannelAccess": {
      "parameters": [
        {
          "name": "channel_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 20,
            "pattern": "^[1-9][0-9]{0,19}$",
            "type": "string"
          }
        },
        {
          "name": "user_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 10,
            "pattern": "^[1-9][0-9]{0,9}$",
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 8,
            "pattern": "^[A-Za-z0-9._:-]+$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverManagementWriteResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ObserverAccessInput"
        },
        "required": true
      }
    },
    "setObserverDefaultChannel": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 8,
            "pattern": "^[A-Za-z0-9._:-]+$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverManagementWriteResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ObserverDefaultChannelInput"
        },
        "required": true
      }
    },
    "listObserverManagementOperations": {
      "parameters": [
        {
          "name": "limit",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "format": "uuid",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverOperationPageResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listObserverSourcesForAdmin": {
      "parameters": [
        {
          "name": "limit",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 20,
            "pattern": "^[1-9][0-9]{0,19}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverSourcePageResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createObserverSource": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 8,
            "pattern": "^[A-Za-z0-9._:-]+$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverManagementWriteResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ObserverSourceCreateInput"
        },
        "required": true
      }
    },
    "updateObserverSource": {
      "parameters": [
        {
          "name": "source_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 20,
            "pattern": "^[1-9][0-9]{0,19}$",
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 8,
            "pattern": "^[A-Za-z0-9._:-]+$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverManagementWriteResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ObserverSourceUpdateInput"
        },
        "required": true
      }
    },
    "listReferralRules": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "properties": {
              "data": {
                "properties": {
                  "rules": {
                    "items": {
                      "properties": {
                        "enabled": {
                          "type": "boolean"
                        },
                        "period": {
                          "enum": [
                            "monthly",
                            "yearly"
                          ],
                          "type": "string"
                        },
                        "plan": {
                          "enum": [
                            "plus",
                            "pro"
                          ],
                          "type": "string"
                        },
                        "rate_bps": {
                          "maximum": 10000,
                          "minimum": 0,
                          "type": "integer"
                        },
                        "revision": {
                          "type": "string"
                        },
                        "rule_id": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "rule_id",
                        "plan",
                        "period",
                        "rate_bps",
                        "enabled",
                        "revision"
                      ],
                      "type": "object"
                    },
                    "maxItems": 4,
                    "type": "array"
                  }
                },
                "required": [
                  "rules"
                ],
                "type": "object"
              },
              "meta": {
                "properties": {
                  "generated_at": {
                    "format": "date-time",
                    "type": "string"
                  },
                  "request_id": {
                    "type": "string"
                  }
                },
                "required": [
                  "request_id",
                  "generated_at"
                ],
                "type": "object"
              }
            },
            "required": [
              "data",
              "meta"
            ],
            "type": "object"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "421": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "updateReferralRules": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "properties": {
              "data": {
                "properties": {
                  "replayed": {
                    "type": "boolean"
                  },
                  "rules": {
                    "items": {
                      "properties": {
                        "revision": {
                          "type": "string"
                        },
                        "rule_id": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "rule_id",
                        "revision"
                      ],
                      "type": "object"
                    },
                    "type": "array"
                  }
                },
                "required": [
                  "rules",
                  "replayed"
                ],
                "type": "object"
              },
              "meta": {
                "properties": {
                  "generated_at": {
                    "format": "date-time",
                    "type": "string"
                  },
                  "request_id": {
                    "type": "string"
                  }
                },
                "required": [
                  "request_id",
                  "generated_at"
                ],
                "type": "object"
              }
            },
            "required": [
              "data",
              "meta"
            ],
            "type": "object"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "421": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "changes": {
              "description": "Unique rule IDs; duplicates are rejected.",
              "items": {
                "additionalProperties": false,
                "properties": {
                  "enabled": {
                    "type": "boolean"
                  },
                  "expected_revision": {
                    "description": "Unsigned BIGINT revision below 18446744073709551615.",
                    "pattern": "^[1-9][0-9]{0,19}$",
                    "type": "string"
                  },
                  "rate_bps": {
                    "maximum": 10000,
                    "minimum": 0,
                    "type": "integer"
                  },
                  "rule_id": {
                    "description": "Positive signed INT ID, at most 2147483647.",
                    "pattern": "^[1-9][0-9]{0,9}$",
                    "type": "string"
                  }
                },
                "required": [
                  "rule_id",
                  "expected_revision",
                  "rate_bps",
                  "enabled"
                ],
                "type": "object"
              },
              "maxItems": 4,
              "minItems": 1,
              "type": "array"
            }
          },
          "required": [
            "changes"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "readAdminSystemSetting": {
      "parameters": [
        {
          "name": "namespace",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 100,
            "minLength": 1,
            "type": "string"
          }
        },
        {
          "name": "key",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 100,
            "minLength": 1,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "properties": {
              "data": {
                "oneOf": [
                  {
                    "additionalProperties": false,
                    "properties": {
                      "key": {
                        "type": "string"
                      },
                      "namespace": {
                        "type": "string"
                      },
                      "protected": {
                        "const": true
                      },
                      "revision": {
                        "type": "string"
                      },
                      "sensitivity": {
                        "enum": [
                          "public",
                          "restricted",
                          "secret"
                        ],
                        "type": "string"
                      },
                      "setting_id": {
                        "type": "string"
                      },
                      "value_state": {
                        "enum": [
                          "null",
                          "empty",
                          "text"
                        ],
                        "type": "string"
                      },
                      "value_type": {
                        "enum": [
                          "string",
                          "boolean",
                          "integer",
                          "enum",
                          "json_array",
                          "credential"
                        ],
                        "type": "string"
                      }
                    },
                    "required": [
                      "setting_id",
                      "namespace",
                      "key",
                      "value_type",
                      "sensitivity",
                      "revision",
                      "value_state",
                      "protected"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "key": {
                        "type": "string"
                      },
                      "namespace": {
                        "type": "string"
                      },
                      "protected": {
                        "const": false
                      },
                      "revision": {
                        "type": "string"
                      },
                      "sensitivity": {
                        "enum": [
                          "public",
                          "restricted"
                        ],
                        "type": "string"
                      },
                      "setting_id": {
                        "type": "string"
                      },
                      "value": {
                        "type": [
                          "string",
                          "null"
                        ]
                      },
                      "value_state": {
                        "enum": [
                          "null",
                          "empty",
                          "text"
                        ],
                        "type": "string"
                      },
                      "value_type": {
                        "enum": [
                          "string",
                          "boolean",
                          "integer",
                          "enum",
                          "json_array"
                        ],
                        "type": "string"
                      }
                    },
                    "required": [
                      "setting_id",
                      "namespace",
                      "key",
                      "value_type",
                      "sensitivity",
                      "revision",
                      "value_state",
                      "protected",
                      "value"
                    ],
                    "type": "object"
                  }
                ]
              },
              "meta": {
                "properties": {
                  "generated_at": {
                    "format": "date-time",
                    "type": "string"
                  },
                  "request_id": {
                    "type": "string"
                  }
                },
                "required": [
                  "request_id",
                  "generated_at"
                ],
                "type": "object"
              }
            },
            "required": [
              "data",
              "meta"
            ],
            "type": "object"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "421": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "updateSystemSetting": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 36,
            "minLength": 36,
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "properties": {
              "data": {
                "properties": {
                  "replayed": {
                    "type": "boolean"
                  },
                  "revision": {
                    "type": "string"
                  },
                  "setting_id": {
                    "type": "string"
                  }
                },
                "required": [
                  "setting_id",
                  "revision",
                  "replayed"
                ],
                "type": "object"
              },
              "meta": {
                "properties": {
                  "generated_at": {
                    "format": "date-time",
                    "type": "string"
                  },
                  "request_id": {
                    "type": "string"
                  }
                },
                "required": [
                  "request_id",
                  "generated_at"
                ],
                "type": "object"
              }
            },
            "required": [
              "data",
              "meta"
            ],
            "type": "object"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "421": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "expected_revision": {
              "maxLength": 20,
              "pattern": "^[1-9][0-9]{0,19}$",
              "type": "string"
            },
            "key": {
              "maxLength": 100,
              "type": "string"
            },
            "namespace": {
              "maxLength": 100,
              "type": "string"
            },
            "value": {
              "description": "Original text; no implicit coercion, trimming or defaults.",
              "type": "string"
            },
            "value_type": {
              "enum": [
                "string",
                "boolean",
                "integer",
                "enum",
                "json_array"
              ],
              "type": "string"
            }
          },
          "required": [
            "namespace",
            "key",
            "value_type",
            "expected_revision",
            "value"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "listPlatformStrategies": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getPlatformStrategy": {
      "parameters": [
        {
          "name": "strategy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createPlatformStrategyVersion": {
      "parameters": [
        {
          "name": "strategy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/StrategyVersionCreate"
        },
        "required": true
      }
    },
    "publishPlatformStrategyVersion": {
      "parameters": [
        {
          "name": "strategy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "version_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createAnalysisJob": {
      "parameters": [
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "202": {
          "application/json": {
            "$ref": "#/components/schemas/AnalysisJobResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/AnalysisJobCreate"
        },
        "required": true
      }
    },
    "listAuditEvents": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "category",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/AuditCategory"
          }
        },
        {
          "name": "status",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/AuditStatus"
          }
        },
        {
          "name": "actor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/AuditActor"
          }
        },
        {
          "name": "from",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        {
          "name": "to",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        {
          "name": "q",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 80,
            "minLength": 1,
            "type": "string"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 2048,
            "type": [
              "string",
              "null"
            ]
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/AuditEventPageResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getAuditEvent": {
      "parameters": [
        {
          "name": "source_kind",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/AuditSourceKind"
          }
        },
        {
          "name": "source_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/AuditEventDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "loginAtIdentityCenter": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/AuthLoginResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/AuthLoginRequest"
        },
        "required": true
      }
    },
    "logoutAuthCenterSession": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "origin",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "format": "uri",
            "type": "string"
          }
        }
      ],
      "responses": {
        "204": {},
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getAuthCenterSession": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/AuthCenterSessionResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getBridgeConnectionCapacity": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ConnectionCapacityResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "revokeBridgeDeviceCredential": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeCredentialRevocationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgeSessionTokenRequest"
        },
        "required": true
      }
    },
    "startBridgeInstallationAuthorization": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeInstallationStartedResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "410": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgeInstallationStart"
        },
        "required": true
      }
    },
    "getBridgeInstallationAuthorization": {
      "parameters": [
        {
          "name": "authorization_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "format": "uuid",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeInstallationConfirmationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "410": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "decideBridgeInstallationAuthorization": {
      "parameters": [
        {
          "name": "authorization_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "format": "uuid",
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeInstallationConfirmationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "410": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgeInstallationDecision"
        },
        "required": true
      }
    },
    "pollBridgeInstallationAuthorization": {
      "parameters": [
        {
          "name": "authorization_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "format": "uuid",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeInstallationPolledResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "410": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgeInstallationPoll"
        },
        "required": true
      }
    },
    "registerBridgeInstallationProfile": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeInstallationProfileResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "410": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgeInstallationProfileRequest"
        },
        "required": true
      }
    },
    "revokeBridgeInstallation": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeInstallationRevokedResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "410": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgeInstallationProof"
        },
        "required": true
      }
    },
    "getBridgeInstallationStatus": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeInstallationStatusResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "410": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgeInstallationProof"
        },
        "required": true
      }
    },
    "exchangeLegacyBridgeCredential": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeRefreshCredentialResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/LegacyBridgeCredentialExchange"
        },
        "required": true
      }
    },
    "redeemBridgePairing": {
      "parameters": [],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/BridgePairingCredentialResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "410": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgePairingRedemption"
        },
        "required": true
      }
    },
    "createBridgePairingRequest": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/BridgePairingResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "410": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgePairingRequest"
        },
        "required": true
      }
    },
    "createBridgeSessionToken": {
      "parameters": [],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/BridgeSessionTokenResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/BridgeSessionTokenRequest"
        },
        "required": true
      }
    },
    "listTerminalProfiles": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TerminalProfileListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createExecutionDistribution": {
      "parameters": [
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "202": {
          "application/json": {
            "$ref": "#/components/schemas/OperationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ExecutionDistribution"
        },
        "required": true
      }
    },
    "previewExecutionDistribution": {
      "parameters": [
        {
          "name": "strategy_id",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "symbol",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Symbol"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ExecutionDistributionPreviewResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getExecutionDistribution": {
      "parameters": [
        {
          "name": "distribution_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ExecutionDistributionDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createDistributionCloseCommand": {
      "parameters": [
        {
          "name": "distribution_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "202": {
          "application/json": {
            "$ref": "#/components/schemas/OperationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/DistributionCloseCommand"
        },
        "required": true
      }
    },
    "listArchivedExecutions": {
      "parameters": [
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/listArchivedExecutionsResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getArchivedExecution": {
      "parameters": [
        {
          "name": "legacy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/getArchivedExecutionResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listArchivedExecutionDeals": {
      "parameters": [
        {
          "name": "legacy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ArchivedExecutionDealsResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listArchivedSignals": {
      "parameters": [
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/listArchivedSignalsResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getArchivedSignal": {
      "parameters": [
        {
          "name": "legacy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,18}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/getArchivedSignalResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listLearningCourses": {
      "parameters": [
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "pattern": "^-?[0-9]{1,10}:[1-9][0-9]{0,9}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/LearningListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "421": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "setLearningCompletion": {
      "parameters": [
        {
          "name": "courseId",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,9}$",
            "type": "string"
          }
        },
        {
          "name": "lessonId",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,9}$",
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 36,
            "minLength": 36,
            "not": {
              "pattern": "[^0-9a-f-]"
            },
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/LearningCompletionResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "421": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/LearningCompletionRequest"
        },
        "required": true
      }
    },
    "getLearningCourse": {
      "parameters": [
        {
          "name": "id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,9}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/LearningDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "421": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listManualReviewCandidates": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ManualReviewCandidateListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createManualReviewCase": {
      "parameters": [
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "202": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewCaseDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ManualReviewCaseInput"
        },
        "required": true
      }
    },
    "listMarketAnalyses": {
      "parameters": [
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 200,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 2048,
            "type": [
              "string",
              "null"
            ]
          }
        },
        {
          "name": "symbol",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Symbol"
          }
        },
        {
          "name": "strategy_id",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/MarketAnalysisListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getMarketAnalysis": {
      "parameters": [
        {
          "name": "analysis_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/MarketAnalysisDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createTraderEvaluation": {
      "parameters": [
        {
          "name": "analysis_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "202": {
          "application/json": {
            "$ref": "#/components/schemas/TraderRunResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/TraderEvaluationCreate"
        },
        "required": true
      }
    },
    "listEconomicCalendarEvents": {
      "parameters": [
        {
          "name": "from",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        {
          "name": "to",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        {
          "name": "importance",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "enum": [
              "low",
              "medium",
              "high",
              "unknown"
            ],
            "type": "string"
          }
        },
        {
          "name": "limit",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 20,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 2048,
            "type": [
              "string",
              "null"
            ]
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/EconomicCalendarEventListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getEconomicCalendarEvent": {
      "parameters": [
        {
          "name": "event_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/EconomicCalendarEventResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listMarketCandles": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "symbol",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Symbol"
          }
        },
        {
          "name": "timeframe",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Timeframe"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 200,
            "maximum": 500,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "observer_channel_id",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/CandleListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listMacroSeriesPoints": {
      "parameters": [
        {
          "name": "code",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          }
        },
        {
          "name": "from",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        {
          "name": "to",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/UtcDateTime"
          }
        },
        {
          "name": "limit",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 20,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 2048,
            "type": [
              "string",
              "null"
            ]
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/MacroSeriesResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listMacroSnapshots": {
      "parameters": [
        {
          "name": "limit",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 20,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 2048,
            "type": [
              "string",
              "null"
            ]
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/MacroSnapshotListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getLatestMacroSnapshot": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/MacroSnapshotResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getMacroSnapshot": {
      "parameters": [
        {
          "name": "snapshot_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/MacroSnapshotResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getMacroMarketOverview": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/MacroMarketOverviewResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getPublicMarketSnapshot": {
      "parameters": [
        {
          "name": "symbol",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Symbol"
          }
        },
        {
          "name": "timeframe",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Timeframe"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 200,
            "maximum": 500,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "before",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "format": "date-time",
            "pattern": "Z$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/PublicMarketSnapshotResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listPublicMarketSymbols": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/PublicMarketSymbolsResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getMarketQuote": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "symbol",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Symbol"
          }
        },
        {
          "name": "observer_channel_id",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/QuoteResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listTerminalMarketSymbols": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "pattern": "^[0-9]{1,5}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TerminalMarketSymbolsResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getTerminalMarketWindow": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "symbol",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Symbol"
          }
        },
        {
          "name": "timeframe",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Timeframe"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 200,
            "maximum": 500,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "before",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,15}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TerminalMarketWindowResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getModelAssignments": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ModelAssignmentsResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "setModelAssignments": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 64,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ModelAssignmentsResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "analysis": {
              "pattern": "^[1-9][0-9]*$",
              "type": [
                "string",
                "null"
              ]
            },
            "review": {
              "pattern": "^[1-9][0-9]*$",
              "type": [
                "string",
                "null"
              ]
            },
            "revision": {
              "pattern": "^[0-9]+$",
              "type": "string"
            },
            "trader": {
              "pattern": "^[1-9][0-9]*$",
              "type": [
                "string",
                "null"
              ]
            }
          },
          "required": [
            "analysis",
            "trader",
            "review",
            "revision"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "listModelConfigurations": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ModelConfigurationListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createModelConfiguration": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 64,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ModelConfigurationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "api_key": {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            "base_url": {
              "maxLength": 512,
              "minLength": 1,
              "type": "string"
            },
            "context_window_tokens": {
              "maximum": 2147483647,
              "minimum": 1,
              "type": [
                "integer",
                "null"
              ]
            },
            "max_input_tokens": {
              "maximum": 2147483647,
              "minimum": 1,
              "type": [
                "integer",
                "null"
              ]
            },
            "max_output_tokens": {
              "maximum": 2147483647,
              "minimum": 1,
              "type": [
                "integer",
                "null"
              ]
            },
            "name": {
              "maxLength": 191,
              "minLength": 1,
              "type": "string"
            },
            "protocol": {
              "enum": [
                "chat_completions",
                "responses"
              ],
              "type": "string"
            },
            "provider": {
              "enum": [
                "volcengine_agent_plan",
                "deepseek",
                "openai_compatible"
              ],
              "type": "string"
            },
            "reasoning_effort": {
              "enum": [
                null,
                "low",
                "medium",
                "high",
                "max"
              ],
              "type": [
                "string",
                "null"
              ]
            },
            "request_timeout_ms": {
              "maximum": 600000,
              "minimum": 1000,
              "type": [
                "integer",
                "null"
              ]
            },
            "scope": {
              "enum": [
                "user",
                "platform"
              ],
              "type": "string"
            },
            "temperature": {
              "maximum": 2,
              "minimum": 0,
              "type": [
                "number",
                "null"
              ]
            },
            "thinking_enabled": {
              "type": "boolean"
            }
          },
          "required": [
            "name",
            "base_url",
            "protocol",
            "provider",
            "scope",
            "api_key",
            "max_output_tokens"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "deleteModelConfiguration": {
      "parameters": [
        {
          "name": "id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,9}$",
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 64,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ModelDeletedResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "expected_revision": {
              "pattern": "^[a-f0-9]{64}$",
              "type": "string"
            }
          },
          "required": [
            "expected_revision"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "saveModelConfiguration": {
      "parameters": [
        {
          "name": "id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,9}$",
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 64,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ModelConfigurationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "api_key": {
              "maxLength": 8192,
              "minLength": 1,
              "type": "string"
            },
            "base_url": {
              "maxLength": 512,
              "minLength": 1,
              "type": "string"
            },
            "context_window_tokens": {
              "maximum": 2147483647,
              "minimum": 1,
              "type": [
                "integer",
                "null"
              ]
            },
            "expected_revision": {
              "pattern": "^[a-f0-9]{64}$",
              "type": "string"
            },
            "max_input_tokens": {
              "maximum": 2147483647,
              "minimum": 1,
              "type": [
                "integer",
                "null"
              ]
            },
            "max_output_tokens": {
              "maximum": 2147483647,
              "minimum": 1,
              "type": [
                "integer",
                "null"
              ]
            },
            "max_tokens": {
              "deprecated": true,
              "description": "Legacy compatibility only; requests use max_output_tokens from model capabilities.",
              "maximum": 1000000,
              "minimum": 1,
              "type": [
                "integer",
                "null"
              ]
            },
            "name": {
              "maxLength": 191,
              "minLength": 1,
              "type": "string"
            },
            "protocol": {
              "enum": [
                "chat_completions",
                "responses"
              ],
              "type": "string"
            },
            "reasoning_effort": {
              "enum": [
                null,
                "low",
                "medium",
                "high",
                "max"
              ],
              "type": [
                "string",
                "null"
              ]
            },
            "request_timeout_ms": {
              "maximum": 600000,
              "minimum": 1000,
              "type": [
                "integer",
                "null"
              ]
            },
            "temperature": {
              "maximum": 2,
              "minimum": 0,
              "type": [
                "number",
                "null"
              ]
            },
            "thinking_enabled": {
              "type": "boolean"
            }
          },
          "required": [
            "name",
            "base_url",
            "protocol",
            "expected_revision"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "verifyModelConfiguration": {
      "parameters": [
        {
          "name": "id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[1-9][0-9]{0,9}$",
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 64,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ModelConfigurationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "expected_revision": {
              "pattern": "^[a-f0-9]{64}$",
              "type": "string"
            }
          },
          "required": [
            "expected_revision"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "getModelSelection": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ModelSelectionResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "setModelSelection": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ModelSelectionResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "expected_model_profile_id": {
              "pattern": "^[1-9][0-9]{0,18}$",
              "type": [
                "string",
                "null"
              ]
            },
            "model_profile_id": {
              "pattern": "^[1-9][0-9]{0,18}$",
              "type": "string"
            }
          },
          "required": [
            "model_profile_id",
            "expected_model_profile_id"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "listObserverChannels": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ObserverChannelListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getOperation": {
      "parameters": [
        {
          "name": "operation_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/OperationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getPersonalNotifications": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "properties": {
              "data": {
                "additionalProperties": false,
                "properties": {
                  "items": {
                    "items": {
                      "additionalProperties": false,
                      "properties": {
                        "actionable": {
                          "type": "boolean"
                        },
                        "createdAt": {
                          "type": "string"
                        },
                        "id": {
                          "type": "string"
                        },
                        "kind": {
                          "enum": [
                            "analysis",
                            "decision"
                          ],
                          "type": "string"
                        },
                        "read": {
                          "type": "boolean"
                        },
                        "resourceId": {
                          "type": "string"
                        },
                        "summary": {
                          "type": "string"
                        },
                        "title": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "id",
                        "kind",
                        "resourceId",
                        "title",
                        "summary",
                        "actionable",
                        "createdAt",
                        "read"
                      ],
                      "type": "object"
                    },
                    "maxItems": 50,
                    "type": "array"
                  },
                  "unread": {
                    "minimum": 0,
                    "type": "integer"
                  }
                },
                "required": [
                  "unread",
                  "items"
                ],
                "type": "object"
              },
              "meta": {
                "type": "object"
              }
            },
            "required": [
              "data",
              "meta"
            ],
            "type": "object"
          }
        }
      }
    },
    "readPersonalNotification": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "properties": {
              "data": {
                "additionalProperties": false,
                "properties": {
                  "read": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "read"
                ],
                "type": "object"
              },
              "meta": {
                "type": "object"
              }
            },
            "required": [
              "data",
              "meta"
            ],
            "type": "object"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "oneOf": [
            {
              "not": {
                "required": [
                  "all"
                ]
              },
              "required": [
                "id"
              ]
            },
            {
              "not": {
                "required": [
                  "id"
                ]
              },
              "required": [
                "all"
              ]
            }
          ],
          "properties": {
            "all": {
              "enum": [
                true
              ],
              "type": "boolean"
            },
            "id": {
              "maxLength": 80,
              "minLength": 1,
              "type": "string"
            }
          },
          "type": "object"
        },
        "required": true
      }
    },
    "getPersonalSettings": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "properties": {
              "data": {
                "additionalProperties": false,
                "properties": {
                  "emailAvailable": {
                    "type": "boolean"
                  },
                  "hasFeishu": {
                    "type": "boolean"
                  },
                  "nickname": {
                    "type": "string"
                  },
                  "preferences": {
                    "additionalProperties": false,
                    "properties": {
                      "analysis": {
                        "enum": [
                          "off",
                          "effective",
                          "all"
                        ],
                        "type": "string"
                      },
                      "analysisSound": {
                        "enum": [
                          "off",
                          "bell",
                          "chime",
                          "pulse"
                        ],
                        "type": "string"
                      },
                      "decision": {
                        "enum": [
                          "off",
                          "effective",
                          "all"
                        ],
                        "type": "string"
                      },
                      "decisionSound": {
                        "enum": [
                          "off",
                          "bell",
                          "chime",
                          "pulse"
                        ],
                        "type": "string"
                      },
                      "emailEnabled": {
                        "type": "boolean"
                      },
                      "feishuEnabled": {
                        "type": "boolean"
                      }
                    },
                    "required": [
                      "analysis",
                      "decision",
                      "analysisSound",
                      "decisionSound",
                      "feishuEnabled",
                      "emailEnabled"
                    ],
                    "type": "object"
                  },
                  "revision": {
                    "minimum": 0,
                    "type": "integer"
                  }
                },
                "required": [
                  "nickname",
                  "preferences",
                  "hasFeishu",
                  "emailAvailable",
                  "revision"
                ],
                "type": "object"
              },
              "meta": {
                "type": "object"
              }
            },
            "required": [
              "data",
              "meta"
            ],
            "type": "object"
          }
        }
      }
    },
    "savePersonalSettings": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "properties": {
              "data": {
                "additionalProperties": false,
                "properties": {
                  "revision": {
                    "minimum": 0,
                    "type": "integer"
                  }
                },
                "required": [
                  "revision"
                ],
                "type": "object"
              },
              "meta": {
                "type": "object"
              }
            },
            "required": [
              "data",
              "meta"
            ],
            "type": "object"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "feishuSecret": {
              "maxLength": 256,
              "type": "string"
            },
            "feishuWebhook": {
              "maxLength": 512,
              "type": "string"
            },
            "nickname": {
              "maxLength": 80,
              "type": "string"
            },
            "preferences": {
              "additionalProperties": false,
              "properties": {
                "analysis": {
                  "enum": [
                    "off",
                    "effective",
                    "all"
                  ],
                  "type": "string"
                },
                "analysisSound": {
                  "enum": [
                    "off",
                    "bell",
                    "chime",
                    "pulse"
                  ],
                  "type": "string"
                },
                "decision": {
                  "enum": [
                    "off",
                    "effective",
                    "all"
                  ],
                  "type": "string"
                },
                "decisionSound": {
                  "enum": [
                    "off",
                    "bell",
                    "chime",
                    "pulse"
                  ],
                  "type": "string"
                },
                "emailEnabled": {
                  "type": "boolean"
                },
                "feishuEnabled": {
                  "type": "boolean"
                }
              },
              "required": [
                "analysis",
                "decision",
                "analysisSound",
                "decisionSound",
                "feishuEnabled",
                "emailEnabled"
              ],
              "type": "object"
            },
            "revision": {
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "nickname",
            "preferences",
            "revision"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "listPositions": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 200,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 2048,
            "type": [
              "string",
              "null"
            ]
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/PositionListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createRealtimeTicket": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/RealtimeTicketResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "429": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listReviewCases": {
      "parameters": [
        {
          "name": "kind",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "enum": [
              "daily",
              "monthly",
              "manual",
              "trade"
            ],
            "type": "string"
          }
        },
        {
          "name": "account_id",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewCaseListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getReviewCase": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewCaseDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "confirmReviewVersion": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewCaseDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "version_id": {
              "$ref": "#/components/schemas/OpaqueId"
            }
          },
          "required": [
            "version_id"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "requestReviewGeneration": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "202": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewCaseDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "mode": {
              "enum": [
                "retry",
                "refresh_evidence"
              ],
              "type": "string"
            }
          },
          "required": [
            "mode"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "getReviewHistoricalMetadata": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewHistoricalMetadataResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listArchivedReviewEvents": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "offset",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 10000,
            "minimum": 0,
            "type": "integer"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ArchivedReviewEventPageResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listArchivedReviewJobs": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "offset",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 10000,
            "minimum": 0,
            "type": "integer"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ArchivedReviewJobPageResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listArchivedReviewStages": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "offset",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 10000,
            "minimum": 0,
            "type": "integer"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ArchivedReviewStagePageResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "returnReviewCase": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewCaseDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "reason": {
              "maxLength": 1000,
              "minLength": 3,
              "type": "string"
            }
          },
          "required": [
            "reason"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "listReviewVersions": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 100,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "before_version",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "maximum": 4294967295,
            "minimum": 1,
            "type": "integer"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewVersionHistoryResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createReviewVersion": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewCaseDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "content": {
              "$ref": "#/components/schemas/ReviewContent"
            }
          },
          "required": [
            "content"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "getReviewVersion": {
      "parameters": [
        {
          "name": "review_case_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "version_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ReviewVersionResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getManualRiskRelease": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ManualRiskReleaseResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createManualRiskRelease": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/ManualRiskReleaseCreatedResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ManualRiskReleaseInput"
        },
        "required": true
      }
    },
    "getManualRiskReleaseReceipt": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "idempotency_key",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "pattern": "^[A-Za-z0-9._:-]{8,128}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ManualRiskReleaseReceiptResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getRiskPolicy": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/RiskPolicyResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "replaceRiskPolicy": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/RiskPolicyResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/RiskPolicyInput"
        },
        "required": true
      }
    },
    "getRiskPolicyReceipt": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "idempotency_key",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "minLength": 16,
            "pattern": "^[A-Za-z0-9._:-]{16,128}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/RiskPolicyReceiptResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getAccountRiskSummary": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/AccountRiskSummaryResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listRiskDecisions": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 200,
            "minimum": 1,
            "type": "integer"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/RiskDecisionListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getRiskDecision": {
      "parameters": [
        {
          "name": "risk_decision_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/RiskDecisionDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getApplicationSession": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/SessionResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "logoutCurrentApplication": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "204": {},
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "logoutAllWebApplications": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "204": {},
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "revokeAllSessionsAndDevices": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "204": {},
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listStrategies": {
      "parameters": [
        {
          "name": "kind",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "enum": [
              "analysis",
              "trader"
            ],
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createStrategy": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/StrategyCreate"
        },
        "required": true
      }
    },
    "compileStrategy": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyCompileResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/StrategyCompile"
        },
        "required": true
      }
    },
    "getStrategy": {
      "parameters": [
        {
          "name": "strategy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "updateStrategyMetadata": {
      "parameters": [
        {
          "name": "strategy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/StrategyMetadataPatch"
        },
        "required": true
      }
    },
    "retireStrategy": {
      "parameters": [
        {
          "name": "strategy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createStrategyVersion": {
      "parameters": [
        {
          "name": "strategy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/StrategyVersionCreate"
        },
        "required": true
      }
    },
    "publishStrategyVersion": {
      "parameters": [
        {
          "name": "strategy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "version_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createStrategyCombination": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/StrategyCombinationCreate"
        },
        "required": true
      }
    },
    "createStrategyCombinationVersion": {
      "parameters": [
        {
          "name": "analysis_strategy_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/StrategyCombinationVersionCreate"
        },
        "required": true
      }
    },
    "listStrategyMemories": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyMemoryListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getStrategyMemory": {
      "parameters": [
        {
          "name": "memory_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyMemoryDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listStrategyMemoryUpdates": {
      "parameters": [
        {
          "name": "memory_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyMemoryUpdateListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "decideStrategyMemoryUpdate": {
      "parameters": [
        {
          "name": "update_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategyMemoryUpdateResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "decision": {
              "enum": [
                "accept",
                "reject",
                "revoke"
              ],
              "type": "string"
            }
          },
          "required": [
            "decision"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "listStrategySubscriptions": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategySubscriptionListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createStrategySubscription": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "201": {
          "application/json": {
            "$ref": "#/components/schemas/StrategySubscriptionResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/StrategySubscriptionCreate"
        },
        "required": true
      }
    },
    "setAccountTrader": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "properties": {
              "data": {
                "additionalProperties": false,
                "properties": {
                  "enabled": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "enabled"
                ],
                "type": "object"
              },
              "meta": {
                "$ref": "#/components/schemas/Meta"
              }
            },
            "required": [
              "data",
              "meta"
            ],
            "type": "object"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "account_id": {
              "$ref": "#/components/schemas/OpaqueId"
            },
            "enabled": {
              "type": "boolean"
            },
            "expected": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/OpaqueId"
                  },
                  "revision": {
                    "maximum": 9007199254740990,
                    "minimum": 1,
                    "type": "integer"
                  }
                },
                "required": [
                  "id",
                  "revision"
                ],
                "type": "object"
              },
              "maxItems": 200,
              "type": "array"
            }
          },
          "required": [
            "account_id",
            "enabled",
            "expected"
          ],
          "type": "object"
        },
        "required": true
      }
    },
    "updateStrategySubscription": {
      "parameters": [
        {
          "name": "subscription_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "if-match",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 3,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/StrategySubscriptionResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "412": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/StrategySubscriptionPatch"
        },
        "required": true
      }
    },
    "listTradeDecisions": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 200,
            "minimum": 1,
            "type": "integer"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradeDecisionListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getTradeDecision": {
      "parameters": [
        {
          "name": "decision_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradeDecisionDetailResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listTradeHistory": {
      "parameters": [
        {
          "name": "account_id",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "symbol",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Symbol"
          }
        },
        {
          "name": "side",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "enum": [
              "buy",
              "sell"
            ],
            "type": "string"
          }
        },
        {
          "name": "source",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "enum": [
              "system",
              "manual",
              "other_ea",
              "mixed",
              "unknown"
            ],
            "type": "string"
          }
        },
        {
          "name": "outcome",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "enum": [
              "profit",
              "loss",
              "breakeven"
            ],
            "type": "string"
          }
        },
        {
          "name": "from_date",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/BusinessDate"
          }
        },
        {
          "name": "to_date",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/BusinessDate"
          }
        },
        {
          "name": "q",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          }
        },
        {
          "name": "page_size",
          "location": "query",
          "required": false,
          "integerQuery": true,
          "schema": {
            "default": 50,
            "maximum": 200,
            "minimum": 1,
            "type": "integer"
          }
        },
        {
          "name": "cursor",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 2048,
            "type": [
              "string",
              "null"
            ]
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradeHistoryPageResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getTradeRecord": {
      "parameters": [
        {
          "name": "trade_record_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradeRecordDetailResponse"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "listTradingAccounts": {
      "parameters": [
        {
          "name": "access",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "default": "current",
            "enum": [
              "current",
              "history"
            ],
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradingAccountListResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "createExecutionCommand": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 128,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        }
      ],
      "responses": {
        "202": {
          "application/json": {
            "$ref": "#/components/schemas/OperationResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "422": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "428": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/ExecutionCommand"
        },
        "required": true
      }
    },
    "getExecutionCommandContext": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "symbol",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/Symbol"
          }
        },
        {
          "name": "ticket",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/ExecutionCommandContextResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getTradingAccountSnapshot": {
      "parameters": [
        {
          "name": "account_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        },
        {
          "name": "observer_channel_id",
          "location": "query",
          "required": false,
          "integerQuery": false,
          "schema": {
            "$ref": "#/components/schemas/OpaqueId"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradingWorkspaceResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "getTradingContext": {
      "parameters": [],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradingContextResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "replaceTradingContext": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 36,
            "minLength": 36,
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradingContextResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      },
      "body": {
        "schema": {
          "$ref": "#/components/schemas/TradingContextInput"
        },
        "required": true
      }
    },
    "getTradingContextReceipt": {
      "parameters": [
        {
          "name": "request_id",
          "location": "path",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 36,
            "minLength": 36,
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradingContextReceiptResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    },
    "leaveObserverMode": {
      "parameters": [
        {
          "name": "x-csrf-token",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 256,
            "minLength": 16,
            "type": "string"
          }
        },
        {
          "name": "expected_revision",
          "location": "query",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 16,
            "pattern": "^(0|[1-9][0-9]*)$",
            "type": "string"
          }
        },
        {
          "name": "idempotency-key",
          "location": "header",
          "required": true,
          "integerQuery": false,
          "schema": {
            "maxLength": 36,
            "minLength": 36,
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "application/json": {
            "$ref": "#/components/schemas/TradingContextResponse"
          }
        },
        "400": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "401": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "403": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "404": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "409": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        },
        "503": {
          "application/problem+json": {
            "$ref": "#/components/schemas/Problem"
          }
        }
      }
    }
  }
}
