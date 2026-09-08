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
      "response": {
        "$ref": "#/components/schemas/AuditEventPageResponse"
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
      "response": {
        "$ref": "#/components/schemas/AuditEventDetailResponse"
      }
    }
  }
}
