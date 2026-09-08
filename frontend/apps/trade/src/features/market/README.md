# Market feature

职责：trade 应用中的平台宏观概览、研究详情与经济日历展示。公开入口 index.ts；API 使用 @aurum/api-client 的 market 能力，传输校验与字段转换归 contracts，组件与交互状态归本 feature。共享 UI 不持有业务状态。

目前完成 createMarketWorkspace，按视图创建实例，概览与详情分别取消请求及维护代次，迟到响应不能覆盖新选择；reset 清除会话数据，dispose 清理并拒绝继续读取。加载或失败不将上次数据显示为当前事实，合法空概览保持 ready。原始服务错误不作为用户文案。

页面接线时必须监听身份改变调用 reset，卸载调用 dispose，详情关闭调用 closeDetail。平台数据不依赖当前交易账户；不得把账户切换当成所有权授权。/market 已接入 MarketView，监听身份改变调用 reset，卸载调用 dispose，详情关闭调用 closeDetail。概览、事件和详情分别组装，自动订阅、响应式、键盘、浏览器与来源日历验证待完成。

界面方向：沿用当前设计系统，先研究状态/摘要，再关键因子和未来事件；空、失败、加载分别展示，键盘与触摸刷新入口保持稳定。宏观页面时间显示北京时间，不能使用实验室终端时区。参考项目前端规范、ui-ux-pro-max 的层级/响应式/可访问性规则及既有 shadcn-vue 组件。

测试：__tests__/market-workspace.test.ts 验证失败恢复、取消、迟到响应、会话重置、卸载与详情作用域；这不是页面验收。
