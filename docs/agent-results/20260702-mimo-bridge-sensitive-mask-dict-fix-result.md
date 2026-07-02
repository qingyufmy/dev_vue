# 执行结果：补齐桥接客户端日志脱敏规则，修复 dict headers 中 Cookie 泄露

## 执行时间
2026-07-02

## 修改文件
- `public/ai/aurum_bridge_gui.py` — _mask_sensitive_text 支持 dict/Mapping + 补充正则

## 修改内容

### 1. 新增 `_is_sensitive_key()` 辅助方法
判断 key 是否敏感：`authorization`/`cookie`/`set-cookie` 或包含 `token`

### 2. `_mask_sensitive_text()` 支持 dict/Mapping
- 先判断 `isinstance(value, Mapping)`
- 遍历 dict，敏感 key 的值直接替换为 `[已脱敏]`
- 非敏感 key 的 value 递归脱敏

### 3. 补充 dict 字符串形式正则
覆盖 `'Authorization': 'Bearer abc'` / `"Cookie": "sid=123"` 等带引号的 dict 文本

### 4. 保持原有文本正则
Authorization/Bearer/Cookie/token 等普通文本形式继续覆盖

## 验证
```
python -m py_compile public/ai/aurum_bridge_gui.py  ✅
rg -n "WsBridgeThread" public/ai/aurum_bridge_gui.py  ✅ (空)
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
