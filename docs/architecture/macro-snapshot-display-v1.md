# 宏观快照 V1 展示投影

2026-09-09。实现：server/src/modules/market/domain/macro-snapshot.ts。该文档定义此前缺失的存储展示投影，不修改已有 HTTP DTO，也不改变 inference 的 analysis_evidence 读取。

## 存储与哈希

schema_version=1 的 payload_json 可同时包含 display、analysis_evidence 及内部发布信息。浏览器只从 display 读取 direction、summary、factors；不能回退到 analysis_evidence 或任意根字段。现有仅含推理证据的记录不能自动视为可展示，需要正式发布流程产生合法 display，禁止读取时补造摘要。

content_sha256 使用既有 V4 canonical JSON 编码，对完整 payload_json 计算 SHA-256；不是 RFC 8785，也不是对 HTTP 响应计算。数据库元数据和随当前时间变化的 stale 状态不包含在该 payload 哈希内。HTTP 后续 ETag 应针对最终响应内容，不能只使用存储哈希；前端不得用此字段校验裁剪后的 DTO。复用 shared/canonical-json，行为测试与现有 inference contentHash 比对兼容。

display.factors 只输出 code、label、value、unit、observation_at、available_at、freshness、gold_relation。所有其它字段丢弃，不透传原始供应商正文、许可、内部分析或模型材料。value 必须十进制文本或 null，revision 为规范非负十进制文本，保留大整数。摘要按合同最多5000字符、因子最多128项，code 不得重复。

## 时间与语义

元数据由数据库列提供，不让 payload 覆盖 id、revision、发布和有效期。cutoff <= published < valid_until，published 不得晚于读取时间；因子 observation/available 均不得晚于 cutoff。历史到期快照投影为 stale，原 unavailable 保留，存储数据不重写。详情/历史列表可展示到期状态，latest 的筛选规则由读取用例明确。

当前没有冻结验收的综合方向算法，display.direction 只接受 uncertain；不接受 supportive/adverse/neutral 后再悄悄改值。将来启用综合方向必须先增加可验证的规则版本及发布证据。单因子 gold_relation 保持现有合同枚举。

## 待完成的读取边界

此投影不代替数据库授权。后续 reader 必须先过滤平台所有权、兼容 schema、发布状态，并通过 macro_snapshot_observations 关联观测、序列和来源，验证展示及派生展示权限、许可当前有效性与因子映射覆盖。缺少来源映射不能解释为无限制展示；校验失败返回明确错误或不符合资格的结果，不能返回未授权 payload。

四项投影测试已通过；实际 SQL、列表/详情/latest/overview HTTP、生产者写入及来源日历仍待实现/验证。当前正式宏观表无业务记录的证据来自此前预检，本次未连接数据库。
