# 前端精确边界债务与声明刷新

2026-09-08在60fe3476后刷新Nuxt声明，扫描331个源文件、1561条依赖；配置错误0，当前可识别的隐式app依赖0。共11条存量记录，见frontend-boundary-debt.json。隐式边为0不表示全部隐式用法已覆盖。

## 复核与消除顺序

2条feature内部引用为trade的App.vue及trader/use-trader-workspace.ts读取home/home-runtime。该文件仍转导出共享交易状态，P1按账户/行情投影所有权迁移；不能仅从home/index公开可写状态后算封装完成。

9个UI循环分量为alert/avatar/badge/button/empty/field/select/sidebar/tabs：组件从本目录index导入variants或类型，index又导出组件。登记P0消除，应将不依赖组件的定义放到独立文件，保持公共组件入口及渲染行为。暂存这些循环不代表允许后续组件延续此结构。

每条记录包含source/target/rule、导入种类、类型属性及完整循环内部边，附模块、阶段和处理理由。新增内部引用、类型改运行、循环内部扩张及陈旧例外均拒绝；跨应用与共享包反向依赖不能加入例外。

## 自动入口与证据

verify:frontend-boundary-delta通过当前安装的Nuxt CLI执行prepare，成功后才读取配置及自动导入声明并扫描。prepare失败、扫描失败、配置错误均失败关闭，不接受旧报告代替实时扫描。不依赖shell命令转义或特定pnpm全局路径。

现有verify:frontend-boundaries先保留原UI库、fetch/WebSocket等检查，再执行新增量门；根前端测试和构建复用此入口，typecheck:frontend也已接入。

20项边界/依赖/Nuxt解析测试通过。实际在trade/risk中增加对home内部文件的临时导入，CLI在prepare后拒绝；探针删除后全部前端9个工作区类型检查通过。共享比较器修改后服务端147条基线保持通过。

仍需补齐Nuxt server自动导入、动态组件表达式、所有别名与导出形式，以及真正消除11条债务。本门禁只冻结当前已检测规则，不证明全前端模块化完成；没有修改UI渲染、启动服务或连接数据库。
