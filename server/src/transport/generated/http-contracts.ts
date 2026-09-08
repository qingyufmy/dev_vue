// Generated from contracts/http. Do not edit.
import type { HttpRuntimeContracts } from '../http-contract.js'

export const httpRuntimeContracts: HttpRuntimeContracts = {
  "components": {
    "schemas": {
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
      "OpaqueId": {
        "maxLength": 191,
        "minLength": 1,
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
    }
  }
}
