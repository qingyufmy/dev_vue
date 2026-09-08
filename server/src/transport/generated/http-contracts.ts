// Generated from contracts/http. Do not edit.
import type { HttpRuntimeContracts } from '../http-contract.js'

export const httpRuntimeContracts: HttpRuntimeContracts = {
  "components": {
    "schemas": {
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
          "detail": {
            "maxLength": 2000,
            "minLength": 1,
            "type": "string"
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
                "minimum": 1,
                "type": "integer"
              },
              "purchased": {
                "minimum": 0,
                "type": "integer"
              },
              "total": {
                "minimum": 1,
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
      "OpaqueId": {
        "maxLength": 191,
        "minLength": 1,
        "type": "string"
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
      "Revision": {
        "maxLength": 128,
        "minLength": 1,
        "type": "string"
      },
      "Symbol": {
        "maxLength": 64,
        "minLength": 1,
        "pattern": "^[A-Za-z0-9._-]+$",
        "type": "string"
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
      }
    }
  },
  "operations": {
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
